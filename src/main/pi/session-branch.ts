import { open } from 'node:fs/promises'

/**
 * Tail window per read. The decisive entry is almost always the file's own
 * last one, so a single window answers an ordinary session; only a tail full
 * of non-message entries (model/thinking changes, change scopes) needs another.
 */
const TAIL_CHUNK_BYTES = 32 * 1024
/**
 * Fail-safe ceiling: past this much of a file without a decision the session is
 * listed. A wrongly hidden row is invisible and unreachable; a listed one still
 * opens.
 */
const MAX_SCAN_BYTES = 4 * 1024 * 1024
const NEWLINE = 0x0a

/** Data the app persists on its own `pith_rewind_selection` entry. */
export interface RewindSelectionData {
  operationId?: string
  target?: string | null
  /** Whether the selected branch held any visible conversation message when selected. */
  empty?: boolean
}

interface Selection {
  data?: RewindSelectionData
  message?: { role?: string }
  [key: string]: unknown
}

/**
 * Does the session's SELECTED branch hold a visible conversation message?
 *
 * `SessionManager.listAll()` counts every message entry in the file — abandoned
 * branches included — so a session restored to before its first turn kept its
 * sidebar row while its transcript was empty, and clicking it could only show a
 * new-chat page. The branch itself is only reachable through the parent chain,
 * and reading every session file a second time on every list refresh is not an
 * option, so the app's own rewind selection carries the fact: the newest
 * relevant entry decides. A message appended after that selection sits on the
 * selected branch; the selection's recorded emptiness decides otherwise.
 */
export async function selectedBranchHasMessages(path: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(path, 'r')
  } catch {
    return true
  }
  try {
    const { size } = await handle.stat()
    let window = Buffer.alloc(0)
    let offset = size
    while (offset > 0) {
      const read = Math.min(TAIL_CHUNK_BYTES, offset, MAX_SCAN_BYTES - window.length)
      if (read <= 0) return true
      offset -= read
      const chunk = Buffer.allocUnsafe(read)
      await handle.read(chunk, 0, read, offset)
      window = Buffer.concat([chunk, window])
      // Split the raw buffer on the newline BYTE, then decode each line on its
      // own: a multi-byte character can straddle a chunk boundary, a newline
      // cannot. The window's first line is cut whenever the file continues
      // before it, so it is skipped.
      const lines = splitLines(window)
      for (let index = lines.length - 1; index >= (offset > 0 ? 1 : 0); index--) {
        const decision = decisionOf(lines[index])
        if (decision !== undefined) return decision
      }
    }
    // The whole file holds no conversation message and no selection: nothing to show.
    return false
  } catch {
    return true
  } finally {
    await handle.close()
  }
}

/** `undefined` while the entry says nothing about the selected branch. */
function decisionOf(line: Buffer): boolean | undefined {
  const text = line.toString('utf8').trim()
  if (!text) return undefined
  let entry: Selection
  try {
    entry = JSON.parse(text) as Selection
  } catch {
    return undefined
  }
  if (entry?.type === 'message') return entry.message?.role === 'system' ? undefined : true
  if (entry?.type !== 'custom' || entry.customType !== 'pith_rewind_selection') return undefined
  if (entry.data?.empty === true) return false
  // A selection written before the branch fact was recorded still decides the
  // one case it can: a reset leaf means the branch IS the selection entry.
  return !(entry.data?.empty === undefined && entry.data?.target === null)
}

/** Newline-delimited JSONL lines, without decoding the whole window at once. */
function splitLines(buffer: Buffer): Buffer[] {
  const lines: Buffer[] = []
  let start = 0
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== NEWLINE) continue
    lines.push(buffer.subarray(start, index))
    start = index + 1
  }
  lines.push(buffer.subarray(start))
  return lines
}
