import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Tooltip } from '@/components/motion/tooltip'
import { ArrowUp, ArrowDown, Plus, RefreshCw, CloudDownload, Download, Upload, X } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { GitFileList } from './GitFileList'
import { GitDiffPreview } from './GitDiffPreview'
import { GitHistoryList } from './GitHistoryList'
import { GitCommitDetail } from './GitCommitDetail'
import { useGitSplit } from './use-git-split'
import { GitGraphView } from './GitGraphView'
import { GitBranchPicker } from './GitBranchPicker'
import { GitDialog, type GitDialogKind } from './GitDialog'
import type { GitStore } from '@/state/git-store'
import type { PiStore } from '@/state/pi-store'

export function GitPane({ git, store }: { git: GitStore; store: PiStore }) {
  const { t } = useI18n(), shell = useSyncExternalStore(store.subscribe, store.getShell)
  const state = useSyncExternalStore(git.subscribe, git.getState)
  const hasDetail = state.view === 'history' ? !!state.commit : !!state.selection
  const split = useGitSplit(state, git, state.view !== 'graph' && hasDetail)
  const [dialog, setDialog] = useState<GitDialogKind | null>(null)
  const closeDialog = useCallback(() => setDialog(null), [])
  const closeActiveDialog = useCallback(() => setDialog(current => current === dialog ? null : current), [dialog])
  useEffect(() => { git.bind(shell.projectless ? null : shell.cwd); closeDialog(); void git.refresh() }, [git, shell.cwd, shell.projectless, shell.subagentChild, shell.scheduledTaskSession, closeDialog])
  useEffect(() => { git.setVisible(true); return () => git.setVisible(false) }, [git])
  const repo = state.repository, view = state.view
  const disabled = !!state.busy || !!state.error || !!repo?.blocked || shell.subagentChild || shell.scheduledTaskSession
  const iconAction = (label: string, Icon: typeof Plus, action: () => void, off = disabled) => <Tooltip content={label}><Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={label} disabled={off} onClick={action}><Icon aria-hidden className="size-4" /></Button></Tooltip>
  const discard = async (paths: string[]) => { const preview = await git.prepareDiscard(paths); if (preview && state.cwd && repo) setDialog({ kind: 'discard', preview, cwd: state.cwd, revision: repo.revision }) }
  const reload = () => { void git.refresh(); void git.loadBranches(); if (view === 'history') void git.loadHistory(); else if (view === 'graph') void git.loadGraph() }
  const reloadButton = iconAction(t('git.refresh'), RefreshCw, reload, !!state.busy || !state.cwd)
  /** Branch context, view switch, remote sync and reload share one row: the pane
   * opens on its changes instead of on a second title bar. The branch label
   * keeps its full text and only the room the row really has can shorten it,
   * so the fixed groups wrap below it in a pinned-narrow pane
   * (`RIGHT_PANEL_MIN`) rather than overflowing or clipping every label. */
  return <div data-git-pane data-git-root={repo?.root ?? state.cwd ?? undefined} className="flex h-full min-h-0 min-w-0 flex-col">
    <div data-git-toolbar className="flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-2 py-1">
      {repo ? <>
        {/* Branch context and the three views travel together: the chip takes
            the row's spare width only as its own shrink room, so the tabs stay
            beside it and the label ellipsizes before any group wraps. The floor
            is the widest tab strip; below it the actions wrap, never overlap. */}
        <div className="flex min-w-44 flex-1 items-center gap-2">
          <GitBranchPicker state={state} store={git} disabled={disabled} />
          <Tabs value={view} onValueChange={next => { if (next === 'changes' || next === 'history' || next === 'graph') git.setView(next) }} variant="underline" className="shrink-0">
            <TabsList className="h-8 border-b-0"><TabsTrigger value="changes" className="h-8 min-h-0 px-1.5 text-xs">{t('git.changes')}</TabsTrigger><TabsTrigger value="history" className="h-8 min-h-0 px-1.5 text-xs">{t('git.history')}</TabsTrigger><TabsTrigger value="graph" data-git-graph-tab className="h-8 min-h-0 px-1.5 text-xs">{t('git.graphTab')}</TabsTrigger></TabsList>
          </Tabs>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {repo.upstream ? <Tooltip content={t('git.upstreamCounts', { upstream: repo.upstream, ahead: repo.ahead, behind: repo.behind })}><span data-git-upstream className="inline-flex shrink-0 items-center pr-1 text-xs tabular-nums text-muted-foreground" aria-label={t('git.upstreamCounts', { upstream: repo.upstream, ahead: repo.ahead, behind: repo.behind })}><ArrowUp aria-hidden className="size-3" />{repo.ahead}<ArrowDown aria-hidden className="ml-1 size-3" />{repo.behind}</span></Tooltip> : repo.branch ? <Tooltip content={t('git.noUpstreamHint')}><span data-git-upstream className="shrink-0 pr-1 text-xs text-muted-foreground">{t('git.noUpstream')}</span></Tooltip> : null}
          {iconAction(t('git.fetch'), CloudDownload, () => void git.execute('fetch'), disabled || !repo.remotes.length)}
          {iconAction(t('git.pull'), Download, () => void git.execute('pull'), disabled || !repo.upstream || !repo.branch)}
          {iconAction(t('git.push'), Upload, () => repo.upstream ? void git.execute('push') : setDialog({ kind: 'push' }), disabled || !repo.branch || !repo.head || !repo.remotes.length)}
          <span aria-hidden="true" className="mx-0.5 h-3.5 w-px shrink-0 bg-border" />
          {reloadButton}
        </div>
      </> : <div className="ml-auto flex items-center">{reloadButton}</div>}
    </div>
    {!state.cwd ? <p className="p-4 text-sm text-muted-foreground">{t('git.chooseProject')}</p> : !repo ? <div className="space-y-3 p-4"><p role={state.error ? 'alert' : 'status'} className="text-sm text-muted-foreground">{state.loading ? t('git.loading') : state.error ? t(`git.error.${state.error.code}`) : t('git.loading')}</p>{state.error?.detail ? <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{state.error.detail}</pre> : null}{state.error?.code === 'not-repository' && !shell.subagentChild && !shell.scheduledTaskSession ? <Button variant="outline" size="sm" disabled={!!state.busy} onClick={() => setDialog({ kind: 'init' })}>{t('git.init')}</Button> : state.error ? <Button variant="outline" size="sm" onClick={() => void git.refresh()}>{t('git.retry')}</Button> : null}</div> : <>
      {view !== 'graph' ? <>
      {state.busy ? <div role="status" className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2 text-xs"><span className="flex-1">{t('git.running', { action: t(`git.action.${state.busy.action}`) })}</span><Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => void git.cancel()}>{t('common.cancel')}</Button></div> : null}
      {repo.operation ? <p role="status" className="shrink-0 px-3 py-2 text-xs text-destructive">{t('git.operationHint', { operation: repo.operation })}</p> : null}
      {state.actionError || state.error ? <div role="alert" className="shrink-0 border-b border-border/60 px-3 py-2"><div className="flex items-start gap-2"><p className="min-w-0 flex-1 text-xs text-destructive">{t(`git.error.${(state.actionError ?? state.error)!.code}`)}</p>{iconAction(t('git.dismiss'), X, () => git.dismissError(), false)}</div>{(state.actionError ?? state.error)?.detail ? <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-muted-foreground">{(state.actionError ?? state.error)!.detail}</pre> : null}</div> : null}
      {state.output && !state.actionError ? <div role="status" className="flex shrink-0 items-start gap-2 px-3 py-2"><span className="flex-1 text-xs text-muted-foreground">{t('git.done')}</span>{iconAction(t('git.dismiss'), X, () => git.dismissError(), false)}</div> : null}
      </> : null}
      {view === 'graph' ? <GitGraphView state={state} store={git} /> : <div ref={split.ref} className="git-content min-h-0 min-w-0 flex-1" data-has-detail={hasDetail} data-has-composer={view === 'changes'}>
        <div data-git-master data-pane-master className="git-master flex min-h-0 min-w-0 flex-col">{view === 'changes' ? <GitFileList files={repo.files} selection={state.selection} disabled={disabled} onSelect={selection => void git.select(selection)} onStage={paths => void git.execute('stage', { paths })} onUnstage={paths => void git.execute('unstage', { paths })} onDiscard={paths => void discard(paths)} /> : <GitHistoryList state={state} store={git} />}</div>
        {split.handle}
        {view === 'history' ? state.commit ? <GitCommitDetail state={state} store={git} view="history" /> : null : state.selection ? <GitDiffPreview state={state} store={git} /> : null}
      {view === 'changes' ? <div data-git-composer className="git-composer min-w-0 space-y-2 border-t border-border/60 p-3">
        <Input multiline rows={2} maxRows={6} value={state.draft} onChange={value => git.setDraft(value)} aria-label={t('git.commitMessage')} placeholder={t('git.commitPlaceholder')} disabled={!!state.busy} classNames={{ field: 'py-2', input: 'text-xs' }} />
        <div className="flex items-center justify-between gap-2"><p className="min-w-0 text-xs text-muted-foreground">{t('git.commitHint', { count: repo.files.filter(file => file.index !== '.' && !file.untracked && !file.conflict).length })}</p><Button size="sm" disabled={disabled || !!repo.operation || repo.files.some(file => file.conflict) || !state.draft.trim() || !repo.files.some(file => file.index !== '.' && !file.untracked)} onClick={() => void git.execute('commit', { message: state.draft })}>{t('git.commit')}</Button></div>
      </div> : null}
      </div>}
    </>}
    {dialog ? <GitDialog dialog={dialog} state={state} store={git} onClose={closeActiveDialog} /> : null}
  </div>
}
