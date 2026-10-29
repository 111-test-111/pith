import { useId, useState } from 'react'
import { ImageGeneration, type ImageGenerationStatus } from '@/components/agents/image-generation'
import { Button } from '@/components/motion/button'
import { MorphPopover, MorphPopoverContent } from '@/components/motion/popover-morph'
import { useI18n } from '@/i18n'
import { basename, formatBytes } from '@/lib/format'
import { useFileNavigation } from '@/lib/file-navigation'
import { IMAGE_MAX_COUNT, parseImageToolResult } from '../../../../shared/image'
import type { GeneratedImageFile } from '../../../../shared/image'
import type { ImageReplayRecord } from '../../../../shared/image-replay'
import { mediaUrl } from '../../../../shared/media'
import { ChevronLeft, ChevronRight, Info, RotateCcw, Square, X } from '@/lib/icons'
import type { ImageContent, ToolCallContent, ToolResultMsg } from '../../../../shared/types'
import type { ToolRun } from '@/state/pi-store'
import { ImagePreviewGroup, PreviewThumb } from './ImagePreview'
import { generationPreviewImages } from '@/lib/image-preview-images'
import { LabelTooltip } from './LabelTooltip'
import { FileTypeIcon } from './FileTypeIcon'
import { FadeScroll } from './FadeScroll'

/** Pure media shares the beUI generation surface; its complete receipt opens
 * on demand and never changes thumbnail geometry or batch arrangement. */
