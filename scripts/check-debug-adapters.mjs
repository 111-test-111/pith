/** Real-adapter regressions for checkout ownership, Python module launch and
 * JavaScript child-target restart. Native adapters are explicit optional
 * prerequisites; missing adapters are SKIP, never wire-fixture substitutes. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'pith-debug-adapters-')))
const workspace = join(temp, 'workspace'), runtime = join(temp, 'launch-cwd')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(read, label, budget = 10_000) {
  const deadline = Date.now() + budget
  do { const value = await read(); if (value) return value; await delay(10) } while (Date.now() < deadline)
  assert.fail(`Timed out: ${label}`)
}
let manager
try {
  mkdirSync(join(workspace, '.git'), { recursive: true })
  mkdirSync(join(workspace, '.vscode'))
  mkdirSync(runtime)
  writeFileSync(join(workspace, '.vscode', 'launch.json'), JSON.stringify({ configurations: [{
    name: 'Python module', type: 'debugpy', request: 'launch', module: 'review_module', cwd: runtime, stopOnEntry: true
  }] }))
  await build({ stdin: { contents: `export * from './src/main/debug/manager'; export * from './src/main/debug/adapters'; export * from './src/main/debug/tools'; export * from './src/main/rewind/coordinator'`, resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'module.mjs'), plugins: [{ name: 'sdk', setup(b) {
      b.onResolve({ filter: /^(@earendil-works\/pi-coding-agent|typebox)$/ }, a => ({ path: fileURLToPath(import.meta.resolve(a.path)), external: true }))
    } }] })
  const { DebugManager, debugAdapterSpec, createDebugTools, CheckoutCoordinator } = await import(pathToFileURL(join(temp, 'module.mjs')))
  const coordinator = new CheckoutCoordinator()
  manager = new DebugManager(() => {}, coordinator)
  const lldb = debugAdapterSpec(workspace, 'lldb-dap'), python = debugAdapterSpec(workspace, 'debugpy'), js = debugAdapterSpec(workspace, 'js-debug')
  const tool = path => createDebugTools({ manager, services: { cwd: workspace }, sessionId: path, sessionPath: path,
    enabled: () => true, sandboxMode: () => 'danger-full-access', canStart: () => true, runInTerminal: () => false })[0]
  const invoke = async (path, args) => {
    const result = await tool(path).execute('adapter-regression', args, undefined, undefined, { cwd: workspace })
    return JSON.parse(result.content[0].text)
  }
  const launch = (path, extra) => invoke(path, { action: 'start', adapter: 'lldb-dap', cwd: runtime, ...extra })
  const assertFenced = async () => {
    for (const root of [workspace, runtime]) {
      assert.equal(coordinator.restoreBlockers(root).writers, 1)
      await assert.rejects(coordinator.withExclusive(root, 'restore', async () => assert.fail('restore entered a live checkout')))
      await assert.rejects(coordinator.withExclusive(root, 'snapshot', async () => assert.fail('snapshot entered a live checkout')))
    }
  }
  const assertReleased = () => {
    assert.equal(coordinator.restoreBlockers(workspace).writers, 0)
    assert.equal(coordinator.restoreBlockers(runtime).writers, 0)
  }
  const childOf = (path, rootId, previousId) => until(() => manager.list(path).find(s => s.parentId === rootId && s.id !== previousId && s.status === 'stopped' && s.location), 'replacement child')

  if (await lldb.detect(workspace)) {
    const source = join(workspace, 'worker.c'), program = join(workspace, 'worker'), marker = join(workspace, 'running')
    writeFileSync(source, '#include <stdio.h>\n#include <unistd.h>\nint main(int argc,char **argv){FILE *f=fopen(argv[1],"w");fputs("running",f);fclose(f);sleep(30);return 0;}\n')
    execFileSync(process.platform === 'darwin' ? 'xcrun' : 'clang', [...(process.platform === 'darwin' ? ['clang'] : []), '-g', '-O0', source, '-o', program], { timeout: 30_000 })
    const path = '/review/real-lldb'
    await launch(path, { program, args: [marker] })
    await until(() => existsSync(marker), 'real LLDB debuggee writes owning workspace')
    await assertFenced()
    await manager.stopSession(path); assertReleased()
    console.log('[PASS] real LLDB: external-cwd process writes its owning workspace while both checkouts reject restore/snapshot')
  } else console.log('[SKIP] real LLDB ownership: adapter unavailable')

  if (await python.detect(runtime)) {
    const moduleFile = join(runtime, 'review_module.py')
    writeFileSync(moduleFile, 'import time\nvalue = 42\nprint(value, flush=True)\ntime.sleep(30)\n')
    const path = '/review/real-python'
    const module = await invoke(path, { action: 'start', configuration: 'Python module' })
    assert.equal(module.status, 'stopped')
    const frames = await manager.stack(path, module.activeThreadId, undefined, module.id, module.stopId)
    assert.ok(frames.some(f => f.file === moduleFile))
    await manager.setBreakpoints(path, moduleFile, [3], undefined, module.id)
    const hit = await manager.control(path, 'continue', undefined, 5000, module.id)
    assert.equal(hit.session.location?.line, 3)
    assert.equal((await manager.evaluate(path, 'value', undefined, module.id)).result, '42')
    await manager.stopSession(path); assertReleased()
    console.log('[PASS] real debugpy: imported module-only launch stops, exposes its source and hits/evaluates a breakpoint')
  } else console.log('[SKIP] real Python module launch: debugpy unavailable')

  if (await js.detect(runtime)) {
    const program = join(workspace, 'loop.js')
    writeFileSync(program, 'let value = 0;\nfunction tick() {\n  value++;\n}\nsetInterval(tick, 25);\n')
    const path = '/review/real-js'
    const root = await launch(path, { adapter: 'js-debug', program, stopOnEntry: true })
    const child = await childOf(path, root.id)
    await manager.setBreakpoints(path, program, [3], { conditions: ['value >= 1'] }, child.id)
    assert.equal((await manager.control(path, 'continue', undefined, 5000, child.id)).session.location?.line, 3)
    const restarted = await manager.restart(path, root.id)
    assert.equal(restarted.id, root.id, 'real js-debug uses native restart')
    const replacement = await childOf(path, root.id, child.id)
    assert.equal((await manager.breakpoints(path, replacement.id))[0]?.condition, 'value >= 1')
    const hit = await manager.control(path, 'continue', undefined, 5000, replacement.id)
    assert.equal(hit.settled, true); assert.equal(hit.session.location?.line, 3)
    assert.equal((await manager.evaluate(path, 'value', undefined, replacement.id)).result, '1')
    await manager.setBreakpoints(path, program, [], undefined, replacement.id)
    await manager.restart(path, root.id)
    const cleared = await childOf(path, root.id, replacement.id)
    const running = await manager.control(path, 'continue', undefined, 500, cleared.id)
    assert.equal(running.settled, false); assert.equal(running.session.status, 'running')
    await manager.stopSession(path); assertReleased()
    console.log('[PASS] real js-debug: a child conditional breakpoint re-hits after native restart; clearing it survives the next restart')
  } else console.log('[SKIP] real js-debug restart: adapter unavailable')
} finally {
  await manager?.dispose()
  rmSync(temp, { recursive: true, force: true })
}
