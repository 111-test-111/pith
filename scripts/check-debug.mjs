/** Adapter doctor using the application's actual detection, transport and
 * handshake. Absent adapters are explicit skips, never protocol substitutes. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const cwd = resolve('scripts/debug-fixtures'), temp = mkdtempSync(join(tmpdir(), 'pith-debug-doctor-'))
let manager
try {
  await build({ stdin: { contents: `export { DebugManager } from './src/main/debug/manager'; export { detectDebugAdapters } from './src/main/debug/adapters'`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'module.mjs'), plugins: [{ name: 'sdk', setup(b) { b.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), external: true })) } }] })
  const { DebugManager, detectDebugAdapters } = await import(pathToFileURL(join(temp, 'module.mjs')))
  const adapters = await detectDebugAdapters(cwd)
  const fixtures = { 'lldb-dap': ['demo.c', 4, 'x', /7/], debugpy: ['demo.py', 4, 'v', /1/], dlv: ['demo.go', 6, 'a', /2/], 'js-debug': ['demo.js', 2, 'a', /2/] }
  for (const [id, [source, line, expression, expected]] of Object.entries(fixtures)) {
    if (!adapters.find(a => a.id === id)?.available) { console.log(`[SKIP] ${id}: runtime adapter unavailable on this host`); continue }
    manager = new DebugManager(() => {})
    try {
      const file = join(cwd, source)
      let program = file
      if (id === 'lldb-dap') {
        program = join(temp, 'demo')
        execFileSync(process.platform === 'darwin' ? 'xcrun' : 'clang', [...(process.platform === 'darwin' ? ['clang'] : []), '-g', '-O0', file, '-o', program], { timeout: 30_000 })
      }
      const sessionPath = `/doctor/${id}`
      const root = await manager.start({ sessionPath, sessionId: id, workspaceCwd: cwd, cwd, adapterId: id, kind: 'launch', program, initialBreakpoints: new Map([[file, [{ line }]]]) })
      let target
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        target = manager.list(sessionPath).find(s => s.status === 'stopped' && (id !== 'js-debug' || s.parentId))
        if (target) break
        if (manager.get(sessionPath, root.id).status === 'failed') throw Error('Adapter failed')
        await new Promise(r => setTimeout(r, 25))
      }
      assert.ok(target, 'target did not stop at its breakpoint')
      const frames = await manager.stack(sessionPath, target.activeThreadId, undefined, target.id)
      assert.ok(frames.length > 0)
      const scopes = await manager.scopes(sessionPath, frames[0].id, target.id)
      assert.ok(scopes.length > 0)
      await manager.variables(sessionPath, scopes[0].variablesReference, undefined, undefined, target.id)
      const evaluated = await manager.evaluate(sessionPath, expression, frames[0].id, target.id)
      assert.match(evaluated.result, expected)
      console.log(`[PASS] ${id}: real launch, breakpoint, stack, scopes, variables, evaluate, disconnect`)
    } catch (error) { console.error(`[FAIL] ${id}: ${error.message}`); process.exitCode = 1 }
    finally { await manager.dispose(); manager = undefined }
  }
} finally { await manager?.dispose(); rmSync(temp, { recursive: true, force: true }) }
