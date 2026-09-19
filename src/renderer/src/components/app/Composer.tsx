import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent
} from 'react'
import { Bot, FileText, ImagePlus, Loader2, Paperclip, X } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { ExpandableChip } from '@/components/motion/expandable-control'
import { PromptInput } from '@/components/agents/prompt-input'
import { basename, formatBytes } from '@/lib/format'
import { readImageAttachment, resolveAttachmentFile, type AttachmentTarget } from '@/lib/attachments'
import {
  otherBehavior,
  useStreamingBehavior,
  type StreamingBehavior
} from '@/lib/streaming-behavior'
import type {
  ContextUsageDTO,
  PlanStateDTO, SessionMode,
  FileHitDTO,
  ImageContent,
  ModelDTO,
  QueuedItemDTO,
  RecalledItemDTO,
  ThinkingLevel
} from '../../../../shared/types'
import { DEFAULT_SANDBOX_MODE, type SandboxMode, type SandboxStatusDTO, type SessionSnapshotDTO } from '../../../../shared/types'
import { FileMention, type MentionState } from './FileMention'
import { PreviewThumb } from './ImagePreview'
import { ModelPicker } from './ModelPicker'
import { SessionModePicker } from './SessionModePicker'
import { parsePlanCommand, planErrorKey } from '@/lib/plan-submissions'
import { SandboxModePicker } from './SandboxModePicker'
import { ContextRing } from './ContextRing'
import { QueuePanel } from './QueuePanel'
import { LabelTooltip } from './LabelTooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { NewSessionHeader, NewSessionSuggestions, type NewSessionContext } from './NewSession'
import { ShaderBackdrop } from './ShaderBackdrop'

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
  start?: NewSessionContext
  models: ModelDTO[]
  model: ModelDTO | null
  thinkingLevel: ThinkingLevel
  /** Levels the current model supports; the cycle button only walks these. */
  availableThinkingLevels: ThinkingLevel[]
  busy: boolean
  initializing?: boolean
  /** A read-only session view (an opened subagent child): typing and submit
   * are disabled — the child's runs are driven by its parent's runtime. */
  readOnly?: boolean
  /** Parent session file of a read-only child view, for the banner's action. */
  readOnlyParentPath?: string | null
  /** Open another session (the child banner's "open parent"). */
  onOpenSession?: (path: string) => void
  /** Escape stops the running turn. False while a full-page Settings or auth
   * overlay owns the surface, so Esc there does not abort a background run. */
  escapeStopsRun?: boolean
  contextUsage?: ContextUsageDTO | null
  /** Open the rail's context detail pane (the ring's click); omitted where no
   * rail exists, which leaves the ring a plain readout. */
  onOpenContext?: () => void
  /** This session's DSH file-sandbox mode, and what the host can enforce. */
  plan?: PlanStateDTO | null
  onPlanState?: (path: string, state: PlanStateDTO) => void
  sandboxMode?: SandboxMode
  sandbox?: SandboxStatusDTO | null
  sessionPath?: string | null
  /** Apply the snapshot a mode switch returns; the store owns that state. */
  onSandboxSnapshot?: (snapshot: SessionSnapshotDTO) => void
  queued: { steering: QueuedItemDTO[]; followUp: QueuedItemDTO[] }
  onSend: (payload: { text: string; images: ImageContent[]; files: string[] }) => void
  /** Queue the draft against the running turn — steer interrupts before the
   * next model call, followUp waits for the run to finish. */
  onQueue: (payload: {
    text: string
    images: ImageContent[]
    files: string[]
    streamingBehavior: StreamingBehavior
  }) => void
  /** Clear the session's queues; resolves with the recalled messages and
   * their full payloads (images, file paths). */
  onRecallQueue: (stopping?: boolean) => Promise<RecalledItemDTO[]>
  onModelChange: (model: ModelDTO) => void
  onThinkingLevelChange: (level: ThinkingLevel) => void
  /** Browser annotation insert (Task 16): Workspace subscribes to
   * `pith:browser-annotation` and hands a fresh { text, seq } per
   * annotation. The draft lives in THIS component's state, so this one-way
   * append is the only external write path — same semantics as
   * selectStarter (existing draft kept, \n\n separator), never an overwrite
   * and never a submit on the user's behalf. seq keeps two identical texts
   * firing. */
  appendDraft?: { text: string; seq: number } | null
}

