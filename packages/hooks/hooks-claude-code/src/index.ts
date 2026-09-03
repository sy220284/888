/**
 * Bridge for unmodified Claude Code command hooks on harness interception
 * extension points. It supports SessionStart, prompt/tool pre/post, Stop, and subagent
 * start/stop. It owns Claude payloads, environment, substitution, and decision
 * mapping; shared execution and parsing live in `dsh-hook-protocol`.
 * `updatedInput` is honored only through the agent's pre-persistence tool-call
 * rewrite seam, then re-enters the ordinary Harness validation and permission path. Bespoke behavior should
 * use typed native plugins on the same extension points; see the
 * [hook-bridges Agent Note](../../../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.md).
 * @module @deepseek-ai/dsh-hooks-claude-code
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  appendHookInvoked,
  appendHookResult,
  createDetachedRuns,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  matchesMatcher,
  mergeHookOutputs,
  runHook,
  type HookOutput,
  type MatcherGroup,
  type MergedHookOutcome,
} from '@deepseek-ai/dsh-hook-protocol'
// Pulls in the declaration-merged subagent events and the identity pairing their
// start/end edges.
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { parseClaudeCodeConfig, type ClaudeCodeHookConfig, type SubstitutionVars } from './config.ts'

export const name = 'hooks-claude-code'
// `bash` is required to run hooks; the rest are read opportunistically via
// ctx.get so a deployment can load this bridge without every extension point present.
export const inject = ['shell']

/** Plugin config: explicit compatibility source + optional per-session project discovery. */
export interface Config {
  /**
   * Optional explicit `hooks.json` or settings file whose `hooks` key holds the config.
   * This source is parsed once at plugin load for backward compatibility.
   */
  configPath?: string
  /**
   * Opt in to Claude project settings discovery from each session cwd:
   * `.claude/settings.json` then `.claude/settings.local.json`.
   * Project files are re-read for every hook point so edits take effect without
   * restarting the process. Disabled by default because repository hook commands
   * are executable code and Harness has no Claude workspace-trust prompt seam yet.
   */
  discoverProjectHooks?: boolean
  /**
   * Replaces `${CLAUDE_PLUGIN_ROOT}` in command strings.
   */
  pluginRoot?: string
  /**
   * Replaces `${CLAUDE_PROJECT_DIR}` in command strings AND is exported as the
   * `CLAUDE_PROJECT_DIR` env var for hook processes. When omitted, the env var
   * defaults per-run to the agent's session workspace (`session.header.cwd`, the
   * same dir the hook runs in) — Claude Code always exports this var, and common
   * unmodified hooks reference `$CLAUDE_PROJECT_DIR` for project-relative paths.
   */
  projectDir?: string
  /** Default per-hook timeout in ms when a hook sets none (CC default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
  /** Maximum consecutive Stop-hook forced continuations in one turn. */
  maxStopContinuations?: number
}

export const Config: z<Config> = z.object({
  configPath: z.string(),
  discoverProjectHooks: z.boolean().default(false),
  pluginRoot: z.string(),
  projectDir: z.string(),
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
  maxStopContinuations: z.number().default(8),
})

/** A stable per-handler id so an invoked/result pair correlates in the log. */
let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `claude-code:${point}:${++handlerCounter}`
}

/** The `{kind:'plugin'}` source stamped on every context this bridge injects. */
const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'hooks-claude-code' }

