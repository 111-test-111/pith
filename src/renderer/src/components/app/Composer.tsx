import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent
} from 'react'
import { FileText, ImagePlus, Loader2, Paperclip, Undo2, X } from 'lucide-react'
import { PromptInput } from '@/components/agents/prompt-input'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { basename, formatBytes } from '@/lib/format'
import {
  otherBehavior,
  useStreamingBehavior,
  type StreamingBehavior
} from '@/lib/streaming-behavior'
import type {
  ContextUsageDTO,
  FileHitDTO,
  ImageContent,
  ModelDTO,
  ThinkingLevel
} from '../../../../shared/types'
import { FileMention, type MentionState } from './FileMention'
import { ModelPicker } from './ModelPicker'
import { ContextRing } from './ContextRing'
import { useI18n } from '@/i18n'

export interface ImageAttachment {
  id: string
  name: string
  dataUrl: string
  image: ImageContent
}

export interface FileAttachment {
  id: string
  path: string
  relPath: string
  kind: FileHitDTO['kind']
  size: number
}

/** Pending steer / follow-up messages of the open session (SDK queue state). */
export interface QueuedMessages {
  steering: string[]
  followUp: string[]
}

interface ComposerProps {
  models: ModelDTO[]
  model: ModelDTO | null
  thinkingLevel: ThinkingLevel
  /** Levels the current model supports; the cycle button only walks these. */
  availableThinkingLevels: ThinkingLevel[]
  busy: boolean
  contextUsage?: ContextUsageDTO | null
  queued: QueuedMessages
  onSend: (payload: { text: string; images: ImageContent[]; files: string[] }) => void
  /** Queue the draft against the running turn — steer interrupts before the
   * next model call, followUp waits for the run to finish. */
  onQueue: (payload: {
    text: string
    images: ImageContent[]
    files: string[]
    streamingBehavior: StreamingBehavior
  }) => void
  /** Clear the session's queues; resolves with the recalled texts. */
  onRecallQueue: () => Promise<string[]>
  onStop: () => void
  onModelChange: (model: ModelDTO) => void
  onThinkingLevelChange: (level: ThinkingLevel) => void
}

let attachmentSeq = 0
const nextId = () => `att-${Date.now()}-${attachmentSeq++}`

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

