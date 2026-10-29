import { useRef } from 'react'
import { Button } from '@/components/motion/button'
import { Bell, Braces, Minimize2, Play, RefreshCw, User, Wrench, type IconComponent } from '@/lib/icons'
import { StatusRing } from '@/lib/status-ring'
import { toolIconComponent } from '@/lib/tool-icons'
import { useScrollFade } from '@/lib/hooks/use-scroll-fade'
import { useWheelScroll } from '@/lib/hooks/use-wheel-scroll'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import { trajectoryPresentationKind, type TrajectoryPresentationKind, type TrajectoryQuery, type TrajectoryRecord } from '../../../../shared/trajectory'

const RECORD_ICONS: Record<Exclude<TrajectoryPresentationKind, 'tool'>, IconComponent> = {
  run: Play, user: User, request: Braces,
  compaction: Minimize2, retry: RefreshCw, notification: Bell
}

function RecordPreview({ text, monospace }: { text: string; monospace: boolean }) {
  const viewport = useRef<HTMLSpanElement>(null)
  const content = useRef<HTMLSpanElement>(null)
  const { maskImage } = useScrollFade(viewport, { axis: 'horizontal', contentRef: content, dependsOn: text })
  return <span ref={viewport} data-trajectory-preview className={cn('mt-0.5 block overflow-hidden whitespace-nowrap text-muted-foreground', monospace && 'font-mono')} style={{ maskImage }}>
    <span ref={content} className="inline-block">{text}</span>
  </span>
}

function ToolCallLinks({ record, onSelect }: { record: TrajectoryRecord; onSelect(call: NonNullable<TrajectoryQuery['toolCall']>): void }) {
  const { t } = useI18n()
  const viewport = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  useWheelScroll(viewport)
  const { maskImage } = useScrollFade(viewport, { axis: 'horizontal', contentRef: content, dependsOn: record.toolCalls })
  return <div ref={viewport} data-trajectory-tool-calls className="absolute bottom-1.5 left-7 right-1.5 h-4 overflow-x-auto overflow-y-hidden" style={{ maskImage }}>
    <div ref={content} className="flex h-4 w-max min-w-full items-center gap-1">
      {record.toolCalls?.map((call, index) => <Button key={`${call.id}:${index}`} data-trajectory-tool-call={call.id} variant="ghost" size="icon"
        className="h-4 w-4 shrink-0 p-0 text-muted-foreground hover:bg-transparent hover:text-primary focus-visible:ring-inset focus-visible:ring-offset-0"
        aria-label={t('trajectory.jumpTool', { name: call.name, index: index + 1 })} title={t('trajectory.jumpTool', { name: call.name, index: index + 1 })}
        onClick={() => onSelect({ recordId: record.id, callId: call.id })}><Wrench aria-hidden="true" className="size-3.5" /></Button>)}
    </div>
  </div>
}

/** Content at the leading edge; the transcript's shared outcome mark at the
 * trailing edge. The excerpt never loads or renders a complete document. */
export function TrajectoryRecordRow({ record, selected, reduce, onSelect, onToolSelect }: {
  record: TrajectoryRecord; selected: boolean; reduce: boolean; onSelect(record: TrajectoryRecord): void
  onToolSelect(call: NonNullable<TrajectoryQuery['toolCall']>): void
}) {
  const { t } = useI18n()
  const displayKind = trajectoryPresentationKind(record.kind)
  const Icon = displayKind === 'tool' ? toolIconComponent(record.name) : RECORD_ICONS[displayKind]
  const status = record.status === 'running' ? 'running' : record.status === 'failed' ? 'error' : record.status === 'completed' ? 'success' : 'cancelled'
  const hasCalls = Boolean(record.toolCalls?.length)
  const name = hasCalls ? record.model ?? (record.name !== 'assistant' ? record.name : undefined)
    : record.kind === 'assistant' ? record.model : record.kind === 'run' || record.kind === 'user' ? undefined : record.name
  return <div data-trajectory-entry={record.id} className="border-b border-border/50 last:border-b-0">
  <div className="relative">
  <Button data-trajectory-record={record.id} size="sm" variant="ghost" className="trajectory-choice h-auto min-h-8 w-full items-start justify-start gap-2 px-1.5 py-1.5 text-xs leading-ui-tight" aria-pressed={selected} onClick={() => onSelect(record)}>
    <Icon data-trajectory-content-icon={record.kind === 'tool' ? record.name : displayKind} aria-hidden="true" className="mt-px size-3.5 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1 text-left">
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate"><span className="text-muted-foreground">{hasCalls ? t('trajectory.modelToolCalls') : t(`trajectory.kind.${displayKind}`)}</span>{name ? <> · {name}</> : null}</span>
        {record.finishedAt !== undefined ? <span data-trajectory-duration className="shrink-0 tabular-nums text-muted-foreground">{(Math.max(0, record.finishedAt - record.startedAt) / 1000).toFixed(2)} s</span> : null}
        <span data-trajectory-status={record.status} title={t(`trajectory.status.${record.status}`)} className={cn('inline-flex shrink-0 items-center',
          status === 'running' ? 'text-blue-600 dark:text-blue-400' : status === 'success' ? 'text-emerald-600 dark:text-emerald-400' : status === 'error' ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground')}>
          <span aria-hidden="true"><StatusRing className="size-3" reduce={reduce} status={status} /></span>
          <span className="sr-only">{t(`trajectory.status.${record.status}`)}</span>
        </span>
      </span>
      {hasCalls ? <span aria-hidden="true" className="mt-0.5 block h-4" /> : record.preview ? <RecordPreview text={record.preview} monospace={record.kind === 'tool' && (record.name === 'bash' || record.name === 'bash_task')} /> : null}
    </span>
  </Button>
  {hasCalls ? <ToolCallLinks record={record} onSelect={onToolSelect} /> : null}
  </div>
  </div>
}