/** The summary cap bounds a persisted event field — a positive integer or the slice misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`hooks-claude-code: ${name} must be a positive integer`)
  }
}

export function apply(ctx: Context, config: Config): void {
  // Validate before config parsing so a bad value cannot be hidden by its early return.
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  assertPositiveInteger('stderrSummaryMaxChars', stderrSummaryMaxChars)
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const maxStopContinuations = config.maxStopContinuations ?? 8
  assertPositiveInteger('maxStopContinuations', maxStopContinuations)
  const discoverProjectHooks = config.discoverProjectHooks ?? false
  const explicitConfigPath = config.configPath === undefined ? undefined : resolve(config.configPath)
  const warned = new Set<string>()

  function warnOnce(key: string, message: string): void {
    if (warned.has(key)) return
    warned.add(key)
    ctx.logger.warn(message)
  }

  function loadConfigSource(path: string, vars: SubstitutionVars, optional: boolean): ClaudeCodeHookConfig {
    if (optional && !existsSync(path)) return {}
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      const result = parseClaudeCodeConfig(raw, vars)
      for (const skipped of result.skipped) {
        warnOnce(
          `skipped:${path}:${skipped.event}:${skipped.type}`,
          `hooks-claude-code: skipping unsupported "${skipped.type}" hook on ${skipped.event} from "${path}" (only command hooks run)`,
        )
      }
      return result.config
    } catch (error: unknown) {
      warnOnce(
        `load:${path}:${String(error)}`,
        `hooks-claude-code: could not load hook config "${path}": ${String(error)} — source ignored`,
      )
      return {}
    }
  }

  const staticParsed: ClaudeCodeHookConfig = explicitConfigPath === undefined
    ? {}
    : loadConfigSource(explicitConfigPath, {
      ...config.pluginRoot !== undefined ? { pluginRoot: config.pluginRoot } : {},
      ...config.projectDir !== undefined ? { projectDir: config.projectDir } : {},
    }, false)

  function groupsFor(point: string, workdir: string | undefined): MatcherGroup[] {
    const groups: MatcherGroup[] = [...staticParsed[point] ?? []]
    if (!discoverProjectHooks || workdir === undefined) return groups

    const projectDir = config.projectDir ?? workdir
    const vars: SubstitutionVars = {
      ...config.pluginRoot !== undefined ? { pluginRoot: config.pluginRoot } : {},
      projectDir,
    }
    for (const path of [
      join(workdir, '.claude', 'settings.json'),
      join(workdir, '.claude', 'settings.local.json'),
    ]) {
      // Avoid double execution when an existing explicit source points at the
      // same project settings file that discovery would otherwise re-read.
      if (explicitConfigPath !== undefined && resolve(path) === explicitConfigPath) continue
      const parsed = loadConfigSource(path, vars, true)
      groups.push(...parsed[point] ?? [])
    }
    return groups
  }

  // Emit-shaped points run detached, so track their chains; disposal aborts
  // active hooks and drains continuations before resolving.
  const detached = createDetachedRuns()
  // Only the start edge guarantees registry access. Retain each local child
  // through its paired end so stop hooks keep the session workspace after the
  // handle unregisters the agent. Every retained entry relies on that paired
  // end; a producer that can omit it must provide another release edge.
  const subagentChildren = new Map<SubagentRunId, Agent>()
  // Capture the compatibility type at the same start edge. A local child may
  // leave the registry before SubagentStop; the paired end must still match the
  // same type and payload that SubagentStart exposed.
  const subagentTypes = new Map<SubagentRunId, string>()
  const sessionStartGates = new WeakMap<Agent, Promise<UserMessage | undefined>>()
  const sessionStartConsumed = new WeakSet<Agent>()
  const sessionStartWaiting = new WeakSet<Agent>()
  const deferredStops = new WeakMap<Agent, string>()
  const stopContinuations = new WeakMap<Agent, { turn: number; count: number }>()
  // Model-direct PreToolUse runs before assistant/message persistence so updatedInput
  // can become the canonical call. Cache its merged gate for tools/pre-execute;
  // nested/non-model calls have no such edge and continue through the legacy gate.
  const preToolOutcomes = new WeakMap<Agent, Map<string, MergedHookOutcome>>()
  ctx.effect(() => () => detached.drain(), 'hooks-claude-code: drain detached hook runs')

  /**
   * Run every command hook configured for `point` whose matcher selects
   * `matchQuery`, with the per-event `payload` on stdin, and fold the results.
   * Writes a `hook/invoked`/`hook/result` pair per hook when `opts.turn` names
   * an open turn. Detached lifecycle points omit the pair. Returns the merged outcome (a neutral,
   * already-most-restrictive view) for the caller to map onto its extension point
   * decision. `matchQuery` is the event's matcher subject (tool name, session
   * source, …); `''` for events that ignore matchers.
   */
  async function runPoint(
    point: string,
    matchQuery: string,
    payload: unknown,
    opts: { agent?: Agent; turn?: number; readonly signal: AbortSignal },
  ): Promise<MergedHookOutcome> {
    let currentPayload = payload
    // Run the hook in the agent's session workspace (the `session/new` cwd on the session
    // header), not the executor or entry-point process's launch dir.
    const workdir = opts.agent?.session.header.cwd
    const groups = groupsFor(point, workdir)
    const outputs: HookOutput[] = []
    // CLAUDE_PROJECT_DIR: an explicit config value wins; otherwise default it to the session
    // workspace (the same dir the hook runs in).
    const projectDir = config.projectDir ?? workdir
    const hookEnv = projectDir !== undefined ? { CLAUDE_PROJECT_DIR: projectDir } : undefined
    for (const group of groups) {
      if (!matchesMatcher(group.matcher, matchQuery, 'claude-code')) continue
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn, point, dialect: 'claude-code', handlerId,
            ...group.matcher !== undefined ? { matcher: group.matcher } : {},
          })
        }
        const { output, durationMs } = await runHook(ctx.shell, hook, {
          payload: currentPayload,
          defaultTimeoutMs,
          ...hookEnv ? { env: hookEnv } : {},
          ...workdir !== undefined ? { cwd: workdir } : {},
          signal: opts.signal,
          trailingNewline: true,
          // Discard a `hookSpecificOutput` block whose `hookEventName` names a
          // different event than the one firing (the schemas key it by event).
          expectedEventName: point,
        }, () => performance.now())
        outputs.push(output)
        if (output.updatedInput !== undefined) {
          if (point === 'PreToolUse' && typeof currentPayload === 'object' && currentPayload !== null && !Array.isArray(currentPayload)) {
            currentPayload = { ...(currentPayload as Record<string, unknown>), tool_input: output.updatedInput }
          } else {
            ctx.logger.warn(`hooks-claude-code: ${point} hook requested updatedInput outside the safe PreToolUse rewrite seam (ignored)`)
          }
        }
        if (output.systemMessage !== undefined) {
          ctx.logger.warn(`hooks-claude-code: ${point} hook emitted a systemMessage, which is not yet surfaced (ignored)`)
        }
        if (session && opts.turn !== undefined) {
          appendHookResult(session, { turn: opts.turn, point, handlerId, output, stderrSummaryMaxChars, durationMs })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  /** Record a hook-requested halt for the next safe agent boundary. */
  function deferStop(agent: Agent | undefined, merged: MergedHookOutcome, point: string): boolean {
    if (!merged.stop || agent === undefined) return false
    deferredStops.set(agent, merged.stopReason ?? `stopped by ${point} hook`)
    return true
  }

  /** Build additional model context from hook output, or return undefined when empty. */
  function contextFrom(merged: MergedHookOutcome): UserMessage | undefined {
    if (merged.additionalContext.length === 0) return undefined
    const content: ContentBlock[] = merged.additionalContext.map(text => ({ type: 'text', text }))
    return createUserMessage({ content, source: PLUGIN_SOURCE })
  }

  /** Prepend one context without flattening source fields or other downstream metadata. */
  function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
    return [ours, ...theirs ?? []]
  }

  // SessionStart remains an emit-shaped lifecycle event, but its bridge run is
  // published as a per-agent gate. Context is buffered until the first pre-step
  // instead of calling agent.inject(), which would create a second next-step
  // occurrence after the user prompt has already been claimed.
  ctx.on('agent/session-start', ({ agent, source }) => {
    sessionStartConsumed.delete(agent)
    const gate = runPoint('SessionStart', source, sessionStartPayload(ctx, agent, source), { agent, signal: detached.signal })
      .then((merged) => {
        deferStop(agent, merged, 'SessionStart')
        const context = contextFrom(merged)
        // Preserve the historical idle-session behavior: when no first pre-step
        // is already waiting, publish startup context through the ordinary inbox.
        // An immediate user prompt marks itself as waiting before awaiting this
        // gate, so that path receives the same context in its first request and
        // never creates a second next-step occurrence.
        if (context !== undefined && !sessionStartWaiting.has(agent)) {
          agent.inject(context)
          return undefined
        }
        return context
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`hooks-claude-code: SessionStart hook failed: ${String(error)}`)
        return undefined
      })
    sessionStartGates.set(agent, gate)
    detached.track(gate)
  })

  // --- UserPromptSubmit → PreStepDecision. The prompt text is the payload; no
  // matcher subject (CC ignores matchers for this event). ---
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    let startupContext: UserMessage | undefined
    if (!sessionStartConsumed.has(agent)) {
      sessionStartWaiting.add(agent)
      try {
        startupContext = await sessionStartGates.get(agent)
      } finally {
        sessionStartWaiting.delete(agent)
        sessionStartConsumed.add(agent)
      }
    }
    signal.throwIfAborted()
    if (deferredStops.delete(agent)) return { kind: 'reject' }
    if (messages.length === 0) {
      const downstream = await next()
      if (!startupContext || downstream.kind !== 'enter') return downstream
      return { kind: 'enter', messages: [...downstream.messages, startupContext] }
    }
    const content = messages.flatMap(message => message.content)
    const merged = await runPoint('UserPromptSubmit', '', promptPayload(ctx, agent, content), { agent, turn, signal })
    if (merged.stop) return { kind: 'reject' }
    if (merged.decision === 'deny') {
      return { kind: 'reject' }
    }
    // Delegate so later listeners may still rewrite or reject, then append the
    // gated SessionStart context followed by this prompt hook's context.
    const downstream = await next()
    if (downstream.kind !== 'enter') return downstream
    const ours = contextFrom(merged)
    return {
      kind: 'enter',
      messages: [
        ...downstream.messages,
        ...startupContext ? [startupContext] : [],
        ...ours ? [ours] : [],
      ],
    }
  })

  // --- PreToolUse safe rewrite + decision mapping. Model-direct calls first
  // pass this pre-persistence agent seam. The returned block is the canonical
  // assistant/tool-call input, while the merged permission decision is cached
  // and consumed exactly once by tools/pre-execute.
  ctx.on('agent/tool-call-input', async ({ agent, turn, call: _call, signal }, next) => {
    const downstream = await next()
    signal.throwIfAborted()
    const input = parseToolInput(downstream.arguments)
    const merged = await runPoint(
      'PreToolUse', downstream.name,
      preToolPayloadValues(ctx, agent, downstream.name, input, downstream.id),
      { agent, turn, signal },
    )
    let calls = preToolOutcomes.get(agent)
    if (calls === undefined) {
      calls = new Map()
      preToolOutcomes.set(agent, calls)
    }
    calls.set(String(downstream.id), merged)
    if (merged.updatedInput === undefined) return downstream
    return { ...downstream, arguments: JSON.stringify(merged.updatedInput) }
  })

  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(exec.agent)
    const key = String(exec.callId)
    const calls = exec.agent === undefined ? undefined : preToolOutcomes.get(exec.agent)
    const cached = calls?.get(key)
    if (cached !== undefined) {
      calls?.delete(key)
      if (calls?.size === 0 && exec.agent !== undefined) preToolOutcomes.delete(exec.agent)
    }
    const merged = cached ?? await runPoint('PreToolUse', exec.name, preToolPayload(ctx, exec), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    if (cached === undefined && merged.updatedInput !== undefined) {
      ctx.logger.warn('hooks-claude-code: PreToolUse updatedInput was produced for a non-model/nested tool call and cannot be durably rewritten (ignored)')
    }
    if (deferStop(exec.agent, merged, 'PreToolUse')) {
      return { kind: 'deny', reason: merged.stopReason ?? 'stopped by PreToolUse hook' }
    }
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    if (merged.decision === 'ask') return { kind: 'ask', ...merged.reason !== undefined ? { reason: merged.reason } : {} }
    return next()
  })

  // --- PostToolUse / PostToolUseFailure → PostToolDecision. The canonical
  // execution result decides which Claude event fires; failures never pass
  // through the success event.
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const turn = lastTurn(exec.agent)
    const point = result.isError ? 'PostToolUseFailure' : 'PostToolUse'
    const merged = await runPoint(
      point,
      exec.name,
      postToolPayload(ctx, point, exec, result),
      { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal },
    )
    deferStop(exec.agent, merged, point)
    const context = contextFrom(merged)
    if (merged.decision === 'deny') {
      return { kind: 'block', feedback: [{ type: 'text', text: merged.reason ?? `blocked by ${point} hook` }], ...context ? { additionalContexts: [context] } : {} }
    }
    // Our hooks did not block. DELEGATE so a later listener can still block/replace,
    // then fold our context onto its decision (a downstream block carries it too).
    const downstream = await next()
    if (!context) return downstream
    if (downstream.kind === 'block') {
      return { ...downstream, additionalContexts: prependContext(context, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(context, downstream.additionalContexts),
    }
  })

  // A blocking Stop hook steers at the stopping boundary, which makes the
  // machine observe pending input and run another step. Bound consecutive
  // continuations so an unconditional hook cannot create an infinite turn.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const previous = stopContinuations.get(agent)
    const active = previous?.turn === turn && previous.count > 0
    const merged = await runPoint('Stop', '', stopPayload(ctx, agent, active), { agent, turn, signal })
    if (merged.stop) {
      stopContinuations.delete(agent)
      return
    }
    if (merged.decision !== 'deny') {
      stopContinuations.delete(agent)
      return
    }
    const count = previous?.turn === turn ? previous.count + 1 : 1
    if (count > maxStopContinuations) {
      stopContinuations.delete(agent)
      ctx.logger.warn(`hooks-claude-code: Stop hook continuation limit (${maxStopContinuations}) reached for turn ${turn}; allowing turn to stop`)
      return
    }
    stopContinuations.set(agent, { turn, count })
    const text = merged.reason ?? 'continue: blocked by Stop hook'
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE }))
  })

  // SubagentStart may inject child context; SubagentStop only observes. A
  // local child's persisted agent preset is the compatibility agent_type;
  // children without one (and remote children) keep Claude's default.
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    if (child !== undefined) subagentChildren.set(info.runId, child)
    const agentType = subagentType(child)
    subagentTypes.set(info.runId, agentType)
    detached.track(runPoint('SubagentStart', agentType, subagentPayload(ctx, 'SubagentStart', info, child, agentType), { ...child ? { agent: child } : {}, signal: detached.signal })
      .then((merged) => {
        const context = contextFrom(merged)
        if (context && child) child.inject(context)
      })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: SubagentStart hook failed: ${String(error)}`) }))
  })
  ctx.on('subagent/end', (info) => {
    const child = subagentChildren.get(info.runId) ?? ctx.get('agents')?.get(info.id)
    subagentChildren.delete(info.runId)
    const agentType = subagentTypes.get(info.runId) ?? subagentType(child)
    subagentTypes.delete(info.runId)
    detached.track(runPoint('SubagentStop', agentType, subagentPayload(ctx, 'SubagentStop', info, child, agentType), { ...child ? { agent: child } : {}, signal: detached.signal }))
  })
}

/** Claude Code's fallback `agent_type` when Harness has no stable local preset. */
const DEFAULT_SUBAGENT_TYPE = 'general-purpose'

/**
 * Map a local Harness child to Claude's `agent_type` vocabulary without adding
 * a Claude-only field to the native subagent seam. `agentPreset` is durable
 * session metadata because it identifies the child's actual tool/prompt
 * composition. Remote or untyped children retain Claude's own default.
 */
function subagentType(child: Agent | undefined): string {
  const preset = child?.session.header.agentPreset
  return preset !== undefined && preset.length > 0 ? preset : DEFAULT_SUBAGENT_TYPE
}

// --- Per-event stdin payloads (the CC DIALECT shape). Field names match CC's
// hook input schema; this is the part a bridge owns. ---

/** The last open turn number in the agent's log, or 0 without an agent. */
function lastTurn(agent: Agent | undefined): number {
  if (!agent) return 0
  const last = [...agent.session.events].findLast(e => e.type === 'turn/start')
  /* v8 ignore next -- agent-present callers are tool/stop extension points inside an open turn. */
  return last?.type === 'turn/start' ? last.data.turn : 0
}

/** Flatten content blocks to the text a hook payload carries (the common case). */
function blocksToText(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}

function base(ctx: Context, agent: Agent | undefined, event: string): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    transcript_path: agent === undefined
      ? ''
      : ctx.get('sessionPersistence')?.locate(agent.session.header)?.path ?? '',
    cwd: agent?.session.header.cwd ?? process.cwd(),
    hook_event_name: event,
  }
}

function sessionStartPayload(ctx: Context, agent: Agent, source: string): Record<string, unknown> {
  return { ...base(ctx, agent, 'SessionStart'), source }
}
function promptPayload(ctx: Context, agent: Agent, content: ContentBlock[]): Record<string, unknown> {
  return { ...base(ctx, agent, 'UserPromptSubmit'), prompt: blocksToText(content) }
}
function parseToolInput(raw: string): unknown {
  try {
    return raw.length > 0 ? JSON.parse(raw) : {}
  } catch {
    return raw
  }
}
function preToolPayloadValues(
  ctx: Context,
  agent: Agent | undefined,
  name: string,
  input: unknown,
  callId: unknown,
): Record<string, unknown> {
  return { ...base(ctx, agent, 'PreToolUse'), tool_name: name, tool_input: input, tool_use_id: callId }
}
function preToolPayload(ctx: Context, exec: ToolExecution): Record<string, unknown> {
  return preToolPayloadValues(ctx, exec.agent, exec.name, exec.arguments, exec.callId)
}
function postToolPayload(ctx: Context, point: 'PostToolUse' | 'PostToolUseFailure', exec: ToolExecution, result: ToolExecutionResult): Record<string, unknown> {
  const common = { ...base(ctx, exec.agent, point), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId }
  return result.isError
    ? { ...common, error: result.error.message, is_interrupt: exec.signal.aborted }
    : { ...common, tool_response: blocksToText(result.content) }
}
function stopPayload(ctx: Context, agent: Agent, stopHookActive: boolean): Record<string, unknown> {
  return { ...base(ctx, agent, 'Stop'), stop_hook_active: stopHookActive }
}
/**
 * Build a SubagentStart/SubagentStop payload from the CC base (the child's
 * `session_id`/`cwd` when the child agent is available) plus the subagent-hook
 * fields. `agent_type` is the captured Harness preset or Claude fallback;
 * `stop_hook_active` is present on SubagentStop only (the loop-guard flag,
 * always false).
 */
function subagentPayload(
  ctx: Context,
  event: 'SubagentStart' | 'SubagentStop',
  info: { id: string },
  child: Agent | undefined,
  agentType: string,
): Record<string, unknown> {
  return {
    ...base(ctx, child, event),
    agent_id: info.id,
    agent_type: agentType,
    ...event === 'SubagentStop' ? { stop_hook_active: false } : {},
  }
}
