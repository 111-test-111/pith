import type { GitErrorCode, GitResult } from '../../shared/git'

export class GitFailure extends Error {
  constructor(readonly code: GitErrorCode, readonly detail?: string) { super(code) }
}
export async function gitResult<T>(operation: () => Promise<T>): Promise<GitResult<T>> {
  try { return { ok: true, value: await operation() } }
  catch (error) {
    if (error instanceof GitFailure) return { ok: false, code: error.code, ...(error.detail ? { detail: error.detail.slice(0, 8192) } : {}) }
    return { ok: false, code: 'command', detail: error instanceof Error ? error.message.slice(0, 8192) : undefined }
  }
}
