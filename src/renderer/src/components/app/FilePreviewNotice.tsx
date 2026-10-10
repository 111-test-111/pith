import { useI18n } from '@/i18n'
import { FileText, LoaderCircle } from '@/lib/icons'
import type { PreviewError } from '../../../../shared/file-preview'
export function FilePreviewNotice({ error, loading = false }: { error?: PreviewError; loading?: boolean }) {
  const { t } = useI18n()
  return <div data-file-preview-notice={error ?? 'loading'} role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5 text-center text-xs text-muted-foreground">
    {loading ? <LoaderCircle aria-hidden className="size-5 motion-safe:animate-spin" /> : <FileText aria-hidden className="size-5" />}
    {t(loading ? 'files.loading' : `files.previewError.${error ?? 'unreadable'}`)}
  </div>
}