let attachmentSeq = 0
const nextId = () => `att-${Date.now()}-${attachmentSeq++}`

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

export function Composer({
  start,
  models,
  model,
  thinkingLevel,
  availableThinkingLevels,
  busy,
  initializing = false,
  readOnly = false,
  readOnlyParentPath = null,
  onOpenSession,
  escapeStopsRun = true,
  contextUsage,
  onOpenContext,
  plan = null,
  onPlanState,
  sandboxMode = DEFAULT_SANDBOX_MODE,
  sandbox = null,
  sessionPath = null,
  onSandboxSnapshot,
  queued,
  onSend,
  onQueue,
  onRecallQueue,
  onModelChange,
  onThinkingLevelChange,
  appendDraft = null
}: ComposerProps) {
  const { t } = useI18n()
  const [modePending, setModePending] = useState(false)
  const [modeError, setModeError] = useState<string | null>(null)
  const currentPath = useRef(sessionPath)
  currentPath.current = sessionPath
  useEffect(() => { setModeError(null); setModePending(false) }, [sessionPath])
  const changeMode = async (mode: SessionMode): Promise<boolean> => {
    if (!sessionPath || modePending) return false
    const blocked = initializing ? 'initializing' : readOnly ? 'child-session' : busy ? 'busy' : plan?.blockers.switch[0]
    if (blocked) { setModeError(blocked); return false }
    setModePending(true); setModeError(null)
    try {
      const result = await window.pi.setSessionMode({ sessionPath, mode })
      if (result.ok) onPlanState?.(sessionPath, result.value)
      if (currentPath.current !== sessionPath) return false
      if (!result.ok) { setModeError(result.code); return false }
      return true
    } catch { if (currentPath.current === sessionPath) setModeError('unknown'); return false }
    finally { if (currentPath.current === sessionPath) setModePending(false) }
  }
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
  const inputContainerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<number>(0)

  const addImageFile = useCallback((file: globalThis.File) => {
    // A read-only (subagent child) view never accepts new attachments; only
    // the send path is otherwise reachable, which the disabled field blocks.
    if (readOnly) return
    void readImageAttachment(file).then((read) => {
      if (read) setImages((current) => [...current, { id: nextId(), ...read }])
    })
  }, [readOnly])

  const addFileHit = useCallback((hit: AttachmentTarget) => {
    if (readOnly) return
    setFiles((current) =>
      current.some((f) => f.path === hit.path)
        ? current
        : [...current, { id: nextId(), path: hit.path, relPath: hit.relPath, kind: hit.kind, size: hit.size }]
    )
  }, [readOnly])

  /**
   * Attach a File from a picker, paste or drop, through the shared intake: the
   * preload's `webUtils` path for a real file, the workspace index for one with
   * no local backing.
   */
  const addFileAttachment = useCallback(
    async (file: globalThis.File) => {
      if (readOnly) return
      const target = await resolveAttachmentFile(file)
      if (target) addFileHit(target)
    },
    [addFileHit, readOnly]
  )
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
    if (parsePlanCommand(text)) {
      if (images.length || files.length) { setModeError('plan-command-attachments'); return }
      void changeMode(plan?.mode === 'plan' ? 'normal' : 'plan').then(changed => {
        if (changed) setValue(current => parsePlanCommand(current) ? '' : current)
      })
      return
    }
    if (initializing || readOnly) return
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

  /**
   * Merge recalled messages back into the composer: the original draft texts
   * (file blocks stripped — they restore as chips) go first, then whatever
   * draft text was already typed. Image attachments rebuild from base64;
   * file chips re-stat through the file index, and a failed stat is
   * non-fatal — the draft's @mention still references the file.
   */
  const mergeRecalled = useCallback(
    async (items: RecalledItemDTO[]) => {
      const recalledText = items.map((item) => item.originalText).filter(Boolean).join('\n\n')
      if (recalledText) {
        setValue((current) => (current ? `${recalledText}\n\n${current}` : recalledText))
      }
      setMention(null)
      const restoredImages = items
        .flatMap((item) => item.images)
        .map((image) => ({
          id: nextId(),
          name: t('composer.recalledImage'),
          dataUrl: `data:${image.mimeType};base64,${image.data}`,
          image
        }))
      if (restoredImages.length) setImages((current) => [...current, ...restoredImages])
      const paths = [...new Set(items.flatMap((item) => item.filePaths))]
      for (const path of paths.slice(0, 12)) {
        try {
          const preview = await window.pi.readFile(path)
          setFiles((current) =>
            current.some((f) => f.path === path)
              ? current
              : [
                  ...current,
                  { id: nextId(), path, relPath: preview.relPath, kind: preview.kind, size: preview.size }
                ]
          )
        } catch {
          /* keep the @mention reference in the draft */
        }
      }
    },
    [t]
  )

  const handleRecall = async () => {
    const items = await onRecallQueue()
    if (!items.length) return
    await mergeRecalled(items)
    textareaRef.current?.focus()
  }

  /**
   * pi TUI parity for Stop ("restoreQueuedMessagesToEditor({abort:true})"):
   * the SDK keeps both queues across abort(), and a stray steering message
   * would otherwise hijack the opening of the next run. Recall queued
   * messages (payload included). Main pauses wakeups, clears the queues and
   * aborts that same session atomically before returning the recalled drafts.
   */
  const handleStop = useCallback(async () => {
    const items = await onRecallQueue(true)
    if (items.length) await mergeRecalled(items)
  }, [onRecallQueue, mergeRecalled])

  /**
   * Stop on Escape even when focus has left the composer (scrolling the
   * transcript, a tool disclosure…), where the textarea handler cannot see the
   * key. Overlays take priority: React handlers (the mention popup, disabled
   * popovers) run before this window listener and signal via
   * `defaultPrevented`, while CenterMorphModal registers its Esc handler later
   * than this one, so its open dialog is detected through `aria-modal`.
   */
  useEffect(() => {
    if (!busy || !escapeStopsRun) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[aria-modal="true"]')) return
      event.preventDefault()
      void handleStop()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, escapeStopsRun, handleStop])

  const handlePromoteQueued = useCallback((index: number) => {
    void window.pi.queueAction({ action: 'promote', kind: 'followUp', index })
  }, [])

  const handleRemoveQueued = useCallback((kind: 'steering' | 'followUp', index: number) => {
    void window.pi.queueAction({ action: 'remove', kind, index })
  }, [])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (mention) {
      if (mentionHits.length) {
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
      }
      if (event.key === 'Escape') {
        // Consume Esc (even with no hits while loading/empty) so the global
        // stop shortcut doesn't fire while the mention popup is open.
        event.preventDefault()
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

  const selectStarter = (prompt: string) => {
    // Keep an existing draft and its attachments; suggestions are editable
    // starting points and never submit a request on the user's behalf.
    setValue((current) => current.trim() ? `${current.trimEnd()}\n\n${prompt}` : prompt)
    setMention(null)
    requestAnimationFrame(() => {
      const textarea = inputContainerRef.current?.querySelector('textarea')
      if (!textarea) return
      // On a short window the selected card can be below the input. Let
      // native focus scroll the editor back into view before editing.
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    })
  }

  // Browser annotation insert (Task 16): append the composed annotation text
  // to the internal draft and put the caret at its end — the same
  // keep-the-draft semantics as selectStarter. Keyed on the appendDraft
  // object, so a repeated identical annotation still lands.
  useEffect(() => {
    if (!appendDraft) return
    const text = appendDraft.text
    setValue((current) => (current.trim() ? `${current.trimEnd()}\n\n${text}` : text))
    setMention(null)
    requestAnimationFrame(() => {
      // textareaRef is only populated after PromptInput's first focus — a
      // composer never focused this session has no textarea ref yet; fall
      // back to the container query (selectStarter's path) so the FIRST
      // annotation still focuses the field.
      const textarea = textareaRef.current ?? inputContainerRef.current?.querySelector('textarea') ?? null
      if (!textarea) return
      textarea.focus()
      textarea.setSelectionRange(textarea.value.length, textarea.value.length)
    })
  }, [appendDraft])

  // ---- paste & drag/drop --------------------------------------------------
  const handlePaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = Array.from(event.clipboardData.files)
    if (!pasted.length) return
    // A clipboard holding files must not also paste their names as text.
    event.preventDefault()
    for (const file of pasted) {
      if (file.type.startsWith('image/')) addImageFile(file)
      else void addFileAttachment(file)
    }
  }

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragOver(false)
    for (const file of Array.from(event.dataTransfer.files)) {
      if (file.type.startsWith('image/')) addImageFile(file)
      else void addFileAttachment(file)
    }
  }

  // ---- queued messages ----------------------------------------------------

  return (
    <div className={cn('relative isolate shrink-0 bg-background px-3 pb-3', start && '@container flex min-h-0 flex-1 flex-col overflow-y-auto px-6')}>
      {start ? <ShaderBackdrop /> : null}
      {/* Keep the composer in one tree position when the first turn begins;
          moving it between landing/transcript branches discards draft state. */}
      <div className={cn('mx-auto w-full max-w-3xl', start && 'my-auto max-w-2xl py-8')}>
        {start ? <NewSessionHeader {...start} /> : null}
        <div ref={inputContainerRef} className="relative w-full" onDragOver={(e) => { e.preventDefault(); setDragOver(true) }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop}>
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

          <QueuePanel
            steering={queued.steering}
            followUp={queued.followUp}
            onPromote={handlePromoteQueued}
            onRemove={handleRemoveQueued}
            onRecall={() => void handleRecall()}
          />

          {modeError && <p role="alert" className="mb-2 text-xs text-destructive">{t(planErrorKey(modeError))}</p>}
          {plan?.mode === 'plan' && plan.shellEnforcement !== 'full' && <p className="mb-2 text-xs text-muted-foreground">{t('plan.shellUnavailable')}</p>}
          {/* A disabled composer with no explanation reads as a bug: an opened
              subagent child says why, and where the work actually continues. */}
          {readOnly ? (
            <div
              data-composer-readonly=""
              className="mb-2 flex items-center gap-2 rounded-control border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground"
            >
              <Bot aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">{t('subagent.readOnlyNotice')}</span>
              {readOnlyParentPath && onOpenSession ? (
                <Button variant="ghost" size="sm" onClick={() => onOpenSession(readOnlyParentPath)}>
                  {t('subagent.openParent')}
                </Button>
              ) : null}
            </div>
          ) : null}

          {images.length || files.length ? (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {images.map((attachment) => (
                <span key={attachment.id} className="group relative">
                  <PreviewThumb
                    src={attachment.dataUrl}
                    alt={attachment.name}
                    className="h-14 w-14 rounded-xl"
                    imageClassName="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    aria-label={t('workspace.removeAttachment', { name: attachment.name })}
                    onClick={() => removeImage(attachment.id)}
                    className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-capsule bg-foreground text-background opacity-0 transition-opacity group-hover:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {files.map((attachment) => (
                <LabelTooltip
                  key={attachment.id}
                  content={`${attachment.relPath} · ${formatBytes(attachment.size)}`}
                  wrap
                >
                  {/* The span owns the tooltip's `aria-describedby` (the chip
                      forwards no unknown props) and the chip stays quiet until
                      its label is clicked, when the remove action slides out. */}
                  <span data-attachment-chip="">
                    <ExpandableChip
                      className="h-7"
                      labelClassName="pl-2.5 pr-2 text-xs"
                      actionClassName="h-full"
                      label={
                        <span className="inline-flex items-center gap-1.5">
                          <FileText className="size-3.5 shrink-0 text-primary" />
                          <span className="max-w-44 truncate">{basename(attachment.relPath)}</span>
                        </span>
                      }
                      actionIcon={<X className="size-3" />}
                      actionLabel={t('workspace.removeAttachment', { name: attachment.relPath })}
                      onAction={() => removeFile(attachment.id)}
                    />
                  </span>
                </LabelTooltip>
              ))}
            </div>
          ) : null}

          <div
            className={dragOver ? 'rounded-2xl ring-2 ring-primary/60 transition-shadow' : 'transition-shadow'}
          >
            <PromptInput
              aria-label={t('composer.inputAria')}
              className={start ? 'bg-card' : undefined}
              minRows={start ? 3 : 2}
              value={value}
              onFocus={(event) => { textareaRef.current = event.currentTarget }}
              onValueChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              loading={busy}
              submitDisabled={initializing || readOnly}
              disabled={readOnly}
              onStop={() => void handleStop()}
              onSubmit={() => dispatch(behavior)}
              onQueueSubmit={() => dispatch(behavior)}
              maxRows={8}
              placeholder={
                busy
                  ? t(behavior === 'steer' ? 'composer.hintSteer' : 'composer.hintFollowUp', {
                      modifier: IS_MAC ? '⌘' : 'Ctrl'
                    })
                  : t(start ? 'newSession.placeholder' : 'composer.placeholder')
              }
              leadingAction={
                <span className="flex items-center gap-1">
                  <ModelPicker
                    models={models}
                    value={model ? `${model.providerId}/${model.id}` : null}
                    thinkingLevel={thinkingLevel}
                    availableThinkingLevels={availableThinkingLevels}
                    onChange={onModelChange}
                    onThinkingLevelChange={onThinkingLevelChange}
                    disabled={busy || initializing || readOnly}
                  />
                </span>
              }
              contextIndicator={
                <span className="flex items-center gap-1">
                  {/* The sandbox mode sits with the send cluster, left of the
                      context ring: it is the permission the next submitted turn
                      runs under. */}
                  <SessionModePicker state={plan} disabled={busy || initializing || readOnly || modePending || !sessionPath} onChange={mode => void changeMode(mode)} />
                  <SandboxModePicker
                    mode={plan?.effectiveSandboxMode ?? sandboxMode}
                    status={sandbox}
                    sessionPath={sessionPath}
                    disabled={busy || initializing || readOnly}
                    planRestricted={plan?.mode === 'plan'}
                    onSnapshot={(snapshot) => onSandboxSnapshot?.(snapshot)}
                  />
                  {initializing ? (
                    <LabelTooltip content={t('composer.initializing')}>
                      <span role="status" aria-label={t('composer.initializing')} className="grid size-7 place-items-center text-muted-foreground">
                        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                      </span>
                    </LabelTooltip>
                  ) : <ContextRing usage={contextUsage ?? null} onOpen={onOpenContext} />}
                </span>
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
            multiple
            hidden
            onChange={async (event) => {
              const picked = Array.from(event.target.files ?? [])
              for (const file of picked) await addFileAttachment(file)
              event.target.value = ''
            }}
          />
        </div>
        {start ? <NewSessionSuggestions {...start} onSelect={selectStarter} /> : null}
      </div>
    </div>
  )
}
