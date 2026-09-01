/**
 * 中文包 README 的限制章节门禁。中文 README 是文档权威来源；英文 README
 * 与翻译侧车不参与该检查。每个非白名单包必须有且只有一个二级“已知限制”
 * 章节，并至少包含一个顶层条目。
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { markdownHeadingLines, markdownProseLines } from './markdown.ts'

const root = resolve(import.meta.dirname, '..')

/** 推荐的新文档标题；历史中文近义标题继续接受，避免无价值的大规模改名。 */
const RECOMMENDED = '## 已知限制与暂缓事项'

/** Packages audited as having no limitations section, keyed by repo-relative directory. */
const NO_LIMITATIONS: Readonly<Record<string, string>> = {
  'packages/util/brand': 'Type-only nominal-branding primitive with no runtime behavior or deferred work.',
}

/** 中文限制章节标题。 */
function isLimitationsLike(headingText: string): boolean {
  const normalized = headingText.trim().replaceAll(/\s+/g, '')
  return normalized.startsWith('已知限制') || normalized.startsWith('已知局限') || normalized.startsWith('限制与')
}

const packageJsons = globSync('packages/*/*/package.json', { cwd: root }).map(path => path.split(sep).join('/')).sort()
const scannedPackages = new Set(packageJsons.map(path => path.slice(0, -'/package.json'.length)))
const failures: string[] = []

for (const [entry, reason] of Object.entries(NO_LIMITATIONS)) {
  if (!scannedPackages.has(entry)) {
    failures.push(`whitelist entry ${entry} does not name a scanned package — renamed or removed? update NO_LIMITATIONS in scripts/verify-package-readme-limitations.ts in the same change`)
  }
  if (reason.trim().length === 0) {
    failures.push(`whitelist entry ${entry} has no justification — state why a limitations section would be empty boilerplate`)
  }
}

for (const pkg of scannedPackages) {
  const readme = `${pkg}/README.zh.md`
  if (!existsSync(resolve(root, readme))) {
    failures.push(`${readme}: 包清单缺少同目录中文 README（推荐标题 ${JSON.stringify(RECOMMENDED)}）`)
    continue
  }
  const source = readFileSync(resolve(root, readme), 'utf8')
  const lines = markdownProseLines(source)
  const headings = markdownHeadingLines(source)
  const limitations = headings.filter(heading => isLimitationsLike(heading.text))

  if (Object.hasOwn(NO_LIMITATIONS, pkg)) {
    for (const heading of limitations) {
      failures.push(`${readme}:${heading.index}: 已声明为无已知限制，但仍包含 ${JSON.stringify(heading.raw)}；删除该章节或移出 NO_LIMITATIONS`)
    }
    continue
  }

  const heading = limitations.at(0)
  if (heading === undefined) {
    failures.push(`${readme}: 缺少中文已知限制章节（推荐标题 ${JSON.stringify(RECOMMENDED)}；确实没有限制的包应加入 NO_LIMITATIONS）`)
    continue
  }
  if (limitations.length > 1) {
    failures.push(`${readme}: 发现 ${limitations.length} 个已知限制类章节（行 ${limitations.map(line => line.index).join(', ')}）；只保留一个`)
    continue
  }
  if (heading.depth !== 2) {
    failures.push(`${readme}:${heading.index}: 已知限制章节必须使用二级标题；推荐 ${JSON.stringify(RECOMMENDED)}`)
    continue
  }
  const headingAt = lines.findIndex(line => line.index === heading.index)
  const body = lines.slice(headingAt + 1)
  const headingLines = new Set(headings.map(entry => entry.index))
  const end = body.findIndex(line => headingLines.has(line.index))
  const section = end === -1 ? body : body.slice(0, end)
  if (!section.some(line => /^- /.test(line.raw))) {
    failures.push(`${readme}:${heading.index}: 已知限制章节没有顶层 "- " 条目；请写明限制，确实没有限制则加入 NO_LIMITATIONS`)
  }
}

if (failures.length > 0) {
  console.error('verify-package-readme-limitations: violations found:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`verify-package-readme-limitations: ${scannedPackages.size} 中文包 README 已检查 (${Object.keys(NO_LIMITATIONS).length} whitelisted), all conform.`)
