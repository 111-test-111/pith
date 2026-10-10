import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { ArrowLeft, History, X } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { useScrollFade } from '@/lib/hooks/use-scroll-fade'
import { FileTypeIcon } from '../FileTypeIcon'
import { cn } from '@/lib/utils'
import { GitStatus } from './GitStatus'
import type { GitState, GitStore } from '@/state/git-store'

/** The commit list stays mounted when a separate detail surface opens. */
export function GitHistoryList({ state, store, detail = false, backLabel }: { state: GitState; store: GitStore; detail?: boolean; backLabel?: string }) {
  const { t, locale } = useI18n(), scroll = useRef<HTMLDivElement>(null)
  const rows = detail ? state.commitFiles : state.history.commits
  const error = detail ? state.commitError : state.historyError
  const loading = detail ? state.commitFilesLoading : state.historyLoading
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => detail ? 36 : 64, overscan: 6, getItemKey: index => detail ? state.commitFiles[index].path : state.history.commits[index].id })
  const { maskImage } = useScrollFade(scroll, { dependsOn: rows })
  const dates = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' })
  return <section className="flex min-h-0 min-w-0 flex-1 flex-col" data-git-history data-mode={detail ? 'detail' : 'list'}>
    {detail && state.commit ? <div className="shrink-0 space-y-1 border-b border-border/60 p-2">
      {backLabel ? <Button variant="ghost" size="sm" className="h-7 gap-1 px-1 text-xs" onClick={() => void store.selectCommit(null)}><ArrowLeft aria-hidden className="size-3.5" />{backLabel}</Button> : null}
      <div className="flex items-start gap-2"><p className="min-w-0 flex-1 break-words text-sm font-medium">{state.commit.subject}</p>{!backLabel ? <Tooltip content={t('git.closeCommit')}><Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={t('git.closeCommit')} onClick={() => void store.selectCommit(null)}><X aria-hidden className="size-3.5" /></Button></Tooltip> : null}</div>
      <p className="break-all text-xs text-muted-foreground">{state.commit.id.slice(0, 12)} · {state.commit.author} · {dates.format(new Date(state.commit.date))}</p>
      {state.commit.body ? <p className="max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">{state.commit.body}</p> : null}
    </div> : null}
    {error ? <div role="alert" className="flex shrink-0 items-start gap-2 p-2"><p className="min-w-0 flex-1 text-xs text-destructive">{t(`git.error.${error.code}`)}</p><Button variant="outline" size="sm" className="h-6 text-xs" disabled={loading} onClick={() => { if (detail && state.commit) void store.selectCommit(state.commit); else void store.loadHistory() }}>{t('git.retry')}</Button></div> : null}
    <div ref={scroll} data-git-history-scroll className="min-h-0 flex-1 overflow-y-auto px-1 py-1" style={{ maskImage, WebkitMaskImage: maskImage }}>
      <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
        {virtual.getVirtualItems().map(row => <div key={row.key} className="absolute left-0 top-0 w-full px-1" style={{ height: row.size, transform: `translateY(${row.start}px)` }}>
          {detail ? <Button variant="ghost" size="sm" data-git-commit-file={state.commitFiles[row.index].path} aria-label={t('git.openFileDiff', { path: state.commitFiles[row.index].path })} className={cn('h-9 w-full justify-start gap-2 font-normal', state.selection?.path === state.commitFiles[row.index].path && 'bg-primary/10')} aria-pressed={state.selection?.path === state.commitFiles[row.index].path} onClick={() => void store.select({ path: state.commitFiles[row.index].path, area: 'commit', commit: state.commit!.id })}>
            <FileTypeIcon path={state.commitFiles[row.index].path} variant="tree" className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-left text-xs">{state.commitFiles[row.index].path}</span><GitStatus status={state.commitFiles[row.index].status} />
          </Button> : <Button variant="ghost" size="sm" data-git-commit={state.history.commits[row.index].id} className={cn('h-full w-full items-start justify-start gap-2 px-2 py-2 font-normal', state.commit?.id === state.history.commits[row.index].id && 'bg-primary/10')} aria-pressed={state.commit?.id === state.history.commits[row.index].id} onClick={() => void store.selectCommit(state.history.commits[row.index])}>
            <History aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 text-left"><span className="block truncate text-xs font-medium">{state.history.commits[row.index].subject}</span><span className="mt-1 block truncate text-caption text-muted-foreground">{state.history.commits[row.index].id.slice(0, 7)} · {state.history.commits[row.index].author} · {dates.format(new Date(state.history.commits[row.index].date))}</span></span>
          </Button>}
        </div>)}
      </div>
      {loading ? <p role="status" className="p-2 text-xs text-muted-foreground">{t('git.loading')}</p> : !error && !rows.length ? <p className="p-3 text-xs text-muted-foreground">{t(detail ? 'git.noFiles' : 'git.noHistory')}</p> : null}
      {!detail && state.history.next !== null ? <Button variant="outline" size="sm" className="m-2 text-xs" disabled={state.historyLoading} onClick={() => void store.loadHistory(true)}>{t('git.moreHistory')}</Button> : null}
    </div>
  </section>
}
