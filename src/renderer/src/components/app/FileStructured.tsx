import { useEffect, useState } from 'react'
import { useI18n } from '@/i18n'
import { LoaderCircle } from '@/lib/icons'
import { JsonTree } from './FileJson'
import type { StructuredFormat, StructuredResult } from '../../../../shared/file-preview'

export function FileStructured({ text, format, truncated }: { text: string; format: StructuredFormat; truncated: boolean }) {
  const { t } = useI18n()
  const [parsed, setParsed] = useState<{ text: string; format: StructuredFormat; truncated: boolean; result: StructuredResult } | null>(null)
  useEffect(() => {
    const worker = new Worker(new URL('../../lib/structured-worker.ts', import.meta.url), { type: 'module' })
    const timer = window.setTimeout(() => { worker.terminate(); setParsed({ text, format, truncated, result: { error: 'tooLarge' } }) }, 10000)
    worker.onmessage = ({ data }: MessageEvent<StructuredResult>) => { window.clearTimeout(timer); setParsed({ text, format, truncated, result: data }); worker.terminate() }
    worker.onerror = event => { event.preventDefault(); window.clearTimeout(timer); setParsed({ text, format, truncated, result: { error: 'invalid' } }); worker.terminate() }
    worker.postMessage({ text, format, truncated })
    return () => { window.clearTimeout(timer); worker.terminate() }
  }, [text, format, truncated])
  const result = parsed?.text === text && parsed.format === format && parsed.truncated === truncated ? parsed.result : null
  if (!result) return <div role="status" className="flex min-h-0 flex-1 items-center justify-center gap-2 p-5 text-xs text-muted-foreground"><LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" />{t('files.loading')}</div>
  if ('error' in result) return <div data-file-structured-invalid role="status" className="flex min-h-0 flex-1 items-center justify-center p-5 text-center text-xs text-muted-foreground">{t(result.error === 'tooLarge' ? 'files.structured.tooLarge' : result.line ? 'files.structured.invalidLine' : 'files.structured.invalid', { line: result.line ?? 0 })}</div>
  return <div data-file-structured={format} className="flex min-h-0 flex-1 flex-col">
    <JsonTree value={result.value} />
    {result.truncated ? <p role="status" className="shrink-0 border-t border-border/40 px-3 py-2 text-xs text-muted-foreground">{t('files.structured.records', { count: result.records ?? 0 })}</p> : null}
  </div>
}
