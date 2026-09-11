import { memo, useMemo, useState } from 'react'
import { FileDiff } from '@/components/agents/file-diff'
import { ToolResult, ToolResultOutput } from '@/components/agents/tool-result'
import { parseUnifiedDiff, countDiffChanges } from '@/lib/diff'
import { basename } from '@/lib/format'
import type { ImageContent, ToolCallContent, ToolResultMsg } from '../../../../shared/types'
import type { ToolRun } from '@/state/pi-store'
import { useI18n } from '@/i18n'

interface ToolCallViewProps {
  call: ToolCallContent
  result?: ToolResultMsg
  run?: ToolRun
}

/** Image parts a tool returned (the SDK's read tool inlines image files). */
function resultImages(source: ToolResultMsg | ToolRun | undefined): ImageContent[] {
  if (!source) return []
  const content = 'content' in source && Array.isArray((source as ToolResultMsg).content)
    ? (source as ToolResultMsg).content
    : (source as ToolRun).partial?.content
  if (!Array.isArray(content)) return []
  return content.filter((part: any): part is ImageContent => part?.type === 'image' && Boolean(part.data))
}

function ResultImages({ images }: { images: ImageContent[] }) {
  const { t } = useI18n()
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {images.map((image, index) => (
        <img
          key={index}
          src={`data:${image.mimeType};base64,${image.data}`}
          alt={t('chat.imageAlt', { index: index + 1 })}
          className="max-h-64 max-w-full rounded-lg border border-border object-contain"
        />
      ))}
    </div>
  )
}

function resultText(source: ToolResultMsg | ToolRun | undefined): string {
  if (!source) return ''
  if ('content' in source && Array.isArray((source as ToolResultMsg).content)) {
    return (source as ToolResultMsg).content
      .map((part) => (part.type === 'text' ? part.text : '[image]'))
      .join('\n')
  }
  const partial = (source as ToolRun).partial
  if (partial?.content) {
    return partial.content
      .map((part: any) => (part.type === 'text' ? part.text : '[image]'))
      .join('\n')
  }
  return ''
}

function statusOf(result: ToolResultMsg | undefined, run: ToolRun | undefined) {
  if (result) return result.isError ? 'error' : 'success'
  if (run) return run.status === 'running' ? 'running' : run.status
  return 'running' as const
}

/**
 * Tool output is free-form text (command output, file contents, SDK errors),
 * not a script — the default bash grammar tokenized it and colored the first
 * word as a command. Render all of it as plain text; failures get the
 * destructive color.
 */
function outputProps(status: ReturnType<typeof statusOf>) {
  return {
    language: 'text' as const,
    highlight: false,
    ...(status === 'error' ? { className: 'text-destructive' } : {}),
  }
}

/** Live marker or run duration; the label itself is localized by the caller. */
function metaOf(result: ToolResultMsg | undefined, run: ToolRun | undefined): { live: boolean; seconds?: number } {
  if (run?.startedAt && (run.status === 'running' || !result)) return { live: true }
  if (run?.startedAt && run.endedAt) {
    return { live: false, seconds: Math.max(0.1, (run.endedAt - run.startedAt) / 1000) }
  }
  return { live: false }
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
}

/** Keep diff parsing and line rendering out of the hot path while the card is
 * collapsed. Historical sessions commonly contain many large edit results. */
function LazyDiff({ file, diff, status }: LazyDiffProps) {
  const [open, setOpen] = useState(false)
  // Counts for the collapsed header; parsing the full diff into rows stays
  // deferred until the user opens it.
  const changes = useMemo(() => countDiffChanges(diff), [diff])
  return (
    <FileDiff
      lazyContent
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
 * Maps a pi tool call + its execution state onto beUI disclosure components:
 * bash/read/search tools become ToolResult terminals, edit/write become
 * FileDiff surfaces driven by the unified diff in the tool details.
 */
export const ToolCallView = memo(function ToolCallView({ call, result, run }: ToolCallViewProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const status = statusOf(result, run)
  const metaInfo = metaOf(result, run)
  const meta = metaInfo.live
    ? t('tool.live')
    : metaInfo.seconds !== undefined
      ? t('tool.duration', { seconds: metaInfo.seconds.toFixed(1) })
      : undefined
  const args = call.arguments ?? {}
  const images = resultImages(result ?? run)
  // Tool payloads can be large cumulative snapshots. Do not flatten them into
  // text on every update unless the user is actually viewing this disclosure.
  const output = open ? resultText(result ?? run) : ''
  // Text output plus any image content the tool returned.
  const renderOutput = (children: string) => (
    <>
      <ToolResultOutput {...outputProps(status)}>{children}</ToolResultOutput>
      {images.length ? <ResultImages images={images} /> : null}
    </>
  )

  switch (call.name) {
    case 'bash': {
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
          kind="terminal"
          meta={meta}
          copyText={output || command}
          defaultOpen={false}
          collapseOnComplete={false}
          contentClassName={WRAP_OUTPUT}
        >
          {renderOutput(
            (status === 'running' ? output.slice(-4000) : output) || (status === 'running' ? '' : t('tool.noOutput'))
          )}
        </ToolResult>
      )
    }

    case 'edit': {
      const path = String(args.path ?? '')
      const diff = (result?.details as any)?.diff ?? (run?.partial as any)?.details?.diff
      if (typeof diff === 'string' && diff) {
        return (
          <LazyDiff
            file={`edit · ${basename(path)}${path && !path.includes('/') ? '' : ` — ${path}`}`}
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
          title={`edit · ${basename(path)}`}
          status={status}
          kind="terminal"
          meta={meta}
          defaultOpen={false}
          collapseOnComplete={false}
          contentClassName={WRAP_OUTPUT}
        >
          {renderOutput(output || (status === 'running' ? t('tool.editing') : t('tool.noDiff')))}
        </ToolResult>
      )
    }

    case 'write': {
      const path = String(args.path ?? '')
      const diff = (result?.details as any)?.diff
      if (typeof diff === 'string' && diff) {
        return (
          <LazyDiff
            file={`write · ${basename(path)}`}
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
          title={`write · ${basename(path)}`}
          status={status}
          kind="terminal"
          meta={meta}
          defaultOpen={false}
          collapseOnComplete={false}
          contentClassName={WRAP_OUTPUT}
        >
          {renderOutput(
            status === 'running' ? t('tool.writingFile') : output || t('tool.wrote', { file: basename(path) })
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
          title={`read · ${basename(path)}`}
          status={status}
          kind="terminal"
          meta={meta}
          defaultOpen={false}
          collapseOnComplete={false}
          contentClassName={WRAP_OUTPUT}
        >
          {renderOutput(status === 'running' ? t('tool.reading') : output.slice(0, 4000) || t('tool.emptyFile'))}
        </ToolResult>
      )
    }

    default: {
      const label =
        call.name === 'grep'
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
          kind="terminal"
          meta={meta}
          defaultOpen={false}
          collapseOnComplete={false}
          contentClassName={WRAP_OUTPUT}
        >
          {renderOutput(
            status === 'running' ? t('tool.runningPlaceholder') : output.slice(0, 4000) || t('tool.noOutput')
          )}
        </ToolResult>
      )
    }
  }
})
