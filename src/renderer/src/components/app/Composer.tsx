import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type ReactNode
} from 'react'
import { CalendarCheck, Check, Compass, Subagent, ImagePlus, LinkSimple, Loader2, NotebookPen, X } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { PromptInput } from '@/components/agents/prompt-input'
import type { PromptEditorHandle } from '@/lib/hooks/use-prompt-editor'
import { readImageAttachment, resolveAttachmentFile, type AttachmentTarget } from '@/lib/attachments'
import {
  otherBehavior,
  useStreamingBehavior,
  type StreamingBehavior
} from '@/lib/streaming-behavior'
import { useShortcutHandlers, type ShortcutHandlers } from '@/lib/shortcuts/use-shortcuts'
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
import { ImagePreviewGroup, PreviewThumb } from './ImagePreview'
import { FileAttachmentCard } from './FileAttachmentCard'
import { ModelPicker } from './ModelPicker'
import { parsePlanCommand, planErrorKey } from '@/lib/plan-submissions'
import type { GoalErrorCode } from '../../../../shared/goal'
import { SandboxModePicker } from './SandboxModePicker'
import { ContextRing } from './ContextRing'
import { QueuePanel } from './QueuePanel'
import { LabelTooltip } from './LabelTooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { NewSessionHeader, type NewSessionContext } from './NewSession'
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
  /** Permission cards share the editor's fitted width and stay above it. */
  approval?: ReactNode
  models: ModelDTO[]
  model: ModelDTO | null
  thinkingLevel: ThinkingLevel
  /** Levels the current model supports; the cycle button only walks these. */
  availableThinkingLevels: ThinkingLevel[]
  busy: boolean
  initializing?: boolean
  /** A read-only session view: typing and submit are disabled. */
  readOnly?: boolean
  /** Settings → General: keep the model and permission pickers usable while a
   * run streams. Off (the default) freezes both until the run settles; main
   * refuses a mid-run switch either way, so this only governs the gates. */
  allowMidRunChanges?: boolean
  readOnlyKind?: 'subagent' | 'scheduled'
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
  goalEnabled?: boolean
  goalPending?: boolean
  goalError?: GoalErrorCode | null
  onGoalModeChange?: (enabled: boolean) => void
  /** Apply the snapshot a mode switch returns; the store owns that state. */
  onSandboxSnapshot?: (snapshot: SessionSnapshotDTO) => void
  queued: { steering: QueuedItemDTO[]; followUp: QueuedItemDTO[] }
  compactionQueued?: boolean
  onSend: (payload: { text: string; images: ImageContent[]; files: string[] }) => void | Promise<boolean>
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
   * append is the only external write path — keep-the-draft semantics
   * (existing draft kept, \n\n separator), never an overwrite and never a
   * submit on the user's behalf. seq keeps two identical texts firing. */
  appendDraft?: { text: string; seq: number } | null
}

let attachmentSeq = 0
const nextId = () => `att-${Date.now()}-${attachmentSeq++}`

const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

