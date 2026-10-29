/** Real LLDB regression for the reported strcmp condition, not a wire mock. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const temp = mkdtempSync(join(tmpdir(), 'pith-debug-conditions-'))
const file = resolve('scripts/debug-fixtures/conditions.c'), program = join(temp, 'conditions'), sessionPath = '/conditions'
let manager
try {
  await build({ stdin: { contents: `export * from './src/main/debug/manager'; export {debugAdapterSpec} from './src/main/debug/adapters'`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'module.mjs'), plugins: [{ name: 'sdk', setup(b) { b.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, a => ({ path: fileURLToPath(import.meta.resolve(a.path)), external: true })) } }] })
  const { DebugManager, debugAdapterSpec } = await import(pathToFileURL(join(temp, 'module.mjs')))
  if (!await debugAdapterSpec(temp, 'lldb-dap').detect(temp)) console.log('[SKIP] LLDB conditions: lldb-dap unavailable')
  else {
    execFileSync(process.platform === 'darwin' ? 'xcrun' : 'clang', [...(process.platform === 'darwin' ? ['clang'] : []), '-g', '-O0', file, '-o', program])
    manager = new DebugManager(() => {})
    const raw = 'strcmp(key, "tr-d096a4e4") == 0 && slot->state == 2'
    const cast = '(int)strcmp(key, "tr-d096a4e4") == 0 && slot->state == 2'
    const simple = "key[3] == 'd' && slot->state == 2"
    const launch = () => manager.start({ sessionPath, sessionId: 'conditions', workspaceCwd: temp, cwd: temp, adapterId: 'lldb-dap', kind: 'launch', program, stopOnEntry: true })
    const set = (s, condition) => manager.setBreakpoints(sessionPath, file, [5], condition ? { conditions: [condition] } : undefined, s.id)
    const run = s => manager.control(sessionPath, 'continue', undefined, 5000, s.id)
    const evaluate = (s, expression) => manager.evaluate(sessionPath, expression, undefined, s.id)
    const first = await launch()
    const points = await set(first, raw)
    assert.equal(points[0].verified, true); assert.equal(points[0].conditionStatus, 'unvalidated')
    const rawStop = (await run(first)).session
    assert.equal(rawStop.status, 'stopped')
    if (rawStop.conditionError) {
      assert.match(rawStop.stopDiagnostics, /error evaluating condition of breakpoint/)
      assert.match(rawStop.stopDiagnostics, /unknown return type/)
      assert.ok(rawStop.hitBreakpointIds.includes(points[0].id)); assert.ok(rawStop.stopDescription)
      assert.match((await evaluate(first, 'key')).result, /tr-6c181547/)
      await assert.rejects(evaluate(first, raw), /unknown return type/)
      assert.match((await evaluate(first, cast)).result, /false|= 0$/)
      assert.equal((await manager.breakpoints(sessionPath, first.id))[0].conditionStatus, 'error')
      await set(first, cast)
      assert.equal((await manager.breakpoints(sessionPath, first.id))[0].conditionStatus, 'unvalidated')
      assert.equal((await run(first)).session.conditionError, undefined)
      console.log('[PASS] LLDB raw strcmp: verified binding preserves condition error, diagnostics, hit id and wrong-key evidence; typed correction resumes to the match')
    } else console.log('[PASS] This LLDB resolves strcmp without a cast; no condition error was inferred')
    assert.match((await evaluate(first, 'key')).result, /tr-d096a4e4/)
    await manager.stop(sessionPath, first.id)
    for (const condition of [cast, simple]) {
      const target = await launch(); await set(target, condition)
      const stopped = await run(target)
      assert.equal(stopped.settled, true); assert.equal(stopped.session.stopReason, 'breakpoint')
      assert.equal(stopped.session.conditionError, undefined)
      assert.match((await evaluate(target, 'key')).result, /tr-d096a4e4/)
      assert.match((await evaluate(target, 'slot->state')).result, /= 2$/)
      await manager.stop(sessionPath, target.id)
    }
    const unconditional = await launch(); await set(unconditional)
    await run(unconditional); assert.match((await evaluate(unconditional, 'key')).result, /tr-6c181547/)
    await run(unconditional); assert.match((await evaluate(unconditional, 'key')).result, /tr-d096a4e4/)
    await manager.stop(sessionPath, unconditional.id)
    console.log('[PASS] LLDB cast and non-function conditions skip the wrong key and stop on the target; unconditional breakpoints stop on both')
  }
} finally { await manager?.dispose(); rmSync(temp, { recursive: true, force: true }) }
