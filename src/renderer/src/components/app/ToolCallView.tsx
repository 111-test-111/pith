import { submittedPlanRef } from '@/lib/plan-submissions'
import { useBashTask, bashTaskStatus } from '@/lib/bash-tasks'
import { BashTaskRow } from './BashTaskView'
import { memo, useMemo, useState } from 'react'
import { FileDiff } from '@/components/agents/file-diff'
import { ToolResult, ToolResultOutput, type ToolResultStatus } from '@/components/agents/tool-result'
import { parseUnifiedDiff, countDiffChanges, synthesizeWritePatch } from '@/lib/diff'
import { basename } from '@/lib/format'
import { displayToolDir, resolveFromCwd } from '@/lib/tool-path'
import { ToolIcon } from '@/lib/tool-icons'
import { cn } from '@/lib/utils'
import { TRANSCRIPT_ROW, TRANSCRIPT_ROW_WIDTH } from '@/lib/transcript-rhythm'
import { firstAskUserQuestionText, isAskUserToolDetails, askUserRecordKind } from '../../../../shared/ask-user'
import { AskUserKindChip } from './AskUserRecordList'
import { PreviewThumb } from './ImagePreview'
import type { ImageContent, ToolCallContent, ToolResultMsg } from '../../../../shared/types'
import type { ToolRun } from '@/state/pi-store'
import { useI18n } from '@/i18n'

interface ToolCallViewProps {
  call: ToolCallContent
  result?: ToolResultMsg
  run?: ToolRun
  /** Session working directory, used to render a file tool's target path. */
  cwd?: string | null
}

/**
 * Image parts a tool returned (the SDK's `read` tool inlines image files and
 * `browser_screenshot` returns a page capture).
 */
function resultImages(source: ToolResultMsg | ToolRun | undefined): ImageContent[] {
  if (!source) return []
  const content = 'content' in source && Array.isArray((source as ToolResultMsg).content)
    ? (source as ToolResultMsg).content
    : (source as ToolRun).partial?.content
  if (!Array.isArray(content)) return []
  return content.filter((part: any): part is ImageContent => part?.type === 'image' && Boolean(part.data))
}

/**
 * A tool's images, as preview thumbnails: clicking one opens the same
 * full-screen overlay every other image in the app uses. `path` is the file an
 * image-reading tool read, when there is one — it is what gives the overlay its
 * "open file" action.
 */
function ResultImages({
  images,
  path,
  onError,
}: {
  images: ImageContent[]
  path?: string
  onError?: () => void
}) {
  const { t } = useI18n()
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((image, index) => (
        <PreviewThumb
          key={index}
          src={`data:${image.mimeType};base64,${image.data}`}
          alt={t('chat.imageAlt', { index: index + 1 })}
          path={path}
          onError={onError}
          className="max-w-full rounded-lg"
          imageClassName="max-h-64 w-auto max-w-full object-contain"
        />
      ))}
    </div>
  )
}

/**
 * A tool result's own TEXT parts. Image parts are not text: the row renders
 * them itself (or says why it cannot), so a `[image]` placeholder would only be
 * a second, worse copy of the picture — and it showed up exactly in the
 * fallback case, under the image it was standing for.
 */
function resultText(source: ToolResultMsg | ToolRun | undefined): string {
  if (!source) return ''
  const content = 'content' in source && Array.isArray((source as ToolResultMsg).content)
    ? (source as ToolResultMsg).content
    : (source as ToolRun).partial?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part.type === 'text')
    .map((part) => (part as { text: string }).text)
    .join('\n')
}

/** Managed bash wraps its final result for the model. Foreground rows still
 * render ordinary command output, including after the task record expires.
 * Only unwrap an envelope for this exact call; stdout may itself be JSON. */
function managedBashOutput(text: string, toolCallId: string): {
  output: string; error?: string; exitCode?: number; status?: string; truncated?: boolean
} | undefined {
  try {
    const value = JSON.parse(text)
    if (value?.toolCallId === toolCallId && typeof value.id === 'string' &&
      typeof value.background === 'boolean' && typeof value.output === 'string') return value
  } catch { /* Legacy bash results and streaming stdout are plain text. */ }
  return undefined
}

