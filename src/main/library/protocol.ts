import type { LibraryKind, LibraryPreferences, LibraryQuery, LibrarySession } from '../../shared/library'
import type { LibraryCandidate } from './extract'

export type LibraryCommand =
  | { type: 'page'; query: LibraryQuery }
  | { type: 'status' }
  | { type: 'scan'; force?: boolean }
  | { type: 'session'; path: string }
  | { type: 'collect'; candidates: LibraryCandidate[] }
  | { type: 'message'; session: LibrarySession; entryId: string; message: unknown; call?: { name: string; args: unknown } }
  | { type: 'nested'; session: LibrarySession; callId: string; name: string; args: unknown; result: unknown }
  | { type: 'configure'; preferences: LibraryPreferences; directory: string }
  | { type: 'delete'; id: string }
  | { type: 'clear'; kind: LibraryKind }
  | { type: 'file'; id: string }
  | { type: 'preview-text'; id: string }
  | { type: 'close' }

export interface LibraryWorkerOptions {
  databasePath: string
  sessionsDir: string
  defaultWorkspace: string
  directory: string
  defaultDirectory: string
  preferences: LibraryPreferences
}
