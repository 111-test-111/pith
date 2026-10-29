import { memo, useState, type ReactNode } from 'react'
import { Button } from '@/components/motion/button'
import { Download, Eye, SquareArrowOutUpRight } from '@/lib/icons'
import { basename, formatBytes } from '@/lib/format'
import { useFileNavigation } from '@/lib/file-navigation'
import { useI18n } from '@/i18n'
import type { PresentedFile } from '../../../../shared/types'
import { FileTypeIcon } from './FileTypeIcon'
import { ImageGenerationResult } from './ImageGenerationResult'
import { useImageReplays } from '@/lib/image-replays'
import type { ImageReplayRecord } from '../../../../shared/image-replay'
import { ImagePreviewGroup, type PreviewImage } from './ImagePreview'
import { generationPreviewImages } from '@/lib/image-preview-images'

const PresentedFileCard = memo(function PresentedFileCard({ file }: { file: PresentedFile }) {
  const { t } = useI18n()
  const navigation = useFileNavigation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const save = async () => {
    setBusy(true); setError(false)
    try { setError((await window.pi.saveFileCopy(file.path)).status === 'error') }
    catch { setError(true) }
    finally { setBusy(false) }
  }
  const open = async () => {
    setError(false)
    try { setError(Boolean(await window.pi.openPath(file.path))) }
    catch { setError(true) }
  }
  return <div data-presented-file={file.path} className="min-w-0 rounded-card border border-border bg-background p-3">
    <div className="flex min-w-0 items-center gap-2">
      <FileTypeIcon path={file.path} variant="card" className="shrink-0" />
      <span className="min-w-0 flex-1 truncate px-1 text-sm" title={file.path}>{basename(file.path)}</span>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatBytes(file.size)}</span>
    </div>
    {file.description ? <p className="mt-1 break-words text-sm text-muted-foreground">{file.description}</p> : null}
    <div className="mt-2 flex items-center justify-end gap-1">
      <Button size="sm" variant="ghost" onClick={() => void open()} aria-label={t('present.open')}><SquareArrowOutUpRight className="size-3.5" />{t('present.open')}</Button>
      <Button size="sm" variant="ghost" onClick={() => void save()} disabled={busy} aria-label={t('present.save')}><Download className="size-3.5" />{t('present.save')}</Button>
      <Button size="sm" variant="ghost" onClick={() => navigation.openPath(file.path)} aria-label={t('present.preview', { name: basename(file.path) })}><Eye className="size-3.5" />{t('present.previewAction')}</Button>
    </div>
    {error ? <p role="alert" className="mt-1 text-xs text-destructive">{t('present.error')}</p> : null}
  </div>
})

export const PresentedFiles = memo(function PresentedFiles({ files }: { files: PresentedFile[] }) {
  const { t } = useI18n()
  const replays = useImageReplays()
  const groups = new Map<string, PresentedFile[]>()
  for (const file of files) if (file.generation) {
    const group = groups.get(file.generation.id) ?? []
    group.push(file); groups.set(file.generation.id, group)
  }
  const seen = new Set<string>()
  const blocks: ReactNode[] = []
  const previews: PreviewImage[] = []
  let gallery: ReactNode[] = []
  const flushGallery = () => {
    if (!gallery.length) return
    blocks.push(<div key={`images-${blocks.length}`} className="flex min-w-0 flex-wrap items-start gap-4">{gallery}</div>)
    gallery = []
  }
  for (const file of files) {
    if (!file.generation) {
      flushGallery()
      blocks.push(<PresentedFileCard key={file.path} file={file} />)
      continue
    }
    const generation = file.generation
    if (seen.has(generation.id)) continue
    seen.add(generation.id)
    const group = groups.get(generation.id)!
    const replayMap = new Map<string, ImageReplayRecord[]>()
    for (const item of replays?.items ?? []) if (item.generationId === generation.id) {
      const history = replayMap.get(item.sourcePath) ?? []
      history.push(item); replayMap.set(item.sourcePath, history)
    }
    const result = { ...generation.result, files: group.map(delivered => delivered.generation!.result.files.find(image => image.path === delivered.path)!) }
    previews.push(...generationPreviewImages({ files: result.files, savedFiles: true, replays: replayMap,
      imageLabel: index => t('chat.imageAlt', { index: index + 1 }) }))
    gallery.push(<div key={generation.id} data-presented-generation={generation.id} className="contents">
      <ImageGenerationResult call={{ type: 'toolCall', name: 'image', id: generation.id,
        arguments: { aspect_ratio: generation.aspectRatio } }}
        result={{ role: 'toolResult', toolName: 'image', toolCallId: generation.id, content: [], details: result,
          isError: Boolean(result.error), timestamp: 0 }}
        images={[]} output="" savedFiles groupedPreview={false} replays={replayMap} retryDisabled={!replays || replays.disabled}
        onCancel={replay => replays?.cancel(replay)}
        onRetry={(image, restoreId) => replays?.retry(group.find(delivered => delivered.path === image.path)!, restoreId)} />
    </div>)
  }
  flushGallery()
  return <ImagePreviewGroup images={previews}><section data-presented-files className="w-full space-y-2">
    <p className="text-xs font-medium text-muted-foreground">{t('present.title', { count: files.length })}</p>
    {blocks}
  </section></ImagePreviewGroup>
})
