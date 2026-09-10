import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent
} from 'react'
import { FileText, ImagePlus, Loader2, Paperclip, X, Brain } from 'lucide-react'
import { PromptInput } from '@/components/agents/prompt-input'
import { basename, formatBytes } from '@/lib/format'
import type {
  FileHitDTO,
  ImageContent,
  ModelDTO,
  ThinkingLevel
} from '../../../../shared/types'
import { FileMention, type MentionState } from './FileMention'
import { ModelPicker } from './ModelPicker'
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

interface ComposerProps {
  models: ModelDTO[]
  model: ModelDTO | null
  thinkingLevel: ThinkingLevel
  busy: boolean
  onSend: (payload: { text: string; images: ImageContent[]; files: string[] }) => void
  onStop: () => void
  onModelChange: (model: ModelDTO) => void
  onThinkingLevelChange: (level: ThinkingLevel) => void
}

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high']

let attachmentSeq = 0
const nextId = () => `att-${Date.now()}-${attachmentSeq++}`

export function Composer({
  models,
  model,
  thinkingLevel,
  busy,
  onSend,
  onStop,
  onModelChange,
  onThinkingLevelChange
}: ComposerProps) {
  const { t } = useI18n()
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

  // ---- submit ---------------------------------------------------------------
  const submit = () => {
    const text = value.trim()
    if ((!text && !images.length && !files.length) || busy) return
    onSend({
      text,
      images: images.map((a) => a.image),
      files: files.map((f) => f.path)
    })
    setValue('')
    setImages([])
    setFiles([])
    setMention(null)
  }

  const cycleThinking = () => {
    const index = THINKING_LEVELS.indexOf(thinkingLevel)
    onThinkingLevelChange(THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length])
  }

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
            onSubmit={submit}
            maxRows={8}
            placeholder={t('composer.placeholder')}
            leadingAction={
              <ModelPicker
                models={models}
                value={model ? `${model.providerId}/${model.id}` : null}
                onChange={onModelChange}
                disabled={busy}
              />
            }
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
              },
              {
                value: 'thinking',
                label: t('composer.thinkingLevel', { level: thinkingLevel }),
                description: t('composer.thinkingDesc'),
                icon: <Brain />
              }
            ]}
            onAction={(action) => {
              if (action === 'attach-image') imageInputRef.current?.click()
              else if (action === 'attach-file') fileInputRef.current?.click()
              else if (action === 'thinking') cycleThinking()
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

