import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const root = process.cwd()

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: options.stdio ?? 'pipe' })
}

function trackedFiles() {
  return run('git', ['ls-files', '-z']).split('\0').filter(Boolean)
}

function protectedAsset(path) {
  return /(^|\/)(src|test|tests|fixtures|snapshots|stress-tests)(\/|$)/.test(path)
}

function obsoleteSkill(path) {
  return [
    '.agents/skills/dsh-archive-agent-notes/',
    '.agents/skills/dsh-doc-site-sync/',
    '.agents/skills/dsh-doc-standards/',
    '.agents/skills/dsh-prose-standard/',
    '.agents/skills/dsh-translate-docs/',
    '.agents/skills/dsh-pre-push-checks/',
  ].some(prefix => path.startsWith(prefix))
}

const obsoleteScriptTokens = [
  'agent-note',
  'archived-agent-notes',
  'client-catalog',
  'config-catalog',
  'cordis-api',
  'cordis-catalog',
  'doc-budgets',
  'doc-graphs',
  'doc-site',
  'doc-typecheck',
  'md-links',
  'md-wrap',
  'module-graph',
  'package-readme',
  'persistence-catalog',
  'public-repository-links',
  'scoped-events',
  'third-party-notices',
  'tool-catalog',
  'translation-',
  'type-equiv',
]

function obsoleteScript(path) {
  if (!path.startsWith('scripts/')) return false
  const name = basename(path).toLowerCase()
  return obsoleteScriptTokens.some(token => name.includes(token))
}

function obsoleteFile(path) {
  if (protectedAsset(path)) return false
  if (path.startsWith('docs/')) return true
  if (path.startsWith('website/')) return true
  if (path.startsWith('.agents/notes/')) return true
  if (path.startsWith('.claude/')) return true
  if (path.startsWith('.github/ISSUE_TEMPLATE/')) return true
  if (path === '.github/pull_request_template.md') return true
  if (path === '.gitlab-ci.yml') return true
  if (path === 'deepseek-harness-master.zip') return true
  if (obsoleteSkill(path)) return true
  if (obsoleteScript(path)) return true
  if (path.endsWith('.i18n.yaml')) return true
  if (path.endsWith('.md') && !path.startsWith('.agents/skills/')) return true
  return false
}

function gitRemove(paths) {
  for (let index = 0; index < paths.length; index += 100) {
    const batch = paths.slice(index, index + 100)
    if (batch.length > 0) run('git', ['rm', '-f', '--ignore-unmatch', '--', ...batch])
  }
}

const removed = trackedFiles().filter(obsoleteFile)
gitRemove(removed)

const readme = `# 888\n\n888 是以源码、测试和仓库工程工具为核心维护的智能体运行时仓库。\n\n## 仓库基线\n\n- \`packages/\`、\`apps/\`、\`python/\`、\`native/\`、\`vendor/\`：产品与运行时源码。\n- 各级 \`tests/\`、\`fixtures/\`、\`snapshots/\`：测试与回归资产。\n- \`scripts/\`、\`devtools/\`、\`.agents/skills/\`、\`.github/workflows/\`：开发、检查、构建和自动化工具。\n- \`package.json\`、\`pnpm-workspace.yaml\`、锁文件、TypeScript/Vitest/Oxlint 配置：工程定义。\n\n旧项目的文档治理、双语镜像、Agent Note 决策档案和文档站不再属于当前仓库基线。当前行为以源码、测试和实际工程配置为准。\n\n## 常用命令\n\n\`\`\`sh\npnpm install --frozen-lockfile\npnpm run lint\npnpm run typecheck\npnpm run test\npnpm run build\npnpm run check:all\n\`\`\`\n`

const agents = `# AGENTS.md\n\n本仓库以源码、测试和可执行工程配置为事实源。\n\n## 工作规则\n\n- 修改行为时同步修改或新增能够证明该行为的测试。\n- 优先修改拥有该行为的包，不建立第二份状态或重复实现。\n- 保留包清单、依赖锁、运行时配置、补丁和构建配置与源码同步。\n- 提交前运行覆盖改动面的最小检查；跨包或工程级变更运行 \`pnpm run check:all\`。\n- 不恢复旧双语文档、Agent Note、文档字数门禁或文档站治理体系，除非用户明确要求重新建立。\n- 不提交密钥、构建产物、缓存和临时工作目录。\n\n## 基线检查\n\n- \`pnpm run lint\`：代码检查。\n- \`pnpm run typecheck\`：类型检查。\n- \`pnpm run test\`：单元与仓库测试。\n- \`pnpm run build\`：完整构建。\n- \`pnpm run check:all\`：仓库级组合验证。\n`

writeFileSync('README.md', readme)
writeFileSync('AGENTS.md', agents)
run('git', ['add', 'README.md', 'AGENTS.md'])

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
packageJson.workspaces = packageJson.workspaces.filter(workspace => workspace !== 'website')
const obsoleteScriptKey = /(^docs?:|website|translation|agent-note|archived-agent|catalog|doc-|md-|mermaid|module-graph|scoped-events|third-party-notices|package-readme|public-repository-links|type-equiv)/
for (const key of Object.keys(packageJson.scripts ?? {})) {
  if (obsoleteScriptKey.test(key)) delete packageJson.scripts[key]
}
packageJson.scripts['check:all'] = 'tsx scripts/run-checks.ts check-all'
packageJson.scripts.hygiene = 'tsx scripts/run-checks.ts hygiene'
writeFileSync('package.json', `${JSON.stringify(packageJson, null, 2)}\n`)
run('git', ['add', 'package.json'])

