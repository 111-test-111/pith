/** SSH metadata/output have their own stream, never transcript eventSequence. */
export const SSH_TOOL_NAMES = ['ssh_connect', 'ssh_session'] as const
export type SshStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'failed' | 'closed'
export interface SshSessionDTO {
  id: string
  sessionPath: string
  host: string
  port: number
  username: string
  status: SshStatus
  persistence: 'tmux' | 'shell'
  remoteSession?: string
  fingerprint?: string
  generation: number
  revision: number
  reconnectAttempts: number
  cols: number
  rows: number
  outputChars: number
  startedAt: number
  error?: string
  /** True only after an acknowledged tmux kill-session. */
  remoteTerminated?: boolean
  /** Child/scheduled conversations have observation-only human panels. */
  readOnly?: boolean
}
export interface SshReference { sessionPath: string; id: string }
export interface SshOutputRequest extends SshReference { cursor?: number; maxChars?: number; waitMs?: number; snapshot?: boolean }
/** A bounded ANSI framebuffer and the exact parsed stream frontier it represents. */
export interface SshTerminalSnapshot { data: string; cursor: number; cols: number; rows: number }
export interface SshOutputDTO {
  session: SshSessionDTO
  /** ANSI stream for emulators; text and screen are readable model views. */
  output: string
  text: string
  screen: string
  /** Requested only by observation panes; never included in model tool reads. */
  snapshot?: SshTerminalSnapshot
  cursor: number
  startCursor: number
  truncated: boolean
  hasMore: boolean
}
export type SshEvent =
  | { type: 'state'; session: SshSessionDTO }
  | { type: 'data'; id: string; sessionPath: string; generation: number; data: string; startCursor: number; cursor: number }
export type SshPanelRequest = SshReference & (
  | { action: 'write'; data: string; generation: number; binary?: boolean }
  | { action: 'resize'; cols: number; rows: number }
  | { action: 'reconnect' }
  | { action: 'close'; terminateRemote?: boolean }
)
export type SshPanelResult = { session: SshSessionDTO } | { error: 'unavailable' | 'failed' }
