import { useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/motion/button'
import { useI18n } from '@/i18n'
import { useScrollFade } from '@/lib/hooks/use-scroll-fade'
import { useWheelScroll } from '@/lib/hooks/use-wheel-scroll'
import { cn } from '@/lib/utils'
import { GitCommitDetail } from './GitCommitDetail'
import { useGitSplit } from './use-git-split'
import { layoutGitGraph } from './graph-layout'
import type { GitState, GitStore } from '@/state/git-store'
import type { GitGraphRef } from '../../../../../shared/git'

const ROW_HEIGHT = 60
const EMPTY: NonNullable<GitState['graph']>['commits'] = []
const COLORS = ['text-sky-500', 'text-violet-500', 'text-emerald-500', 'text-amber-500', 'text-rose-500', 'text-cyan-500']
const color = (lane: number) => COLORS[lane % COLORS.length]
const refColor = (kind: GitGraphRef['kind']) => kind === 'head' ? 'border-primary/30 bg-primary/10 text-primary' : kind === 'tag' ? 'border-amber-500/25 text-amber-600 dark:text-amber-400' : kind === 'remote' ? 'border-sky-500/25 text-sky-600 dark:text-sky-400' : 'border-emerald-500/25 text-emerald-600 dark:text-emerald-400'

/** All public refs, independent of checkout; DOM paths and rows share one window. */
export function GitGraphView({ state, store }: { state: GitState; store: GitStore }) {
  const { t, locale } = useI18n(), scroll = useRef<HTMLDivElement>(null)
  const split = useGitSplit(state, store, !!state.commit)
  const commits = state.graph?.commits ?? EMPTY
  const layout = useMemo(() => layoutGitGraph(commits, { rowHeight: ROW_HEIGHT, laneGap: 16, lanePadding: 18, topPadding: ROW_HEIGHT / 2, bottomPadding: ROW_HEIGHT / 2 }), [commits])
  const boundaries = useMemo(() => { const ids = new Set(commits.map(commit => commit.id)); return new Set(commits.filter(commit => commit.parents.some(parent => !ids.has(parent))).map(commit => commit.id)) }, [commits])
  const virtual = useVirtualizer({ count: commits.length, getScrollElement: () => scroll.current, estimateSize: () => ROW_HEIGHT, overscan: 6, getItemKey: index => commits[index].id })
  const items = virtual.getVirtualItems(), first = items[0]?.index ?? 0, last = items.at(-1)?.index ?? -1
  const paths = useMemo(() => layout.paths.filter(path => path.fromRow <= last && path.toRow >= first), [layout, first, last])
  const { maskImage } = useScrollFade(scroll, { dependsOn: commits })
  useWheelScroll(scroll)
  const dates = useMemo(() => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }), [locale])
  const start = first * ROW_HEIGHT, height = Math.max(0, (last - first + 1) * ROW_HEIGHT)
  return <section data-git-graph className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-2"><span className="text-xs font-medium">{t('git.graph')}</span><span className="truncate text-xs text-muted-foreground">{t('git.graphScope')}</span></div>
    <div ref={split.ref} className="git-graph-body min-h-0 min-w-0 flex-1" data-has-commit={!!state.commit}>
      <div data-git-master data-pane-master className="git-master flex min-h-0 min-w-0 flex-col">
        {state.graphError ? <div role="alert" className="flex shrink-0 items-center gap-2 px-3 py-2"><p className="min-w-0 flex-1 text-xs text-destructive">{t(`git.error.${state.graphError.code}`)}</p><Button variant="outline" size="sm" className="h-7 text-xs" disabled={state.graphLoading} onClick={() => void store.loadGraph()}>{t('git.retry')}</Button></div> : null}
        <div ref={scroll} data-git-graph-scroll className="min-h-0 flex-1 overflow-auto px-1 py-1" style={{ maskImage, WebkitMaskImage: maskImage }}>
          <div className="relative min-w-full" style={{ height: virtual.getTotalSize(), minWidth: layout.width + 200 }}>
            {items.map(item => {
              const row = layout.rows[item.index], commit = row.commit, selected = state.commit?.id === commit.id
              return <div key={item.key} className="absolute left-0 top-0 w-full px-1" style={{ height: item.size, transform: `translateY(${item.start}px)` }}>
                <Button variant="ghost" size="sm" data-git-graph-commit={commit.id} aria-pressed={selected} title={t('git.graphCommit', { subject: commit.subject, hash: commit.id, parents: commit.parents.length })} className={cn('h-full w-full justify-start gap-0 px-0 font-normal', selected && 'bg-primary/10')} onClick={() => void store.selectCommit(commit)}>
                  <span aria-hidden className="shrink-0" style={{ width: layout.width }} />
                  <span className="min-w-0 flex-1 space-y-1 pr-2 text-left"><span className="block truncate text-xs font-medium">{commit.subject}</span><span className="flex min-w-0 items-center gap-1 overflow-hidden">
                    {commit.refs.slice(0, 3).map(ref => <span key={`${ref.kind}:${ref.name}`} data-git-graph-ref={ref.name} title={t(`git.graphRef.${ref.kind}`, { name: ref.name })} className={cn('max-w-40 shrink-0 truncate rounded-inner border px-1 text-caption', refColor(ref.kind))}>{ref.name}</span>)}
                    {commit.refs.length > 3 ? <span title={commit.refs.slice(3).map(ref => t(`git.graphRef.${ref.kind}`, { name: ref.name })).join('\n')} className="shrink-0 text-caption text-muted-foreground">{t('git.moreRefs', { count: commit.refs.length - 3 })}</span> : null}
                    <span className="min-w-0 truncate text-caption text-muted-foreground">{commit.author} · {dates.format(new Date(commit.date))}</span><span className="git-graph-hash shrink-0 font-mono text-caption text-muted-foreground">{commit.id.slice(0, 7)}</span>
                  </span></span>
                </Button>
              </div>
            })}
            {height ? <svg aria-hidden data-git-graph-canvas className="pointer-events-none absolute left-1" style={{ top: start }} width={layout.width} height={height} viewBox={`0 ${start} ${layout.width} ${height}`}>
              {paths.map(path => <path key={path.id} d={path.path} className={color(path.laneIndex)} fill="none" stroke="currentColor" strokeWidth={state.commit && path.relatedHashes.includes(state.commit.id) ? 2.5 : 1.5} />)}
              {items.map(item => { const row = layout.rows[item.index]; return <g key={row.commit.id} className={color(row.laneIndex)}>
                {boundaries.has(row.commit.id) ? <path d={`M ${row.x} ${row.y + 5} v 14`} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="2 3" /> : null}
                <circle cx={row.x} cy={row.y} r={row.commit.parents.length > 1 ? 5 : 4} fill="var(--background)" stroke="currentColor" strokeWidth={state.commit?.id === row.commit.id ? 3 : 2} />
                {row.commit.parents.length > 1 ? <circle cx={row.x} cy={row.y} r={1.5} fill="currentColor" /> : null}
              </g> })}
            </svg> : null}
          </div>
          {!commits.length ? <p role={state.graphLoading ? 'status' : undefined} className="p-3 text-xs text-muted-foreground">{t(state.graphLoading ? 'git.loading' : 'git.noHistory')}</p> : null}
          {state.graph?.next !== null && state.graph?.next !== undefined ? <Button variant="outline" size="sm" className="m-2 text-xs" disabled={state.graphLoading} onClick={() => void store.loadGraph(true)}>{t('git.moreHistory')}</Button> : null}
          {state.graph?.limited ? <p className="p-3 text-xs text-muted-foreground">{t('git.graphLimit', { count: commits.length })}</p> : null}
          {boundaries.size ? <p className="px-3 py-2 text-caption text-muted-foreground">{t('git.graphBoundary')}</p> : null}
        </div>
      </div>
      {split.handle}
      {state.commit ? <GitCommitDetail state={state} store={store} view="graph" /> : null}
    </div>
  </section>
}
