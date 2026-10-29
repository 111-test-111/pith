/** The library's archive contains immutable copies; source paths are provenance. */
export type LibraryKind = 'image' | 'file' | 'web'
export type LibrarySource = 'attachment' | 'present' | 'tool-image' | 'download' | 'search' | 'fetch' | 'browser' | 'link'
export type LibraryStorage = 'saved' | 'metadata' | 'limit' | 'missing' | 'failed' | 'invalid'
export type LibraryImageLabel = 'attachment' | 'generated' | 'screenshot' | 'tool'

export const LIBRARY_DEFAULT_MAX_BYTES = 2 * 1024 ** 3
export const LIBRARY_MIN_MAX_BYTES = 1024 ** 2
export const LIBRARY_MAX_MAX_BYTES = 1024 ** 4

export interface LibraryPreferences {
  enabled: boolean
  /** Null selects the private application-data archive. */
  directory: string | null
  maxBytes: number
}
export const DEFAULT_LIBRARY_PREFERENCES: LibraryPreferences = {
  enabled: true, directory: null, maxBytes: LIBRARY_DEFAULT_MAX_BYTES
}

export function normalizeLibraryPreferences(value: unknown): LibraryPreferences {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
    directory: typeof input.directory === 'string' && input.directory.length <= 4096 && !input.directory.includes('\0')
      && /^(?:\/|[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/i.test(input.directory) ? input.directory : null,
    maxBytes: typeof input.maxBytes === 'number' && Number.isSafeInteger(input.maxBytes)
      && input.maxBytes >= LIBRARY_MIN_MAX_BYTES && input.maxBytes <= LIBRARY_MAX_MAX_BYTES
      ? input.maxBytes : LIBRARY_DEFAULT_MAX_BYTES
  }
}

export interface LibraryItem {
  id: string
  kind: LibraryKind
  source: LibrarySource
  name: string
  description: string
  timestamp: number
  project: string | null
  sessionId: string
  sessionPath: string
  sessionTitle: string
  entryId: string
  toolName?: string
  /** Inline images often have no persisted filename. Render a localized source
   * label instead of presenting a synthetic filename as the original name. */
  imageLabel?: LibraryImageLabel
  imageNumber?: number
  /** Stored before publication, so image decode never controls gallery layout. */
  imageWidth?: number
  imageHeight?: number
  originalPath?: string
  url?: string
  query?: string
  /** A bounded source excerpt, never executable HTML. */
  excerpt?: string
  storage: LibraryStorage
  size: number
  /** Resolved by main from a content-addressed object, never provided by UI. */
  archivedPath?: string
}

export const LIBRARY_WEB_SNAPSHOT_SCHEMA = 'pith-web-source-v1'
/** A self-contained JSON source record. An empty excerpt means the tool
 * supplied a reference without returned text, not an offline page copy. */
export interface LibraryWebSnapshot {
  schema: typeof LIBRARY_WEB_SNAPSHOT_SCHEMA
  id: string
  title: string
  url?: string
  query?: string
  excerpt: string
  capturedAt: string | null
  source: LibrarySource
  toolName?: string
  provenance: {
    project: string | null
    sessionId: string
    sessionPath: string
    sessionTitle: string
    entryId: string
  }
}

export interface LibraryQuery {
  kind?: LibraryKind
  /** Undefined: every project; null: projectless. */
  project?: string | null
  query?: string
  /** Hide local records without a copy; web records with a URL remain usable. */
  hideUnavailable?: boolean
  before?: { timestamp: number; id: string }
  limit?: number
}
export interface LibraryPage {
  items: LibraryItem[]
  next: LibraryQuery['before'] | null
  total: number
}
export interface LibraryStatus {
  preferences: LibraryPreferences
  directory: string
  usedBytes: number
  total: number
  unsaved: number
  projects: { path: string | null; count: number }[]
  scanning: boolean
  scanErrors: number
  lastScanAt: number | null
}

export type LibraryResult<T> = { ok: true; value: T } | { ok: false; code: 'unavailable' | 'invalid' | 'directory' | 'missing' }
export interface LibrarySettingsUpdate { enabled?: boolean; maxBytes?: number }
/** A small, decoded excerpt of the retained copy, never a complete document. */
export interface LibraryTextPreview { text: string; truncated: boolean }

/** Owner information also covers child and scheduled sessions. */
export interface LibrarySession {
  id: string
  path: string
  cwd: string | null
  /** Internal resolver for projectless artifacts; never a project label. */
  workspace?: string
  title: string
}