export function Composer({
  models,
  model,
  thinkingLevel,
  availableThinkingLevels,
  busy,
  contextUsage,
  queued,
  onSend,
  onQueue,
  onRecallQueue,
  onStop,
  onModelChange,
  onThinkingLevelChange
}: ComposerProps) {
  const { t } = useI18n()
  const [behavior] = useStreamingBehavior()
  const [value, setValue] = useState('')
  const [images, setImages] = useState<ImageAttachment[]>([])
  const [files, setFiles] = useState<FileAttachment[]>([])
  const [mention, setMention] = useState<MentionState | null>(null)
  const [mentionHits, setMentionHits] = useState<FileHitDTO[]>([])
  const [mentionLoading, setMentionLoading] = useState(false)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const debounceRef = useRef<number>(0)

  const addImageFile = useCallback((file: globalThis.File) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      setImages((current) => [
        ...current,
        {
          id: nextId(),
          name: file.name,
          dataUrl,
          image: { type: 'image', data: base64, mimeType: file.type || 'image/png' }
        }
      ])
    }
    reader.readAsDataURL(file)
  }, [])

  const addFileHit = useCallback((hit: FileHitDTO) => {
    setFiles((current) =>
      current.some((f) => f.path === hit.path)
        ? current
        : [...current, { id: nextId(), path: hit.path, relPath: hit.relPath, kind: hit.kind, size: hit.size }]
    )
  }, [])

  const removeImage = (id: string) => setImages((c) => c.filter((a) => a.id !== id))
  const removeFile = (id: string) => {
    const target = files.find((f) => f.id === id)
    setFiles((c) => c.filter((a) => a.id !== id))
    if (target) {
      setValue((v) => v.replace(`@${target.relPath}`, '').replace(/ {2,}/g, ' ').trimStart())
    }
  }

  // ---- @mention detection -------------------------------------------------
  const detectMention = useCallback((next: string, caret: number) => {
    const before = next.slice(0, caret)
    const match = /(^|\s)@([^\s@]{0,80})$/.exec(before)
    if (!match) {
      setMention(null)
      return
    }
    setMention({ query: match[2], triggerIndex: caret - match[2].length - 1 })
  }, [])

  useEffect(() => {
    if (!mention) return
    window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(async () => {
      setMentionLoading(true)
      try {
        const hits = await window.pi.searchFiles(mention.query)
        setMentionHits(hits)
        setMentionIndex(0)
      } finally {
        setMentionLoading(false)
      }
    }, 120)
    return () => window.clearTimeout(debounceRef.current)
  }, [mention])

  const selectMention = (hit: FileHitDTO) => {
    if (!mention) return
    const textarea = textareaRef.current
    const caret = textarea?.selectionStart ?? value.length
    const start = mention.triggerIndex
    const nextValue = `${value.slice(0, start)}@${hit.relPath} ${value.slice(caret)}`
    setValue(nextValue)
    setMention(null)
    addFileHit(hit)
    requestAnimationFrame(() => {
      const pos = start + hit.relPath.length + 2
      textarea?.focus()
      textarea?.setSelectionRange(pos, pos)
    })
  }

  // ---- submit ---------------------------------------------------------------
  /** Send when idle; queue against the running turn when busy. The behavior
   * override is how Cmd/Ctrl+Enter submits the inverse of the preference. */
  const dispatch = (sendBehavior: StreamingBehavior) => {
    const text = value.trim()
    if (!text && !images.length && !files.length) return
    const payload = {
      text,
      images: images.map((a) => a.image),
      files: files.map((f) => f.path)
    }
    if (busy) onQueue({ ...payload, streamingBehavior: sendBehavior })
    else onSend(payload)
    setValue('')
    setImages([])
    setFiles([])
    setMention(null)
  }

  const handleRecall = async () => {
    const texts = await onRecallQueue()
    if (!texts.length) return
    // Mirrors pi's queue restore: recalled text first, then the draft.
    setValue((current) => (current ? `${texts.join('\n\n')}\n\n${current}` : texts.join('\n\n')))
    setMention(null)
    textareaRef.current?.focus()
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mentionHits.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMentionIndex((i) => (i + 1) % mentionHits.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionIndex((i) => (i - 1 + mentionHits.length) % mentionHits.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        selectMention(mentionHits[mentionIndex])
        return
      }
      if (event.key === 'Escape') {
        setMention(null)
        return
      }
    }
    // While busy, Cmd/Ctrl+Enter queues with the inverse of the preferred
    // behavior. preventDefault keeps PromptInput's own Enter submit away.
    if (
      busy &&
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault()
      dispatch(otherBehavior(behavior))
    }
  }

  const handleChange = (next: string) => {
    setValue(next)
    const caret = textareaRef.current?.selectionStart ?? next.length
    detectMention(next, caret)
  }

  // ---- paste & drag/drop --------------------------------------------------
  const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData.files)
    const imgs = pasted.filter((f) => f.type.startsWith('image/'))
    if (imgs.length) {
      event.preventDefault()
      imgs.forEach(addImageFile)
    }
  }

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragOver(false)
    const dropped = Array.from(event.dataTransfer.files)
    dropped.filter((f) => f.type.startsWith('image/')).forEach(addImageFile)
  }

  // ---- queued messages ----------------------------------------------------
  const queuedCount = queued.steering.length + queued.followUp.length
  const queuedRows = [
    ...queued.steering.map((text, index) => ({ kind: 'steer' as const, text, key: `steer-${index}` })),
    ...queued.followUp.map((text, index) => ({ kind: 'followUp' as const, text, key: `followUp-${index}` }))
  ]

  return (
    <div className="shrink-0 border-t border-border bg-background p-3">
      <div className="relative mx-auto w-full max-w-3xl" onDragOver={(e) => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop}>
        {mention ? (
          <FileMention
            hits={mentionHits}
            loading={mentionLoading}
            activeIndex={mentionIndex}
            onActiveIndexChange={setMentionIndex}
            onSelect={selectMention}
            onClose={() => setMention(null)}
          />
        ) : null}

        {queuedCount > 0 ? (
          <div className="mb-2 rounded-xl border border-dashed border-border/80 bg-muted/30">
            <div className="flex items-center justify-between gap-2 pl-3 pr-1.5 pt-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t('composer.queuedTitle', { count: queuedCount })}
              </span>
              <Tooltip content={t('composer.recallQueueTitle')} side="top">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-foreground"
                  aria-label={t('composer.recallQueue')}
                  onClick={() => void handleRecall()}
                >
                  <Undo2 className="size-3.5" />
                </Button>
              </Tooltip>
            </div>
            <div className="space-y-1 px-3 pb-2 pt-1">
              {queuedRows.map((row) => (
                <div key={row.key} className="flex min-w-0 items-center gap-2 text-xs" title={row.text}>
                  <span
                    className={
                      row.kind === 'steer'
                        ? 'shrink-0 rounded-full border border-primary/40 bg-primary/10 px-1.5 py-px font-medium text-primary'
                        : 'shrink-0 rounded-full border border-border bg-muted px-1.5 py-px font-medium text-muted-foreground'
                    }
                  >
                    {t(row.kind === 'steer' ? 'composer.badgeSteer' : 'composer.badgeFollowUp')}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">{row.text}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {images.length || files.length ? (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {images.map((attachment) => (
              <span key={attachment.id} className="group relative">
                <img
                  src={attachment.dataUrl}
                  alt={attachment.name}
                  className="h-14 w-14 rounded-xl border border-border object-cover"
                />
                <button
                  type="button"
                  aria-label={t('workspace.removeAttachment', { name: attachment.name })}
                  onClick={() => removeImage(attachment.id)}
                  className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full bg-foreground text-background opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {files.map((attachment) => (
              <span
                key={attachment.id}
                className="group inline-flex max-w-56 items-center gap-1.5 rounded-xl border border-border bg-card px-2 py-1.5 text-xs text-foreground"
                title={`${attachment.relPath} · ${formatBytes(attachment.size)}`}
              >
                <FileText className="size-3.5 shrink-0 text-primary" />
                <span className="truncate">{basename(attachment.relPath)}</span>
                <button
                  type="button"
                  aria-label={t('workspace.removeAttachment', { name: attachment.relPath })}
                  onClick={() => removeFile(attachment.id)}
                  className="grid size-4 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div
          className={dragOver ? 'rounded-2xl ring-2 ring-primary/60 transition-shadow' : 'transition-shadow'}
        >
          <PromptInput
            value={value}
            onValueChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            loading={busy}
            onStop={onStop}
            onSubmit={() => dispatch(behavior)}
            onQueueSubmit={() => dispatch(behavior)}
            maxRows={8}
            placeholder={
              busy
                ? t(behavior === 'steer' ? 'composer.hintSteer' : 'composer.hintFollowUp', {
                    modifier: IS_MAC ? '⌘' : 'Ctrl'
                  })
                : t('composer.placeholder')
            }
            leadingAction={
              <ModelPicker
                models={models}
                value={model ? `${model.providerId}/${model.id}` : null}
                thinkingLevel={thinkingLevel}
                availableThinkingLevels={availableThinkingLevels}
                onChange={onModelChange}
                onThinkingLevelChange={onThinkingLevelChange}
                disabled={busy}
              />
            }
            contextIndicator={<ContextRing usage={contextUsage ?? null} />}
            actions={[
              {
                value: 'attach-image',
                label: t('composer.attachImage'),
                description: t('composer.attachImageDesc'),
                icon: <ImagePlus />
              },
              {
                value: 'attach-file',
                label: t('composer.attachFile'),
                description: t('composer.attachFileDesc'),
                icon: <Paperclip />
              }
            ]}
            onAction={(action) => {
              if (action === 'attach-image') imageInputRef.current?.click()
              else if (action === 'attach-file') fileInputRef.current?.click()
            }}
          />
        </div>

        {dragOver ? (
          <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-2xl bg-background/70 text-sm font-medium text-primary">
            {t('composer.dropImages')}
          </div>
        ) : null}

        {mentionLoading ? (
          <Loader2 className="absolute right-3 top-3 size-3.5 animate-spin text-muted-foreground" />
        ) : null}

        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            Array.from(event.target.files ?? []).forEach(addImageFile)
            event.target.value = ''
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          hidden
          onChange={async (event) => {
            const picked = Array.from(event.target.files ?? [])
            for (const file of picked) {
              // Resolve absolute paths through the main process file index.
              const hits = await window.pi.searchFiles(file.name)
              const hit = hits.find((h) => h.name === file.name) ?? hits[0]
              if (hit) addFileHit(hit)
            }
            event.target.value = ''
          }}
        />
      </div>
    </div>
  )
}
