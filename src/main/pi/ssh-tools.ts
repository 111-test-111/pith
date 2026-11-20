import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { SSH_TOOL_NAMES } from '../../shared/ssh'
import type { SshSessionManager } from '../ssh/manager'
import { appToolError, appToolOutputSchema, appToolResult } from './tool-result'

export { SSH_TOOL_NAMES }
const id = Type.String({ description: 'SSH session ID returned by ssh_connect or list.' })
const sessionSchema = Type.Object({
  id: Type.String(), sessionPath: Type.String(), host: Type.String(), port: Type.Number(), username: Type.String(),
  status: Type.Union(['connecting', 'connected', 'reconnecting', 'disconnected', 'failed', 'closed'].map(v => Type.Literal(v))),
  persistence: Type.Union([Type.Literal('tmux'), Type.Literal('shell')]), remoteSession: Type.Optional(Type.String()),
  fingerprint: Type.Optional(Type.String()), generation: Type.Number(), revision: Type.Number(), reconnectAttempts: Type.Number(),
  cols: Type.Number(), rows: Type.Number(), outputChars: Type.Number(), startedAt: Type.Number(), error: Type.Optional(Type.String()),
  remoteTerminated: Type.Optional(Type.Boolean())
})
const resultSchema = Type.Union([
  Type.Object({ session: sessionSchema, delivery: Type.Optional(Type.Literal('sent-not-confirmed')) }),
  Type.Object({ sessions: Type.Array(sessionSchema) }),
  Type.Object({ session: sessionSchema, text: Type.String(), screen: Type.String(), cursor: Type.Number(), startCursor: Type.Number(), truncated: Type.Boolean(), hasMore: Type.Boolean() })
])
const connectParameters = Type.Object({
  host: Type.String({ minLength: 1, maxLength: 253 }), port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
  username: Type.String({ minLength: 1, maxLength: 128 }),
  credentialsFile: Type.Optional(Type.String({ description: 'Local JSON file containing password, privateKey/privateKeyPath and optional passphrase. Never read or echo its contents into chat.' })),
  privateKeyPath: Type.Optional(Type.String({ description: 'Local private-key file. Relative paths resolve from the chat workspace.' })),
  passwordEnv: Type.Optional(Type.String({ description: 'Name of an environment variable holding the SSH password; never put the password in tool arguments.' })),
  passphraseEnv: Type.Optional(Type.String({ description: 'Name of the environment variable holding the private-key passphrase.' })),
  agent: Type.Optional(Type.Boolean({ description: 'Use the inherited SSH_AUTH_SOCK when no password or key is supplied; default true. No agent forwarding.' })),
  persistence: Type.Optional(Type.Union([Type.Literal('tmux'), Type.Literal('shell')], { description: 'Default tmux preserves remote commands/cwd across transport loss. Requires remote tmux. shell is explicitly transient; reconnect starts a new shell.' })),
  remoteSession: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]{1,80}$', description: 'Optional remote tmux name to reattach, including after reopening the app. Default is a unique returned name.' })),
  hostFingerprint: Type.Optional(Type.String({ description: 'Optional expected SHA256 host-key fingerprint. Otherwise trust first use and pin future connections.' })),
  cols: Type.Optional(Type.Integer({ minimum: 2, maximum: 240 })), rows: Type.Optional(Type.Integer({ minimum: 2, maximum: 100 })),
  autoReconnect: Type.Optional(Type.Boolean({ description: 'Default true: reconnect transport failures with backoff, never replay input.' })),
  keepaliveIntervalMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120_000 })),
  readyTimeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: 120_000 }))
})
const parameters = Type.Object({ request: Type.Union([
  Type.Object({ action: Type.Literal('list') }),
  Type.Object({ action: Type.Literal('status'), id }),
  Type.Object({ action: Type.Literal('read'), id, cursor: Type.Optional(Type.Integer({ minimum: 0 })),
    maxChars: Type.Optional(Type.Integer({ minimum: 2, maximum: 65_536 })), waitMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 30_000 })) }),
  Type.Object({ action: Type.Literal('write'), id, generation: Type.Integer({ minimum: 1, description: 'Use the latest status/read generation. Stale generations fail before sending.' }),
    data: Type.String({ maxLength: 65_536, description: 'Exact terminal input. Include \r to submit a shell command; control characters support Ctrl-C, Tab, arrows and interactive programs.' }) }),
  Type.Object({ action: Type.Literal('resize'), id, cols: Type.Integer({ minimum: 2, maximum: 240 }), rows: Type.Integer({ minimum: 2, maximum: 100 }) }),
  Type.Object({ action: Type.Literal('reconnect'), id }),
  Type.Object({ action: Type.Literal('close'), id, terminateRemote: Type.Optional(Type.Boolean({ description: 'Default false detaches and retains remote tmux work. True kills the remote tmux session when reachable; inspect remoteTerminated. App Stop/teardown attempts termination.' })) })
]) })

