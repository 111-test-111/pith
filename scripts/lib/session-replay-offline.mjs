/** Process-local network guard for replay/record commands and their checks. */
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

export function installReplayOfflineGuard() {
  const restore = []
  const deny = () => { throw new Error('session-replay-network-disabled') }
  for (const [object, keys] of [[globalThis, ['fetch', 'WebSocket']], [net, ['connect', 'createConnection']], [tls, ['connect']], [http, ['request', 'get']], [https, ['request', 'get']]]) {
    for (const key of keys) {
      const original = object[key]
      if (original === undefined) continue
      object[key] = deny
      restore.push(() => { object[key] = original })
    }
  }
  syncBuiltinESMExports()
  return () => { for (const reset of restore.reverse()) reset(); syncBuiltinESMExports() }
}