export function ImageGenerationResult({ call, result, run, images, output, savedFiles = false, replays, onRetry, onCancel, retryDisabled = false, groupedPreview = true }: {
  call: ToolCallContent
  result?: ToolResultMsg
  run?: ToolRun
  images: ImageContent[]
  output: string
  savedFiles?: boolean
  replays?: ReadonlyMap<string, readonly ImageReplayRecord[]>
  onRetry?: (file: GeneratedImageFile, restoreId: string | null) => void
  onCancel?: (replay: ImageReplayRecord) => void
  retryDisabled?: boolean
  /** A delivery section supplies its complete collection across generations. */
  groupedPreview?: boolean
}) {
  const { t } = useI18n()
  const navigation = useFileNavigation()
  const [failed, setFailed] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState(0)
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [versions, setVersions] = useState<Record<string, { id: string | null; latestId: string | null }>>({})
  const infoId = useId()
  const details = parseImageToolResult(result?.details ?? run?.partial?.details)
  const active = !result && (!run || run.status === 'running')
  const error = Boolean(result?.isError || (!active && run?.status === 'error'))
  const status: ImageGenerationStatus = active ? (run?.startedAt ? 'generating' : 'queued') : error ? 'error' : 'complete'
  const args = call.arguments ?? {}
  const prompt = details?.prompt ?? (typeof args.prompt === 'string' ? args.prompt : '')
  const requestedRatio = typeof args.aspect_ratio === 'string' && /^\d+:\d+$/.test(args.aspect_ratio)
    ? args.aspect_ratio.replace(':', ' / ') : '1 / 1'
  const files = details?.files ?? []
  const requestedCount = typeof args.n === 'number' && Number.isInteger(args.n) && args.n >= 1 && args.n <= IMAGE_MAX_COUNT
    ? args.n : 1
  const count = Math.max(files.length, images.length, active ? requestedCount : 1)
  const tiles = Array.from({ length: count }, (_, index) => {
    const original = files[index]
    const history = original && replays?.get(original.path) || []
    const latest = history.at(-1)
    const latestId = latest?.id ?? null
    const cursor = original && versions[original.path]
    const rememberedIndex = cursor?.id ? history.findIndex(item => item.id === cursor.id) : -1
    const remembered = cursor && cursor.latestId === latestId
      ? cursor.id === null ? 0 : rememberedIndex < 0 ? -1 : rememberedIndex + 1 : -1
    const versionIndex = remembered >= 0 ? remembered : history.length
    const replay = history[versionIndex - 1]
    const runningReplay = latest?.status === 'queued' || latest?.status === 'generating' ? latest : undefined
    const replayActive = replay?.status === 'queued' || replay?.status === 'generating'
    const file = replay ? replay.cancelled ? replay.previousResult?.files[0] ?? original
      : replay.status === 'complete' ? replay.result?.files[0] : undefined : original
    const receipt = replay ? replayActive ? undefined : replay.cancelled ? replay.previousResult ?? details : replay.result : details
    const ratioFile = file ?? replay?.previousResult?.files[0] ?? original
    const image = replay ? undefined : images[index]
    const src = savedFiles && file ? mediaUrl(file.path) : image ? `data:${image.mimeType};base64,${image.data}` : undefined
    const tileStatus: ImageGenerationStatus = replay ? replayActive ? replay.status : file ? 'complete' : 'error'
      : file || (image && !error) ? 'complete' : status
    const replayError = replay && !replay.cancelled && !replayActive && tileStatus === 'error'
      ? replay.interrupted ? t('imageGeneration.retryInterrupted') : replay.error ?? replay.result?.error ?? t('imageGeneration.error') : undefined
    return { original, replay, file, src, replayActive, receipt, ratioFile, replayError, history, versionIndex, latestId, runningReplay, status: tileStatus,
      label: file ? basename(file.path) : t('chat.imageAlt', { index: index + 1 }) }
  })
  const selection = tiles[selected]
  const closeInfo = () => { setInfoOpen(false); anchor?.focus({ preventScroll: true }) }
  const selectVersion = (index: number, next: number) => {
    const tile = tiles[index]
    if (!tile?.original || next < 0 || next > tile.history.length) return
    setInfoOpen(false)
    setVersions(previous => ({ ...previous, [tile.original!.path]: { id: tile.history[next - 1]?.id ?? null, latestId: tile.latestId } }))
  }
  const content = (
    <MorphPopover anchor={anchor} contentId={infoId} open={infoOpen && !!selection} onOpenChange={setInfoOpen}
      className="flex min-w-0 max-w-full flex-wrap items-start gap-4">
      <div data-image-result className="contents">
        {tiles.map((tile, index) => (
          <div key={tile.original?.path ?? index} data-image-tile data-image-file={tile.file?.path}
            data-image-version={tile.replay?.id ?? 'original'} data-image-history-count={tile.history.length + 1}
            className="group/generated-image relative w-52 min-w-0 max-w-full">
            <ImageGeneration layout="vertical" size="fluid" status={tile.status} showStatus={false}
              statusText={t(`imageGeneration.${tile.status}`)} label={tile.label}
              aspectRatio={tile.ratioFile?.width && tile.ratioFile.height ? `${tile.ratioFile.width} / ${tile.ratioFile.height}` : requestedRatio}
              resolution="" mediaClassName="[&_img]:object-contain">
              {tile.src && !failed.has(tile.src) ? (
                <div className="size-full" onClickCapture={() => setInfoOpen(false)}>
                  <PreviewThumb src={tile.src} alt={tile.label} path={tile.file?.path} className="size-full rounded-item" imageClassName="object-contain"
                    onError={() => setFailed(previous => new Set(previous).add(tile.src!))} />
                </div>
              ) : !active && !tile.replayActive && !tile.replayError ? (
                <div className="flex items-center justify-center p-4 text-center text-xs text-muted-foreground">{t('imageGeneration.previewUnavailable')}</div>
              ) : null}
            </ImageGeneration>
            {tile.replayError ? <div data-image-retry-error role="alert" className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden rounded-item p-4 text-center text-xs text-destructive">
              <div className="min-w-0 space-y-1">
                <p>{t('imageGeneration.error')}</p>
                {tile.replayError !== t('imageGeneration.error') ? <p className="line-clamp-3 break-words">{tile.replayError}</p> : null}
              </div>
            </div> : null}
            <div data-image-actions className="pointer-events-none absolute right-2 top-2 z-10 flex gap-0.5 rounded-control bg-background/90 p-0.5 text-foreground opacity-0 shadow-overlay group-hover/generated-image:pointer-events-auto group-hover/generated-image:opacity-100 group-focus-within/generated-image:pointer-events-auto group-focus-within/generated-image:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100">
              {tile.history.length ? <div data-image-history-actions className="flex min-w-0 items-center gap-0.5">
                <LabelTooltip content={t('imageGeneration.previousImage')}>
                  <Button variant="ghost" size="icon" className="size-7 text-foreground"
                    aria-label={t('imageGeneration.previousImage')} disabled={tile.versionIndex === 0}
                    onClick={() => selectVersion(index, tile.versionIndex - 1)}><ChevronLeft className="size-3.5" /></Button>
                </LabelTooltip>
                <span data-image-history-position aria-label={t('imageGeneration.historyPosition', { current: tile.versionIndex + 1, total: tile.history.length + 1 })}
                  className="px-1 text-micro tabular-nums">{tile.versionIndex + 1}/{tile.history.length + 1}</span>
                <LabelTooltip content={t('imageGeneration.nextImage')}>
                  <Button variant="ghost" size="icon" className="size-7 text-foreground"
                    aria-label={t('imageGeneration.nextImage')} disabled={tile.versionIndex === tile.history.length}
                    onClick={() => selectVersion(index, tile.versionIndex + 1)}><ChevronRight className="size-3.5" /></Button>
                </LabelTooltip>
              </div> : null}
              <LabelTooltip content={t('imageGeneration.info')}>
                <Button id={`${infoId}-${index}`} variant="ghost" size="icon" className="size-7 text-foreground"
                  aria-label={t('imageGeneration.imageInfo', { name: tile.label })} aria-haspopup="dialog"
                  aria-expanded={infoOpen && selected === index} aria-controls={infoId}
                  onClick={event => { setSelected(index); setAnchor(event.currentTarget); setInfoOpen(!infoOpen || selected !== index) }}>
                  <Info className="size-3.5" />
                </Button>
              </LabelTooltip>
              {onRetry && tile.original && !tile.runningReplay ? <LabelTooltip content={t('imageGeneration.retry')}>
                <Button variant="ghost" size="icon" className="size-7 text-foreground" disabled={retryDisabled}
                  aria-label={t('imageGeneration.retryImage', { name: tile.label })}
                  onClick={() => { setInfoOpen(false); onRetry(tile.original!, tile.replay?.id.startsWith('pending:') ? tile.replay.restoreId ?? null : tile.replay?.id ?? null) }}><RotateCcw className="size-3.5" /></Button>
              </LabelTooltip> : null}
              {onCancel && tile.runningReplay && !tile.runningReplay.id.startsWith('pending:') ? <LabelTooltip content={t('imageGeneration.cancelRetry')}>
                <Button variant="ghost" size="icon" className="size-7 text-foreground" aria-label={t('imageGeneration.cancelRetry')}
                  onClick={() => { selectVersion(index, tile.history.length); onCancel(tile.runningReplay!) }}><Square className="size-3.5" /></Button>
              </LabelTooltip> : null}
            </div>
          </div>
        ))}
      </div>
      <MorphPopoverContent side="right" align="start" className="w-[min(26rem,calc(100vw-2rem))]">
        {selection ? <FadeScroll data-image-information tabIndex={-1} className="max-h-[calc(100vh-2rem)] p-3 text-xs text-muted-foreground [overflow-wrap:anywhere]">
          <div className="space-y-3">
          <div className="flex items-start gap-2">
            {selection.file ? <FileTypeIcon path={selection.file.path} className="mt-0.5 shrink-0" /> : null}
            <div className="min-w-0 flex-1">
              {selection.file ? <Button variant="ghost" size="sm" className="h-auto max-w-full justify-start bg-transparent p-0 text-left text-sm font-medium text-foreground hover:bg-transparent"
                aria-label={t('review.openFile', { name: selection.label })} onClick={() => { closeInfo(); navigation.openPath(selection.file!.path) }}>
                <span className="break-words underline underline-offset-2">{selection.label}</span>
              </Button> : <p className="text-sm font-medium text-foreground">{t('imageGeneration.info')}</p>}
            </div>
            <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={t('imageGeneration.closeInfo')} onClick={closeInfo}><X className="size-4" /></Button>
          </div>
          <p>{t(`imageGeneration.${selection.status}`)}</p>
          {selection.history.length ? <p>{t('imageGeneration.historyPosition', { current: selection.versionIndex + 1, total: selection.history.length + 1 })}</p> : null}
          {selection.file ? <div className="space-y-1">
            <p className="break-all">{selection.file.path}</p>
            <p className="tabular-nums">{selection.file.width && selection.file.height ? `${selection.file.width} × ${selection.file.height} · ` : ''}{formatBytes(selection.file.size)} · {selection.file.mimeType}</p>
          </div> : null}
          {prompt ? <div className="space-y-1">
            <p className="font-medium text-foreground">{t('imageGeneration.prompt')}</p>
            <p data-image-prompt className="whitespace-pre-wrap">{prompt}</p>
          </div> : null}
          {selection.receipt ? <div className="space-y-1">
            <p>{selection.receipt.model}{selection.receipt.usage ? ` · ${t(selection.replay && !selection.replay.cancelled ? 'imageGeneration.retryCost' : 'imageGeneration.cost', { cost: `$${selection.receipt.usage.costUsd.toFixed(4)}` })}` : ''}</p>
            {selection.receipt.revisedPrompt ? <div className="space-y-1"><p className="font-medium text-foreground">{t('imageGeneration.revisedPrompt')}</p><p className="whitespace-pre-wrap">{selection.receipt.revisedPrompt}</p></div> : null}
            {selection.receipt.ignoredParameters?.length ? <p data-image-warning>{t('imageGeneration.ignored', {
              parameters: selection.receipt.ignoredParameters.map(key => t(`imageGeneration.parameter.${key}` as Parameters<typeof t>[0])).join(', ')
            })}</p> : null}
            {selection.receipt.renamed ? <p>{t('imageGeneration.renamed')}</p> : null}
            {selection.receipt.text ? <p className="whitespace-pre-wrap">{selection.receipt.text}</p> : null}
          </div> : null}
          {selection.replay?.cancelled ? <p>{t('imageGeneration.retryCancelled')}</p> : null}
          {selection.replayError ? <p role="alert" className="whitespace-pre-wrap text-destructive">{selection.replayError}</p> : null}
          {!selection.replay && (error || !details && !active) ? <p data-image-error={error || undefined} className="whitespace-pre-wrap text-destructive">
            {details?.error ?? (output || t('imageGeneration.error'))}
          </p> : null}
          </div>
        </FadeScroll> : null}
      </MorphPopoverContent>
    </MorphPopover>
  )
  return groupedPreview ? <ImagePreviewGroup images={generationPreviewImages({ files, images, savedFiles, replays,
    imageLabel: index => t('chat.imageAlt', { index: index + 1 }) }).filter(image => !failed.has(image.src))}>{content}</ImagePreviewGroup> : content
}
