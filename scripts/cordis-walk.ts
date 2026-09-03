/**
 * AST helper for the vendored Cordis core API projector.
 */

import ts from 'typescript'

/** Every Cordis module-merge body in a parsed source file, in source order. */
function cordisModuleBodies(sf: ts.SourceFile): ts.ModuleBlock[] {
  const bodies: ts.ModuleBlock[] = []
  for (const stmt of sf.statements) {
    if (!ts.isModuleDeclaration(stmt) || !ts.isStringLiteral(stmt.name)) continue
    if (stmt.name.text !== '@deepseek-ai/cordis' && stmt.name.text !== './context.ts') continue
    if (stmt.body && ts.isModuleBlock(stmt.body)) bodies.push(stmt.body)
  }
  return bodies
}

/** The FIRST cordis module-merge body in `sf`, or null without one — for the
 * vendor core-API renderer whose input files carry exactly one merge; the
 * exhaustiveness scan uses {@link cordisModuleBodies} to read them all. */
export function cordisModuleBody(sf: ts.SourceFile): ts.ModuleBlock | null {
  return cordisModuleBodies(sf)[0] ?? null
}
