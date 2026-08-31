/**
 * Return whether a wildcard selector contains one concrete or wildcard value.
 * @param selector - enclosing exact, path-prefix, dotted-prefix, or global selector.
 * @param value - candidate exact or wildcard value.
 * @returns whether the selector contains the candidate value.
 */
export function selectorContains(selector: string, value: string): boolean {
  if (selector === '*') return true
  if (selector.endsWith('/**')) {
    const root = selector.slice(0, -3).replace(/\/$/, '')
    return value === root || value.startsWith(`${root}/`)
  }
  if (selector.endsWith('.*')) {
    const root = selector.slice(0, -2)
    return value === root || value.startsWith(`${root}.`)
  }
  return selector === value
}