export function statusOf(result: ToolResultMsg | undefined, run: ToolRun | undefined) {
  if (result) return result.isError ? 'error' : 'success'
  if (run) return run.status === 'running' ? 'running' : run.status
  return 'running' as const
}

/**
 * A call the turn never got to execute (Stop, a provider error): its settled run
 * carries no start time (PiStore.settleToolRuns), so it has no output and no
 * diff, and the row must not fall back to a success placeholder like "Wrote x".
 */
function neverRan(status: ToolResultStatus, run: ToolRun | undefined): boolean {
  return status === 'error' && run?.startedAt === 0
}

/**
 * The unified patch a file-writing result reported (`edit`, or a `write` that
 * chose to). The SDK returns BOTH a display-oriented `diff` — line numbers baked
 * into every line — and a real unified `patch`; only the latter is what
 * `parseUnifiedDiff` can read back, so the patch wins wherever both exist.
 */
function patchOf(
  result: ToolResultMsg | undefined,
  run: ToolRun | undefined
): { patch: string } | undefined {
  const sources = [result?.details, (run?.partial as any)?.details] as (
    | { patch?: unknown; diff?: unknown }
    | undefined
  )[]
  for (const source of sources) {
    const patch = source?.patch ?? source?.diff
    if (typeof patch === 'string' && patch) return { patch }
  }
  return undefined
}

/**
 * Tool output is free-form text (command output, file contents, SDK errors),
 * not a script — the default bash grammar tokenized it and colored the first
 * word as a command. Render all of it as plain text; failures get the
 * destructive color.
 */
function outputProps(status: ToolResultStatus) {
  return {
    language: 'text' as const,
    highlight: false,
    ...(status === 'error' ? { className: 'text-destructive' } : {}),
  }
}

/** Live marker or run duration; the label itself is localized by the caller. */
function metaOf(run: ToolRun | undefined): { live: boolean; seconds?: number } {
  // Only an executing run is live: a settled one whose result message has not
  // arrived yet (or never will — the turn was stopped) reports its duration.
  if (run?.status === 'running') return { live: true }
  if (run?.startedAt && run.endedAt) {
    return { live: false, seconds: Math.max(0.1, (run.endedAt - run.startedAt) / 1000) }
  }
  return { live: false }
}

/**
 * The row label for a file tool: `edit · drive.mjs — src`. The basename leads
 * so the row scans by file; only the file's directory follows — relative inside
 * the session cwd, absolute outside it — so the filename is never repeated.
 * The directory is omitted when it IS the workspace root.
 */
function fileToolLabel(tool: string, path: string, cwd: string | null | undefined): string {
  const dir = displayToolDir(path, cwd)
  return `${tool} · ${basename(path)}${dir ? ` — ${dir}` : ''}`
}

/**
 * `overflow-wrap: anywhere` (unlike `break-words`) lowers the intrinsic
 * min-content width, so unbroken tool output (e.g. minified JSON) wraps
 * instead of blowing out the conversation's width.
 */
const WRAP_OUTPUT = '[&_pre]:[overflow-wrap:anywhere]'

interface LazyDiffProps {
  file: string
  diff: string
  status: 'streaming' | 'complete'
  /** Tool name whose icon heads the diff row (`edit`/`write`). */
  tool: string
}

/** Keep diff parsing and line rendering out of the hot path while the card is
 * collapsed. Historical sessions commonly contain many large edit results. */
function LazyDiff({ file, diff, status, tool }: LazyDiffProps) {
  const [open, setOpen] = useState(false)
  // Counts for the collapsed header; parsing the full diff into rows stays
  // deferred until the user opens it.
  const changes = useMemo(() => countDiffChanges(diff), [diff])
  return (
    <FileDiff
      lazyContent
      icon={<ToolIcon name={tool} className="text-muted-foreground" />}
      file={file}
      lines={open ? parseUnifiedDiff(diff) : []}
      additions={changes.added}
      deletions={changes.removed}
      status={status}
      open={open}
      onOpenChange={setOpen}
      collapseOnComplete={false}
    />
  )
}