export function Composer({
  start,
  approval,
  models,
  model,
  thinkingLevel,
  availableThinkingLevels,
  busy,
  initializing = false,
  readOnly = false,
  allowMidRunChanges = false,
  readOnlyKind = 'subagent',
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
  goalEnabled = false,
  goalPending = false,
  goalError = null,
  onGoalModeChange,
  onSandboxSnapshot,
  queued,
  compactionQueued = false,
  onSend,
  onQueue,
  onRecallQueue,
  onModelChange,
  onThinkingLevelChange,
  appendDraft = null
}: ComposerProps) {
  const { t } = useI18n()
  // Paint the chosen mode in the click's render, while main persists and
  // applies it. Sending stays gated until that request has settled.
  const [switchingMode, setSwitchingMode] = useState<SessionMode | null>(null)
  const modePending = switchingMode !== null
  const [modeError, setModeError] = useState<string | null>(null)
  // A mode chosen while the session is still initializing cannot be admitted
  // by main yet (extension startup may still rewrite the session). The intent
  // is queued here and flushed when initialization ends; until then the
  // optimistic value drives the bottom mode control and disables permissions,
  // and a failed flush reverts it through `setPendingMode(null)` + modeError.
  const [pendingMode, setPendingMode] = useState<SessionMode | null>(null)
  const currentPath = useRef(sessionPath)
  currentPath.current = sessionPath
  useEffect(() => { setModeError(null); setSwitchingMode(null); setPendingMode(null) }, [sessionPath])
  // Queued and in-flight choices share the same appearance, so flushing an
  // initialization intent never flashes the previously published mode.
  const effectiveMode: SessionMode = pendingMode ?? switchingMode ?? plan?.mode ?? 'normal'
  const flushed = useRef(false)
  const queueMode = (mode: SessionMode) => {
    // Reset the flush guard so the plan-state change that follows retries the
    // application (the IPC-refusal path re-queues from inside a flush).
    flushed.current = false
    setPendingMode(mode)
    setModeError(null)
  }
  const changeMode = async (mode: SessionMode): Promise<boolean> => {
    if (!sessionPath || modePending) return false
    // "Still initializing" reaches the renderer three ways — the shell flag,
    // a stale plan DTO blocker, or an IPC refusal — and all three queue the
    // intent instead of erroring, so a new session can enter plan mode
    // before its tools are ready.
    if (!readOnly && (initializing || (plan?.blockers.switch.includes('initializing') ?? false))) {
      queueMode(mode)
      return true
    }
    const blocked = readOnly ? 'child-session' : busy ? 'busy' : plan?.blockers.switch[0]
    if (blocked) { setModeError(blocked); return false }
    setSwitchingMode(mode); setModeError(null)
    try {
      const result = await window.pi.setSessionMode({ sessionPath, mode })
      if (result.ok) onPlanState?.(sessionPath, result.value)
      if (currentPath.current !== sessionPath) return false
      if (!result.ok) {
        if (result.code === 'initializing' && !readOnly) { queueMode(mode); return true }
        setModeError(result.code); return false
      }
      return true
    } catch { if (currentPath.current === sessionPath) setModeError('unknown'); return false }
    finally { if (currentPath.current === sessionPath) setSwitchingMode(null) }
  }
  // Flush a queued intent once nothing reports initializing anymore. The
  // blockers guard covers the stale-DTO window between session_initialized
  // and the plan refresh; `flushed` keeps a re-queued flush from applying
  // twice, and a same-mode intent (two quick toggles) needs no durable entry.
  useEffect(() => {
    if (initializing) { flushed.current = false; return }
    if (pendingMode === null || flushed.current) return
    if (plan?.blockers.switch.includes('initializing')) return
    flushed.current = true
    if (pendingMode === (plan?.mode ?? 'normal')) { setPendingMode(null); return }
    // Clear before applying so a refused flush (busy…) reverts the optimistic
    // UI; an 'initializing' refusal re-queues from inside changeMode, which
    // resets `flushed` and lets the next plan-state change retry.
    const mode = pendingMode
    setPendingMode(null)
    void changeMode(mode)
  }, [initializing, pendingMode, plan?.mode, plan?.blockers, changeMode])
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
  const editorRef = useRef<PromptEditorHandle | null>(null)
  const [refining, setRefining] = useState(false)
  useEffect(() => {
    setRefining(false)
    const refine = (event: Event) => {
      if ((event as CustomEvent).detail?.sessionPath !== sessionPath || readOnly) return
      setRefining(true); editorRef.current?.focus({ preventScroll: true })
    }
    window.addEventListener('pith:refine-plan', refine)
    return () => window.removeEventListener('pith:refine-plan', refine)
  }, [sessionPath, readOnly, plan?.mode])
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
    const editor = editorRef.current
    const caret = editor?.selectionStart ?? value.length
    const start = mention.triggerIndex
    editor?.replaceRange(start, caret, `@${hit.relPath} `)
    setMention(null)
    addFileHit(hit)
  }

  // ---- submit ---------------------------------------------------------------
  /** Send when idle; queue against the running turn when busy. The behavior
   * override is how Cmd/Ctrl+Enter submits the inverse of the preference. */
  const dispatch = (sendBehavior: StreamingBehavior) => {
    const text = value.trim()
    if (parsePlanCommand(text)) {
      if (images.length || files.length) { setModeError('plan-command-attachments'); return }
      void changeMode(effectiveMode === 'plan' ? 'normal' : 'plan').then(changed => {
        if (changed) setValue(current => parsePlanCommand(current) ? '' : current)
      })
      return
    }
    // A queued or in-flight mode intent gates the send too: the first prompt
    // must go out under the mode the control shows, not race the flush IPC into
    // a 'busy' refusal (and a revert that silently downgrades the request).
    if (initializing || readOnly || pendingMode !== null || modePending || goalPending) return
    if (!text && !images.length && !files.length) return
    const payload = {
      text,
      images: images.map((a) => a.image),
      files: files.map((f) => f.path)
    }
    const result = busy ? onQueue({ ...payload, streamingBehavior: sendBehavior }) : onSend(payload)
    setRefining(false)
    setValue('')
    setImages([])
    setFiles([])
    setMention(null)
    if (result && typeof result.then === 'function') void result.then(accepted => {
      if (accepted || currentPath.current !== sessionPath) return
      // The IPC may fail after typing has resumed. Preserve any newer draft.
      setValue(current => current || value)
      setImages(current => current.length ? current : images)
      setFiles(current => current.length ? current : files)
    })
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
    editorRef.current?.focus()
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
   * transcript, a tool disclosure…), where the editor handler cannot see the
   * key. The shortcut dispatcher owns Escape: overlay layers (dialogs,
   * menus) block it outright, React handlers that consumed it signal via
   * `defaultPrevented`, and text fields other than the main composer keep
   * their own Escape. Registering nothing while idle leaves Esc untouched.
   */
  const stopAgentHandlers = useMemo<ShortcutHandlers>(
    () =>
      (busy || goalPending) && escapeStopsRun
        ? {
            stopAgent: () => {
              void handleStop()
            }
          }
        : {},
    [busy, goalPending, escapeStopsRun, handleStop]
  )
  useShortcutHandlers(stopAgentHandlers)

  const handlePromoteQueued = useCallback((index: number) => {
    void window.pi.queueAction({ action: 'promote', kind: 'followUp', index })
  }, [])

  const handleRemoveQueued = useCallback((kind: 'steering' | 'followUp', index: number) => {
    void window.pi.queueAction({ action: 'remove', kind, index })
  }, [])

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>) => {
    if (event.nativeEvent.isComposing) return
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
    const caret = editorRef.current?.selectionStart ?? next.length
    detectMention(next, caret)
  }

  // Browser annotation insert (Task 16): append the composed annotation text
  // to the internal draft and put the caret at its end — keep-the-draft
  // semantics (an existing draft is kept with a \n\n separator). Keyed on the
  // appendDraft object, so a repeated identical annotation still lands.
  useEffect(() => {
    if (!appendDraft) return
    const editor = editorRef.current
    if (!editor) return
    const text = appendDraft.text
    const current = editor.value
    const start = current.trim() ? current.trimEnd().length : 0
    editor.replaceRange(start, current.length, start ? `\n\n${text}` : text)
    setMention(null)
  }, [appendDraft])

  // ---- paste & drag/drop --------------------------------------------------
  const handlePaste = (event: ReactClipboardEvent<HTMLSpanElement>) => {
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
    <div className={cn('relative isolate shrink-0 bg-background px-3 pb-3', start && '@container flex min-h-0 flex-1 flex-col overflow-hidden px-6')}>
      {start ? <ShaderBackdrop variant="dithering" /> : null}
      {/* Keep the composer in one tree position when the first turn begins;
          moving it between landing/transcript branches discards draft state. */}
      <div className={cn('mx-auto w-full min-w-0 max-w-3xl', start && 'my-auto max-w-2xl py-8')}>
        {start ? <NewSessionHeader {...start} /> : null}
        {approval}
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
            compactionQueued={compactionQueued}
            onPromote={handlePromoteQueued}
            onRemove={handleRemoveQueued}
            onRecall={() => void handleRecall()}
          />

          {modeError && <p role="alert" className="mb-2 text-xs text-destructive">{t(planErrorKey(modeError))}</p>}
          {goalEnabled && goalError && <p role="alert" data-goal-error="" className="mb-2 text-xs text-destructive">{t(`goal.error.${goalError}`)}</p>}
          {plan?.mode === 'plan' && plan.shellEnforcement !== 'full' && <p className="mb-2 text-xs text-muted-foreground">{t('plan.shellUnavailable')}</p>}
          {/* A disabled composer explains who owns the session's turns. */}
          {readOnly ? (
            <div
              data-composer-readonly=""
              className="mb-2 flex items-center gap-2 rounded-control border border-border bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground"
            >
              {readOnlyKind === 'scheduled'
                ? <CalendarCheck aria-hidden="true" className="size-3.5 shrink-0" />
                : <Subagent aria-hidden="true" className="size-3.5 shrink-0" />}
              <span className="min-w-0 flex-1">{t(readOnlyKind === 'scheduled' ? 'scheduledTasks.pane.readOnly' : 'subagent.readOnlyNotice')}</span>
              {readOnlyParentPath && onOpenSession ? (
                <Button variant="ghost" size="sm" onClick={() => onOpenSession(readOnlyParentPath)}>
                  {t('subagent.openParent')}
                </Button>
              ) : null}
            </div>
          ) : null}

          <div
            className={dragOver ? 'rounded-2xl ring-1 ring-primary/60 transition-shadow' : 'transition-shadow'}
          >
            <PromptInput
              aria-label={t('composer.inputAria')}
              className={start ? 'bg-card' : undefined}
              minRows={start ? 3 : 2}
              value={value}
              inputRef={editorRef}
              onValueChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              loading={busy || goalPending}
              submitDisabled={initializing || readOnly || pendingMode !== null || modePending || goalPending}
              disabled={readOnly}
              onStop={() => void handleStop()}
              onSubmit={() => dispatch(behavior)}
              onQueueSubmit={() => dispatch(behavior)}
              maxRows={8}
              attachments={
                images.length || files.length ? (
                  <ImagePreviewGroup>
                    {images.map((attachment) => (
                      <span key={attachment.id} className="group relative">
                        <PreviewThumb
                          src={attachment.dataUrl}
                          alt={attachment.name}
                          framed
                          className="h-14 w-14 rounded-xl"
                          imageClassName="h-full w-full object-cover"
                        />
                        <button
                          type="button"
                          aria-label={t('workspace.removeAttachment', { name: attachment.name })}
                          onClick={() => removeImage(attachment.id)}
                          className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-icon text-destructive opacity-0 transition-[opacity,color,background-color] group-hover:opacity-100 hover:bg-destructive/10 focus-visible:opacity-100"
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                    {files.map((attachment) => (
                      <FileAttachmentCard
                        key={attachment.id}
                        path={attachment.path}
                        label={attachment.relPath}
                        size={attachment.size}
                        onRemove={() => removeFile(attachment.id)}
                      />
                    ))}
                  </ImagePreviewGroup>
                ) : undefined
              }
              placeholder={
                busy
                  ? t(behavior === 'steer' ? 'composer.hintSteer' : 'composer.hintFollowUp', {
                      modifier: IS_MAC ? '⌘' : 'Ctrl'
                    })
                  : t(refining ? 'plan.refinePrompt' : goalEnabled ? 'composer.goalPlaceholder' : start ? 'newSession.placeholder' : 'composer.placeholder')
              }
              leadingAction={
                <span className="flex min-w-0 items-center gap-1">
                  <ModelPicker
                    models={models}
                    value={model ? `${model.providerId}/${model.id}` : null}
                    thinkingLevel={thinkingLevel}
                    availableThinkingLevels={availableThinkingLevels}
                    onChange={onModelChange}
                    onThinkingLevelChange={onThinkingLevelChange}
                    disabled={(busy && !allowMidRunChanges) || initializing || readOnly}
                  />
                  {effectiveMode === 'plan' ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-plan-mode-control=""
                      aria-label={t('plan.exit')}
                      aria-pressed="true"
                      disabled={readOnly || busy || modePending || !sessionPath || (plan?.blockers.switch.some((blocker) => blocker !== 'initializing') ?? false)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        editorRef.current?.focus({ preventScroll: true })
                        void changeMode('normal')
                      }}
                      className="group h-8 gap-1.5 px-2 text-xs text-primary hover:bg-muted hover:text-primary"
                    >
                      <span aria-hidden="true" className="relative size-4 shrink-0">
                        <NotebookPen className="absolute inset-0 size-4 transition-opacity group-hover:opacity-0" />
                        <X className="absolute inset-0 size-4 opacity-0 transition-opacity group-hover:opacity-100" />
                      </span>
                      <span>{t('plan.plan')}</span>
                    </Button>
                  ) : null}
                  {goalEnabled ? <Button type="button" variant="ghost" size="sm" data-goal-mode-control=""
                    aria-label={t('goal.exit')} aria-pressed="true" disabled={readOnly || goalPending || !sessionPath}
                    onMouseDown={event => event.preventDefault()} onClick={() => { editorRef.current?.focus({ preventScroll: true }); onGoalModeChange?.(false) }}
                    className="group h-8 gap-1.5 px-2 text-xs text-primary hover:bg-muted hover:text-primary">
                    <span aria-hidden="true" className="relative size-4 shrink-0">
                      <Compass className="absolute inset-0 size-4 transition-opacity group-hover:opacity-0" />
                      <X className="absolute inset-0 size-4 opacity-0 transition-opacity group-hover:opacity-100" />
                    </span>
                    <span>{t('goal.title')}</span>
                  </Button> : null}
                </span>
              }
              contextIndicator={
                <span className="flex items-center gap-1">
                  {/* The permission stays readable (and deliberately disabled)
                      under a plan. The picker's mode is the session's own
                      stored choice — the snapshot's sandboxMode carries the
                      EFFECTIVE value, which plan overlays with read-only, so
                      the stored one comes from the plan DTO (which every plan
                      state refresh carries, transition or not). */}
                  <SandboxModePicker
                    mode={plan?.configuredSandboxMode ?? sandboxMode}
                    status={sandbox}
                    sessionPath={sessionPath}
                    disabled={(busy && !allowMidRunChanges) || initializing || readOnly}
                    planRestricted={effectiveMode === 'plan'}
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
                  value: 'toggle-plan',
                  label: (
                    <span className="flex w-full items-center justify-between gap-2">
                      <span>{t('composer.planMode')}</span>
                      {effectiveMode === 'plan' ? <Check aria-hidden="true" className="size-3.5 shrink-0 text-primary" /> : null}
                    </span>
                  ),
                  icon: <NotebookPen />,
                  disabled: readOnly || busy || modePending || !sessionPath || (plan?.blockers.switch.some((blocker) => blocker !== 'initializing') ?? false)
                },
                ...(onGoalModeChange ? [{
                  value: 'toggle-goal',
                  label: <span className="flex w-full items-center justify-between gap-2"><span>{t('composer.goalMode')}</span>
                    {goalEnabled ? <Check aria-hidden="true" className="size-3.5 shrink-0 text-primary" /> : null}</span>,
                  icon: <Compass />,
                  disabled: readOnly || goalPending || !sessionPath || (!goalEnabled && busy)
                }] : []),
                {
                  value: 'attach-image',
                  label: t('composer.attachImage'),
                  icon: <ImagePlus />
                },
                {
                  value: 'attach-file',
                  label: t('composer.attachFile'),
                  icon: <LinkSimple />
                }
              ]}
              onAction={(action) => {
                if (action === 'toggle-plan') {
                  editorRef.current?.focus({ preventScroll: true })
                  void changeMode(effectiveMode === 'plan' ? 'normal' : 'plan')
                } else if (action === 'toggle-goal') {
                  editorRef.current?.focus({ preventScroll: true })
                  onGoalModeChange?.(!goalEnabled)
                } else if (action === 'attach-image') imageInputRef.current?.click()
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
      </div>
    </div>
  )
}