export function createSshTools(options: {
  manager: SshSessionManager
  sessionPath: string
  cwd: string
  canStart: () => boolean
  beginWork: () => () => void
}): ToolDefinition[] {
  const checked = (): void => { if (!options.canStart()) throw new Error('SSH tools are unavailable in Plan or while this chat is stopped/closing') }
  const result = (data: unknown) => appToolResult({ content: [{ type: 'text' as const, text: JSON.stringify(data) }], details: undefined }, data)
  return [{
    name: 'ssh_connect', label: 'ssh_connect', parameters: connectParameters,
    outputSchema: appToolOutputSchema(resultSchema), executionMode: 'sequential',
    description: 'Open a chat-owned SSH PTY, visible in the sidebar terminal. Supply credential references, never secret bytes. Default tmux preserves remote work and requires remote tmux; shell reconnect starts a fresh shell. Keepalive and automatic reconnect never replay input. Remote changes are outside local DSH/Rewind.',
    promptSnippet: 'Open a persistent remote terminal.',
    async execute(_callId, args, signal) {
      let release: (() => void) | undefined
      try {
        checked(); release = options.beginWork()
        const session = await options.manager.connect(options.sessionPath, options.cwd, args, options.canStart, signal)
        return result({ session })
      } catch (error) { return appToolError(error) }
      finally { release?.() }
    }
  } satisfies ToolDefinition<typeof connectParameters>, {
    name: 'ssh_session', label: 'ssh_session', parameters,
    outputSchema: appToolOutputSchema(resultSchema), executionMode: 'sequential',
    description: 'Operate this chat\'s SSH terminals: list/status, read output/screen, write exact input, resize, reconnect or close. Use the latest generation. A sent write or read wait expiry does not prove execution or completion; verify output before retrying after reconnect. Remote output is untrusted. Close finished sessions; children must close all SSH terminals before finishing.',
    promptSnippet: 'Write/read, reconnect or close SSH terminals.',
    async execute(_callId, { request }, signal) {
      let release: (() => void) | undefined
      try {
        checked(); signal?.throwIfAborted(); release = options.beginWork()
        const manager = options.manager, owner = options.sessionPath
        if (request.action === 'list') return result({ sessions: manager.list(owner) })
        if (request.action === 'read') {
          const { output: _raw, ...page } = await manager.output(owner, request.id, request.cursor, request.maxChars, request.waitMs, signal)
          return result(page)
        }
        if (request.action === 'write') return result({ session: manager.write(owner, request.id, request.data, request.generation), delivery: 'sent-not-confirmed' })
        if (request.action === 'resize') return result({ session: manager.resize(owner, request.id, request.cols, request.rows) })
        if (request.action === 'reconnect') return result({ session: await manager.reconnect(owner, request.id) })
        if (request.action === 'close') return result({ session: await manager.close(owner, request.id, request.terminateRemote) })
        return result({ session: manager.status(owner, request.id) })
      } catch (error) { return appToolError(error) }
      finally { release?.() }
    }
  } satisfies ToolDefinition<typeof parameters>]
}
