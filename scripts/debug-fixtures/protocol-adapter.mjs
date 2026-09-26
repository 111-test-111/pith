// Deterministic wire fixture. Exercises the production client/manager without
// claiming a real Python, Go or JavaScript runtime integration.
import { createServer } from 'node:net'
import { appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const mode = process.argv[2]
const childMode = mode?.startsWith('child')
const log = process.env.PI_DAP_PROTOCOL_LOG
const targets = new Map()
let targetSerial = 0
let seq = 0
function serve(input, output) {
  let buffer = Buffer.alloc(0), launch, points = [], epoch = 0
  const send = message => { const text = JSON.stringify({ seq: ++seq, ...message }); output.write(`Content-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`) }
  const event = (event, body) => send({ type: 'event', event, body })
  const reply = (request, body = {}, success = true) => send({ type: 'response', request_seq: request.seq, command: request.command, body, success })
  const stopped = () => { epoch++; event('stopped', { threadId: 1, reason: 'breakpoint' }) }
  const startChild = () => send({ type: 'request', command: 'startDebugging', arguments: { request: 'attach', configuration: { type: 'pwa-node', name: 'fixture target', __pendingTargetId: `target-${++targetSerial}` } } })
  input.on('data', data => {
    buffer = Buffer.concat([buffer, data])
    while (true) {
      const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return
      const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())[1])
      if (buffer.length < end + 4 + length) return
      const r = JSON.parse(buffer.subarray(end + 4, end + 4 + length)); buffer = buffer.subarray(end + 4 + length)
      if (log) appendFileSync(log, JSON.stringify(r) + '\n')
      if (r.type === 'response' && r.command === 'runInTerminal') { reply(launch, {}, r.success); if (r.success) stopped(); continue }
      if (r.type !== 'request') continue
      const a = r.arguments ?? {}
      switch (r.command) {
        case 'initialize':
          if (mode === 'fail') { reply(r, {}, false); break }
          reply(r, { supportsConfigurationDoneRequest: true, supportsRestartRequest: mode === 'child-native' }); break
        case 'launch': case 'attach':
          launch = r
          if (childMode && a.__pendingTargetId) targets.set(a.__pendingTargetId, () => event('terminated'))
          if (mode === 'no-initialized') break
          event('initialized')
          if (mode === 'terminal') send({ type: 'request', command: 'runInTerminal', arguments: { cwd: process.cwd(), args: ['echo', 'fixture'], env: { SET: 'yes', DELETE: null } } })
          break
        case 'configurationDone':
          reply(r)
          if (mode === 'terminal') break
          if (childMode && !launch.arguments.__pendingTargetId) {
            startChild()
          } else stopped()
          reply(launch)
          if (mode === 'crash-tree') {
            const child = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{});require('fs').writeFileSync(process.env.PI_DAP_CHILD_PID,String(process.pid));setInterval(()=>{},1000)`], { stdio: 'ignore' })
            child.once('spawn', () => setTimeout(() => process.exit(1), 150))
          }
          if (mode === 'final-tail') { event('exited', { exitCode: 0 }); event('output', { output: 'FINAL TAIL' }); event('terminated') }
          break
        case 'threads': reply(r, { threads: [{ id: 1, name: 'main' }] }); break
        case 'stackTrace': {
          const answer = () => reply(r, { stackFrames: [{ id: 1, name: 'main', line: 7, source: { path: '/fixture/demo.c' } }] })
          if (mode === 'slow-stack' && epoch === 2) setTimeout(answer, 150)
          else answer()
          break
        }
        case 'scopes': reply(r, { scopes: [{ name: 'Locals', variablesReference: 100 }] }); break
        case 'variables': {
          if (mode?.startsWith('variables-')) {
            const all = Array.from({ length: a.variablesReference }, (_, i) => ({ name: String(i), value: String(i), variablesReference: 0 }))
            reply(r, { variables: mode === 'variables-paged' ? all.slice(a.start ?? 0, a.count ? (a.start ?? 0) + a.count : undefined) : all })
          } else setTimeout(() => reply(r, { variables: [{ name: 'value', value: String(epoch), variablesReference: 0 }] }), a.start === 99 ? 100 : 0)
          break
        }
        case 'evaluate':
          if (a.expression === 'broken') reply(r, { error: { format: 'Cannot evaluate {expression}: unknown return type', variables: { expression: 'broken' } } }, false)
          else reply(r, { result: '42', variablesReference: 0 })
          break
        case 'setBreakpoints':
          points = a.breakpoints.map((p, i) => ({ ...p, id: i + 1, verified: true }))
          reply(r, { breakpoints: points }); break
        case 'continue': case 'next': case 'stepIn': case 'stepOut':
          if (mode === 'slow-stack' && r.command === 'continue') { event('continued', { threadId: 1 }); reply(r); break }
          // Deliberately stop before the control response, reusing frame refs.
          event('continued', { threadId: 1 }); stopped(); reply(r)
          if (points[0]) event('breakpoint', { reason: 'changed', breakpoint: { id: 1, line: 9, verified: false } })
          if (r.command === 'stepIn') {
            event('breakpoint', { reason: 'removed', breakpoint: { id: 1 } })
            event('breakpoint', { reason: 'new', breakpoint: { id: 100, source: { path: '/fixture/demo.c' }, line: 20, verified: true } })
          }
          event('output', { output: 'x'.repeat(70000) + 'TAIL' }); break
        case 'pause': stopped(); reply(r); break
        case 'restart':
          if (mode !== 'child-native') { reply(r, {}, false); break }
          for (const terminate of targets.values()) terminate()
          targets.clear()
          startChild(); reply(r); break
        case 'disconnect': reply(r); event('terminated'); if (!mode?.startsWith('tcp') && !childMode) setTimeout(() => process.exit(), 10); break
        default: reply(r, {}, false)
      }
    }
  })
}
if (childMode || mode?.startsWith('tcp')) createServer(s => serve(s, s)).listen(Number(process.argv[3]), '127.0.0.1')
else serve(process.stdin, process.stdout)
