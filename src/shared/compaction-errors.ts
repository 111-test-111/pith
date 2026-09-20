/**
 * Shared error marker for "manual compaction was requested but there is not
 * enough context to summarize". The SDK uses this exact message when
 * `prepareCompaction()` returns `undefined` because everything fits within
 * `keepRecentTokens`.
 *
 * Both the main-process pre-flight check and the renderer's post-failure
 * handling match against this string so they stay consistent.
 */
export const NOTHING_TO_COMPACT_MESSAGE = 'Nothing to compact (session too small)'

/**
 * Test whether a thrown value or an error message represents the
 * nothing-to-compact case. This is intentionally loose so it matches:
 * - the SDK's raw `Error('Nothing to compact (session too small)')`,
 * - the renderer's IPC-wrapped error text, and
 * - the SDK's `compaction_end` `errorMessage` (`'Compaction failed: ...'`).
 */
export function isNothingToCompactError(error: unknown): boolean {
  const text = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : String(error ?? '')
  return text.includes(NOTHING_TO_COMPACT_MESSAGE)
}