for (const path of trackedFiles().filter(path => path.endsWith('/package.json'))) {
  if (!existsSync(path)) continue
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  if (manifest.scripts === undefined) continue
  let changed = false
  for (const key of Object.keys(manifest.scripts)) {
    if (!obsoleteScriptKey.test(key)) continue
    delete manifest.scripts[key]
    changed = true
  }
  if (changed) {
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
    run('git', ['add', path])
  }
}

const workspace = `packages:\n  - vendor/*\n  - packages/*/*\n  - native/landlock-run\n  - native/landlock-run/packages/*\n  - apps/*\n  - examples\n  - python/sdk-runtime\n\nlinkWorkspacePackages: true\n\noverrides:\n  '@deepseek-ai/cosmokit': 'link:vendor/cosmokit'\n  '@deepseek-ai/schemastery': 'link:vendor/schemastery'\n  'brace-expansion@^5.0.0': 5.0.9\n  'protobufjs@^7.0.0': 7.6.5\n  'undici@^7.0.0': 7.29.0\n\npeerDependencyRules:\n  allowedVersions:\n    typescript: '>=5 <7'\n\nallowBuilds:\n  esbuild: true\n  node-pty: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n  koffi: true\n  '@deepseek-ai/dsh-subprocess-local@file:packages/subprocess/subprocess-local': true\n\nminimumReleaseAgeExclude:\n  - '@earendil-works/pi-ai@0.82.1'\n  - node-addon-native-custom-loader@0.1.4\n  - node-addon-require-builtin-darwin-arm64@0.1.4\n  - node-addon-require-builtin-darwin-x64@0.1.4\n  - node-addon-require-builtin-linux-arm64-gnu@0.1.4\n  - node-addon-require-builtin-linux-x64-gnu@0.1.4\n  - node-addon-require-builtin-win32-arm64-msvc@0.1.4\n  - node-addon-require-builtin-win32-ia32-msvc@0.1.4\n  - node-addon-require-builtin-win32-x64-msvc@0.1.4\n  - node-addon-require-builtin@0.1.4\n\npatchedDependencies:\n  node-pty@1.2.0-beta.15: patches/node-pty@1.2.0-beta.15.patch\n`
writeFileSync('pnpm-workspace.yaml', workspace)
run('git', ['add', 'pnpm-workspace.yaml'])

if (existsSync('tsconfig.host.json')) {
  const host = readFileSync('tsconfig.host.json', 'utf8')
    .split('\n')
    .filter(line => !line.includes('"website/'))
    .join('\n')
  writeFileSync('tsconfig.host.json', host)
  run('git', ['add', 'tsconfig.host.json'])
}

const runChecks = `/** Run repository validation groups. */\nimport { spawn } from 'node:child_process'\nimport { resolve } from 'node:path'\nimport { pnpmInvocation } from './pnpm-invocation.ts'\n\nexport type CheckMode = 'check-all' | 'hygiene'\n\ninterface Check {\n  script: string\n}\n\nconst root = resolve(import.meta.dirname, '..')\n\nconst hygieneChecks: Check[] = [\n  { script: 'rescope-vendor:check' },\n  { script: 'knip' },\n  { script: 'publint' },\n  { script: 'constraints' },\n  { script: 'verify-dsh-package-licenses' },\n  { script: 'verify-package-invariants' },\n  { script: 'verify-built-package-invariants' },\n  { script: 'verify-node-next-types' },\n  { script: 'verify-optional-dependency-imports' },\n  { script: 'verify-client-packages' },\n  { script: 'verify-cordis-config' },\n  { script: 'verify-runtime-closure' },\n]\n\nexport function checksForMode(mode: CheckMode): Check[] {\n  if (mode === 'hygiene') return hygieneChecks\n  return [\n    { script: 'lint' },\n    { script: 'typecheck' },\n    { script: 'test' },\n    { script: 'duplication' },\n    { script: 'build' },\n    ...hygieneChecks,\n  ]\n}\n\nfunction parseMode(raw: string | undefined): CheckMode {\n  if (raw === 'check-all' || raw === 'hygiene') return raw\n  throw new Error(\`run-checks: expected check-all | hygiene, got \${JSON.stringify(raw)}.\`)\n}\n\nasync function runCheck(check: Check): Promise<number> {\n  const invocation = pnpmInvocation(['run', check.script])\n  console.log(\`run-checks: \${check.script}\`)\n  return await new Promise((resolveStatus, reject) => {\n    const child = spawn(invocation.command, invocation.args, { cwd: root, env: process.env, stdio: 'inherit' })\n    child.once('error', reject)\n    child.once('exit', (code, signal) => {\n      if (signal !== null) reject(new Error(\`run-checks: \${check.script} terminated by \${signal}.\`))\n      else resolveStatus(code ?? 1)\n    })\n  })\n}\n\nconst mode = parseMode(process.argv[2])\nfor (const check of checksForMode(mode)) {\n  const status = await runCheck(check)\n  if (status !== 0) {\n    process.exitCode = status\n    break\n  }\n}\n`
writeFileSync('scripts/run-checks.ts', runChecks)
run('git', ['add', 'scripts/run-checks.ts'])

for (const path of ['.github/workflows/rebaseline.yml', 'scripts/rebaseline.mjs']) {
  if (existsSync(path)) run('git', ['rm', '-f', '--', path])
}

console.log(`rebaseline: removed ${removed.length} tracked legacy files`)
