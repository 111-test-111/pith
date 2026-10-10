import type { PreviewError } from '../../shared/file-preview'
export class PreviewFailure extends Error {
  constructor(readonly code: PreviewError) { super(code) }
}
export const previewError = (error: unknown): PreviewError => error instanceof PreviewFailure ? error.code
  : (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'invalid'
