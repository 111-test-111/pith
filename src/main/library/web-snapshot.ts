import { LIBRARY_WEB_SNAPSHOT_SCHEMA, type LibraryItem, type LibraryWebSnapshot } from '../../shared/library'

/** Serialize only the collected source fields, never raw tool arguments,
 * request headers, credentials or arbitrary result objects. */
export function libraryWebSnapshotBytes(item: Omit<LibraryItem, 'storage' | 'size' | 'archivedPath'>): Buffer {
  const capturedAt = new Date(item.timestamp)
  const snapshot: LibraryWebSnapshot = {
    schema: LIBRARY_WEB_SNAPSHOT_SCHEMA,
    id: item.id,
    title: item.name,
    ...(item.url ? { url: item.url } : {}),
    ...(item.query ? { query: item.query } : {}),
    excerpt: item.excerpt?.slice(0, 16_384) ?? '',
    capturedAt: Number.isFinite(capturedAt.getTime()) ? capturedAt.toISOString() : null,
    source: item.source,
    ...(item.toolName ? { toolName: item.toolName } : {}),
    provenance: {
      project: item.project,
      sessionId: item.sessionId,
      sessionPath: item.sessionPath,
      sessionTitle: item.sessionTitle,
      entryId: item.entryId
    }
  }
  return Buffer.from(JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
}
