# `@deepseek-ai/dsh-runtime-policy`

`runtime-policy` owns the Harness 2.0 execution freeze that sits outside the core agent loop. Core exposes one internal `agent/step-snapshot` waterfall; this package persists execution-domain facts and returns only their sequence references to the canonical `step/snapshot` event.

## Contracts

- **CapabilityPermission** — capability + canonical resource rules with `allow`, `ask`, and `deny`. Specific rules refine a source layer; independent source layers may only narrow permission, so configuration or delegation cannot widen the sandbox.
- **GlobalBudget** — one durable ledger for tokens, micro-cost, wall time, tool calls, agent starts, and risk points. Pre-dispatch debits are admission controlled; observed usage is always recorded even when it crosses a limit.
- **ExecutionWorld** — freezes the current workspace policy and mounted execution substrates.
- **WorldEffectReceipt** — records `world/effect-start` before a potentially state-changing tool body and a matching receipt after it settles. A durable start without a receipt after a crash is explicitly `result-unknown`, not silently replay-safe.
- **AgentKind / resolved config** — freezes the coarse agent role and non-message model/runtime configuration used by the attempt.

The package augments `StepSnapshotRefs` with `permission`, `budget`, `world`, and `config`. Its optional `./invariant` companion validates those references and the effect start/receipt relation. Canonical facts live only in Session events; Cordis signals are internal coordination seams.

## Model Experience

### Runtime policy boundary

#### What the model sees

No prompt, message, schema, or provider call is added directly. The model only observes later tool outcomes produced after execution admission.

#### Token effect

No direct prompt-token cost is added by this package; durable runtime-policy events remain model-hidden.

#### KV Cache effect

No direct request-prefix invalidation; changed execution policy can affect later tool outcomes and therefore only later conversation content.