/**
 * The ask_user_question tool's settled details, from the committed result or
 * (while the run is still open) its partial — same source discipline as
 * `patchOf`.
 */
function askUserDetails(result: ToolResultMsg | undefined, run: ToolRun | undefined) {
  const sources = [result?.details, (run?.partial as any)?.details] as unknown[]
  for (const source of sources) {
    if (isAskUserToolDetails(source)) return source
  }
  return null
}

/**
 * Maps a pi tool call + its execution state onto beUI disclosure components:
 * every tool becomes a ToolResult row (edit/write prefer a FileDiff surface when
 * the SDK returned a unified diff). The row's glyph comes from the app-wide
 * tool→icon map in `lib/tool-icons`.
 */
export const ToolCallView = memo(function ToolCallView({ call, result, run, cwd }: ToolCallViewProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const task = useBashTask(call.name === 'bash' ? call.id : undefined, result?.details?.bashTask ?? run?.partial?.details?.bashTask)
  const backgroundTask = call.name === 'bash' && task?.background ? task : undefined
  const status = backgroundTask ? bashTaskStatus(backgroundTask) : statusOf(result, run)
  /** Body text when the call produced nothing of its own. */
  const placeholder = (fallback: string) =>
    neverRan(status, run) ? t('tool.notRun') : fallback
  const metaInfo = metaOf(run)
  const meta = metaInfo.live
    ? t('tool.live')
    : metaInfo.seconds !== undefined
      ? t('tool.duration', { seconds: metaInfo.seconds.toFixed(1) })
      : undefined
  const args = call.arguments ?? {}
  const images = resultImages(result ?? run)
  // The images ARE the output while they really came back: the text beside them
  // is the tool's own bookkeeping ("Read image file [image/png]", the
  // screenshot's own notes), and the framed output box would only wrap a
  // picture. But `read` and `browser_screenshot` also put their DIAGNOSIS in
  // that text — so a failed result, or an image the browser cannot decode, keeps
  // it, and that is the whole reason this is a condition rather than a count.
  const [imageFailed, setImageFailed] = useState(false)
  const imageOnly = images.length > 0 && result?.isError !== true && !imageFailed
  /** The file an image-reading tool read — the preview's "open file" target. */
  const imagePath =
    call.name === 'read' && typeof args.path === 'string' && args.path
      ? resolveFromCwd(args.path, cwd)
      : undefined
  // Tool payloads can be large cumulative snapshots. Do not flatten them into
  // text on every update unless the user is actually viewing this disclosure.
  let output = open ? resultText(result ?? run) : ''
  const bashOutput = open && call.name === 'bash' && result ? managedBashOutput(output, call.id) : undefined
  if (bashOutput) {
    const lines = [bashOutput.output]
    if (typeof bashOutput.error === 'string' && bashOutput.error !== bashOutput.output) lines.push(bashOutput.error)
    if (typeof bashOutput.exitCode === 'number' && bashOutput.exitCode !== 0) lines.push(t('bashTask.exitCode', { code: bashOutput.exitCode }))
    if (bashOutput.status === 'timed_out' || bashOutput.status === 'cancelled' || bashOutput.status === 'interrupted') lines.push(t(`bashTask.${bashOutput.status}`))
    if (bashOutput.truncated) lines.push(t('chat.bashTruncated'))
    output = lines.filter(Boolean).join('\n')
  }
  // Text output, or the images a tool returned in its place.
  const renderOutput = (children: string) => (
    <>
      {imageOnly ? null : (
        <ToolResultOutput {...outputProps(status)}>{children}</ToolResultOutput>
      )}
      {images.length && !imageFailed ? (
        <ResultImages images={images} path={imagePath} onError={() => setImageFailed(true)} />
      ) : null}
    </>
  )

  if (submittedPlanRef(result)) return null

  switch (call.name) {
    case 'ask_user_question': {
      // The row names the question instead of the bare tool name — the first
      // question is what the user needs to recognize while it waits for them —
      // and stops there: the Q&A record itself lives in the strip's own panel
      // (`AskUserRecordList`), never in the transcript.
      const details = askUserDetails(result, run)
      const firstQuestion = firstAskUserQuestionText(args)
      const title = [t('askUser.rowVerb'), firstQuestion].filter(Boolean).join(' · ')
      return (
        <div
          data-ask-user-row
          className={cn(TRANSCRIPT_ROW, TRANSCRIPT_ROW_WIDTH, 'flex-row items-center gap-2')}
        >
          <ToolIcon name="ask_user_question" className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{title}</span>
          <AskUserKindChip kind={details ? askUserRecordKind(details) : 'pending'} />
        </div>
      )
    }
    case 'todo_write':
      return (
        <ToolResult animateChanges={false} lazyContent open={open} onOpenChange={setOpen}
          title={t('todo.updated')} status={status} icon={<ToolIcon name="todo_write" />} meta={meta}
          collapseOnComplete={false} bare={imageOnly} contentClassName={WRAP_OUTPUT}>
          {renderOutput(output || placeholder(t('tool.noOutput')))}
        </ToolResult>
      )
    case 'agent': {
      // A delegation row names the profile and the task instead of the bare
      // tool name: `agent · explore · summarize two modules` is what the user
      // needs to tell concurrent runs apart (the panel card carries the rest).
      const profile = typeof args.subagent_type === 'string' ? args.subagent_type : ''
      const description = typeof args.description === 'string' ? args.description.trim() : ''
      const background = args.run_in_background === true
      const label = [t('subagent.delegation'), profile, description].filter(Boolean).join(' · ')
      const rowMeta = [background ? t('subagent.background') : undefined, meta].filter(Boolean).join(' · ')
      return (
        <ToolResult animateChanges={false} lazyContent open={open} onOpenChange={setOpen}
          title={label} status={status} icon={<ToolIcon name="agent" />} meta={rowMeta || undefined}
          collapseOnComplete={false} bare={imageOnly} contentClassName={WRAP_OUTPUT}>
          {renderOutput(output || placeholder(t('tool.noOutput')))}
        </ToolResult>
      )
    }
    case 'bash': {
      if (backgroundTask) return <BashTaskRow task={backgroundTask} />
      const command = typeof args.command === 'string' ? args.command : JSON.stringify(args)
      const firstLine = command.split('\n')[0]
      return (
        <ToolResult
          animateChanges={false}
          lazyContent
          open={open}
          onOpenChange={setOpen}
          // A multi-line command (heredoc, `&&` chain) only shows its first
          // line here; the ellipsis marks that the rest is in the expansion.
          title={`bash · ${firstLine.slice(0, 72)}${firstLine.length > 72 || command.includes('\n') ? '…' : ''}`}
          status={status}
          icon={<ToolIcon name="bash" />}
          meta={meta}
          defaultOpen={false}
          collapseOnComplete={false}
          bare={imageOnly} contentClassName={WRAP_OUTPUT}
        >
          {renderOutput(
            (status === 'running' ? output.slice(-4000) : output) ||
              (status === 'running' ? '' : placeholder(t('tool.noOutput')))
          )}
        </ToolResult>
      )
    }

    case 'edit': {
      const path = String(args.path ?? '')
      const diff = patchOf(result, run)?.patch
      if (typeof diff === 'string' && diff) {
        return (
          <LazyDiff
            tool="edit"
            file={fileToolLabel('edit', path, cwd)}
            diff={diff}
            status={status === 'running' ? 'streaming' : 'complete'}
          />
        )
      }
      return (
        <ToolResult
          animateChanges={false}
          lazyContent
          open={open}
          onOpenChange={setOpen}
          title={fileToolLabel('edit', path, cwd)}
          status={status}
          icon={<ToolIcon name="edit" />}
          meta={meta}
          defaultOpen={false}
          collapseOnComplete={false}
          bare={imageOnly} contentClassName={WRAP_OUTPUT}
        >
          {renderOutput(output || (status === 'running' ? t('tool.editing') : placeholder(t('tool.noDiff'))))}
        </ToolResult>
      )
    }

    case 'write': {
      const path = String(args.path ?? '')
      const content = typeof args.content === 'string' ? args.content : ''
      // pi's `write` returns no `details`, so the diff comes from the content
      // the call wrote — the same all-insertion patch the turn's changed-files
      // list derives. A real `details.patch` still wins if a future SDK adds
      // one.
      //
      // That patch is the call's INTENT, not an outcome, so only a successful
      // result may render it. A denied write (empty `details`, `isError`) would
      // otherwise paint a green all-insertion diff under the "applied" check for
      // a file the sandbox refused — and, because this branch returns before the
      // output, hide the denial, which is the only useful thing the row has to
      // show. A running call keeps its plain "Writing file…" row for the same
      // reason: `arguments.content` is streamed in full before the file exists,
      // so a growing diff there is a promise, not a fact. (`edit` never had
      // this loophole: its diff comes only from `details.patch`, which a denial
      // does not carry.)
      const applied = result !== undefined && !result.isError
      const diff = applied
        ? patchOf(result, run)?.patch ?? synthesizeWritePatch(path, content) ?? undefined
        : undefined
      if (typeof diff === 'string' && diff) {
        return (
          <LazyDiff
            tool="write"
            file={fileToolLabel('write', path, cwd)}
            diff={diff}
            // Only reachable once a result landed, so this diff is always
            // settled: it must not spin, auto-open, auto-scroll or defer its
            // colors the way a streaming diff does.
            status="complete"
          />
        )
      }
      return (
        <ToolResult
          animateChanges={false}
          lazyContent
          open={open}
          onOpenChange={setOpen}
          title={fileToolLabel('write', path, cwd)}
          status={status}
          icon={<ToolIcon name="write" />}
          meta={meta}
          defaultOpen={false}
          collapseOnComplete={false}
          bare={imageOnly} contentClassName={WRAP_OUTPUT}
        >
          {renderOutput(
            status === 'running'
              ? t('tool.writingFile')
              // A failed call wrote nothing, so it must not claim "Wrote x" when
              // the result carries no text of its own; `placeholder` still
              // reports a call the turn never got to start.
              : output || placeholder(status === 'error' ? t('tool.noOutput') : t('tool.wrote', { file: basename(path) }))
          )}
        </ToolResult>
      )
    }

    case 'read': {
      const path = String(args.path ?? '')
      return (
        <ToolResult
          animateChanges={false}
          lazyContent
          open={open}
          onOpenChange={setOpen}
          title={fileToolLabel('read', path, cwd)}
          status={status}
          icon={<ToolIcon name="read" />}
          meta={meta}
          defaultOpen={false}
          collapseOnComplete={false}
          bare={imageOnly} contentClassName={WRAP_OUTPUT}
        >
          {renderOutput(
            status === 'running' ? t('tool.reading') : output.slice(0, 4000) || placeholder(t('tool.emptyFile'))
          )}
        </ToolResult>
      )
    }

    default: {
      const controlAction = call.name === 'bash_task' &&
        (args.action === 'list' || args.action === 'status' || args.action === 'output' || args.action === 'stop')
        ? args.action as 'list' | 'status' | 'output' | 'stop' : undefined
      const label =
        controlAction
          ? `bash_task · ${t(`bashTask.action.${controlAction}`)}`
          : call.name === 'grep'
          ? `grep · ${String(args.pattern ?? '')}`
          : call.name === 'find'
            ? `find · ${String(args.pattern ?? '')}`
            : call.name === 'ls'
              ? `ls · ${String(args.path ?? '.')}`
              : call.name
      return (
        <ToolResult
          animateChanges={false}
          lazyContent
          open={open}
          onOpenChange={setOpen}
          title={label}
          status={status}
          icon={<ToolIcon name={call.name} />}
          meta={meta}
          defaultOpen={false}
          collapseOnComplete={false}
          bare={imageOnly} contentClassName={WRAP_OUTPUT}
        >
          {renderOutput(
            status === 'running'
              ? t('tool.runningPlaceholder')
              : output.slice(0, 4000) || placeholder(t('tool.noOutput'))
          )}
        </ToolResult>
      )
    }
  }
})
