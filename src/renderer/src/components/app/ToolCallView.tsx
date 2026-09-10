import { FileDiff } from '@/components/agents/file-diff'
import { ToolResult, ToolResultOutput } from '@/components/agents/tool-result'
import { parseUnifiedDiff, diffStats } from '@/lib/diff'
import { basename } from '@/lib/format'
import type { ToolCallContent, ToolResultMsg } from '../../../../shared/types'
import type { ToolRun } from '@/state/pi-store'
import { useI18n } from '@/i18n'

interface ToolCallViewProps {
  call: ToolCallContent
  result?: ToolResultMsg
  run?: ToolRun
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

/**
 * Maps a pi tool call + its execution state onto beUI disclosure components:
 * bash/read/search tools become ToolResult terminals, edit/write become
 * FileDiff surfaces driven by the unified diff in the tool details.
 */
export function ToolCallView({ call, result, run }: ToolCallViewProps) {
  const { t } = useI18n()
  const status = statusOf(result, run)
  const metaInfo = metaOf(result, run)
  const meta = metaInfo.live
    ? t('tool.live')
    : metaInfo.seconds !== undefined
      ? t('tool.duration', { seconds: metaInfo.seconds.toFixed(1) })
      : undefined
  const args = call.arguments ?? {}
  const output = resultText(result ?? run)

  switch (call.name) {
    case 'bash': {
      const command = typeof args.command === 'string' ? args.command : JSON.stringify(args)
      return (
        <ToolResult
          tool="bash"
          title={`bash · ${command.split('\n')[0].slice(0, 72)}`}
          status={status}
          kind="terminal"
          meta={meta}
          copyText={output || command}
          defaultOpen={false}
          collapseOnComplete={false}
          contentClassName={WRAP_OUTPUT}
        >
          <ToolResultOutput language="bash">
            {output || (status === 'running' ? '' : t('tool.noOutput'))}
          </ToolResultOutput>
        </ToolResult>
      )
    }

    case 'edit': {
      const path = String(args.path ?? '')
      const diff = (result?.details as any)?.diff ?? (run?.partial as any)?.details?.diff
      if (typeof diff === 'string' && diff) {
        const lines = parseUnifiedDiff(diff)
        const { added, removed } = diffStats(lines)
        return (
          <FileDiff
            file={`edit · ${basename(path)}${path && !path.includes('/') ? '' : ` — ${path}`}`}
            lines={lines}
            status={status === 'running' ? 'streaming' : 'complete'}
            defaultOpen={false}
            collapseOnComplete={false}
          />
        )
      }
      return (
        <ToolResult
          tool="edit"
          title={`edit · ${basename(path)}`}
          status={status}
          kind="terminal"
          meta={meta}
          defaultOpen={false}
          collapseOnComplete={false}
          contentClassName={WRAP_OUTPUT}
        >
          <ToolResultOutput>{output || (status === 'running' ? t('tool.editing') : t('tool.noDiff'))}</ToolResultOutput>
        </ToolResult>
      )
    }

    case 'write': {
      const path = String(args.path ?? '')
      const diff = (result?.details as any)?.diff
      if (typeof diff === 'string' && diff) {
        const lines = parseUnifiedDiff(diff)
        return (
          <FileDiff
            file={`write · ${basename(path)}`}
            lines={lines}
            status={status === 'running' ? 'streaming' : 'complete'}
            defaultOpen={false}
            collapseOnComplete={false}
          />
        )
      }
      return (
        <ToolResult
          tool="write"
          title={`write · ${basename(path)}`}
          status={status}
          kind="terminal"
          meta={meta}
          defaultOpen={false}
          collapseOnComplete={false}
          contentClassName={WRAP_OUTPUT}
        >
          <ToolResultOutput>
            {status === 'running' ? t('tool.writingFile') : output || t('tool.wrote', { file: basename(path) })}
          </ToolResultOutput>
        </ToolResult>
      )
    }

    case 'read': {
      const path = String(args.path ?? '')
      return (
        <ToolResult
          tool="read"
          title={`read · ${basename(path)}`}
          status={status}
          kind="terminal"
          meta={meta}
          defaultOpen={false}
          collapseOnComplete={false}
          contentClassName={WRAP_OUTPUT}
        >
          <ToolResultOutput>
            {status === 'running' ? t('tool.reading') : output.slice(0, 4000) || t('tool.emptyFile')}
          </ToolResultOutput>
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
          tool={call.name}
          title={label}
          status={status}
          kind="terminal"
          meta={meta}
          defaultOpen={false}
          collapseOnComplete={false}
          contentClassName={WRAP_OUTPUT}
        >
          <ToolResultOutput>
            {status === 'running' ? t('tool.runningPlaceholder') : output.slice(0, 4000) || t('tool.noOutput')}
          </ToolResultOutput>
        </ToolResult>
      )
    }
  }
}
