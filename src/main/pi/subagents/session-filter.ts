import { closeSync, openSync, readSync } from 'node:fs'

const SUBAGENT_RUN_MARKER = '"customType":"pith_subagent_run"'
/** The start entry is appended before the child's first prompt, so a bounded
 * head read always covers it. */
const HEAD_BYTES = 128 * 1024

/**
 * Cheap membership test for "this session file is a subagent child". The
 * sidebar must hide children (they surface through their parent's roster),
 * but forks ALSO carry `parentSessionPath` — only the persisted run marker
 * distinguishes them.
 */
export function isSubagentSessionFile(path: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return false
  }
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0)
    return buffer.subarray(0, read).includes(SUBAGENT_RUN_MARKER)
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}
