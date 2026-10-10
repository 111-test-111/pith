import { useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { Plus, Minus, RotateCcw } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { useScrollFade } from '@/lib/hooks/use-scroll-fade'
import { FileTypeIcon } from '../FileTypeIcon'
import { LabelTooltip } from '../LabelTooltip'
import { GitLineCounts } from './GitLineCounts'
import { GitStatus } from './GitStatus'
import { cn } from '@/lib/utils'
import type { GitChange } from '../../../../../shared/git'
import type { GitSelection } from '@/state/git-store'

type Group = 'staged' | 'unstaged' | 'untracked' | 'conflicts'
type Item = { kind: 'heading'; group: Group; files: GitChange[] } | { kind: 'file'; group: Group; file: GitChange }
export function GitFileList({ files, selection, disabled, onSelect, onStage, onUnstage, onDiscard }: {
  files: GitChange[]; selection: GitSelection | null; disabled: boolean
  onSelect: (selection: GitSelection) => void; onStage: (paths: string[]) => void; onUnstage: (paths: string[]) => void; onDiscard: (paths: string[]) => void
}) {
  const { t } = useI18n(), scroll = useRef<HTMLDivElement>(null)
  const items = useMemo<Item[]>(() => {
    const groups: [Group, GitChange[]][] = [
      ['conflicts', files.filter(file => file.conflict)],
      ['staged', files.filter(file => !file.conflict && !file.untracked && file.index !== '.')],
      ['unstaged', files.filter(file => !file.conflict && !file.untracked && file.worktree !== '.')],
      ['untracked', files.filter(file => file.untracked)]
    ]
    return groups.flatMap(([group, list]) => list.length ? [{ kind: 'heading' as const, group, files: list }, ...list.map(file => ({ kind: 'file' as const, group, file }))] : [])
  }, [files])
  const virtual = useVirtualizer({ count: items.length, getScrollElement: () => scroll.current, estimateSize: () => 36, overscan: 8, getItemKey: index => { const item = items[index]; return item.kind === 'heading' ? item.group : `${item.group}:${item.file.path}` } })
  const { maskImage } = useScrollFade(scroll, { dependsOn: items.length })
  const action = (label: string, Icon: typeof Plus, onClick: () => void) => <Tooltip content={label}><Button size="icon" variant="ghost" className="size-6 shrink-0" aria-label={label} disabled={disabled} onClick={onClick}><Icon aria-hidden className="size-3.5" /></Button></Tooltip>
  const layerStats = (file: GitChange, group: Group) => group === 'staged' ? file.stagedStats : file.worktreeStats
  const totals = useMemo(() => files.flatMap(file => file.conflict || file.untracked ? [file.worktreeStats] : [...(file.index !== '.' ? [file.stagedStats] : []), ...(file.worktree !== '.' ? [file.worktreeStats] : [])]), [files])
  return <div className="flex min-h-0 flex-1 flex-col">
    <div data-git-summary className="flex h-8 shrink-0 items-center gap-2 border-b border-border/40 px-3"><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{t('git.changedFiles', { count: new Set(files.map(file => file.path)).size })}</span><GitLineCounts stats={totals} summary /></div>
    <div ref={scroll} data-git-files className="min-h-0 flex-1 overflow-y-auto px-1 py-1" style={{ maskImage, WebkitMaskImage: maskImage }}>
    {!items.length ? <p className="p-3 text-sm text-muted-foreground">{t('git.clean')}</p> : <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
      {virtual.getVirtualItems().map(row => {
        const item = items[row.index]
        return <div key={row.key} className="absolute left-0 top-0 flex h-9 w-full items-center gap-0.5 px-1" style={{ transform: `translateY(${row.start}px)` }}>
          {item.kind === 'heading' ? <>
            <span className="min-w-0 flex-1 text-xs font-medium text-foreground">{t(`git.${item.group}`)} <span className="ml-1 text-muted-foreground tabular-nums">{item.files.length}</span></span>
            <GitLineCounts stats={item.files.map(file => layerStats(file, item.group))} summary />
            {item.group === 'staged' ? action(t('git.unstageAll'), Minus, () => onUnstage(item.files.map(file => file.path))) : item.group !== 'conflicts' ? action(t('git.stageAll'), Plus, () => onStage(item.files.map(file => file.path))) : null}
          </> : <>
            <Button variant="ghost" size="sm" className={cn('h-8 min-w-0 flex-1 justify-start gap-2 px-1.5 font-normal', selection?.path === item.file.path && selection.area === (item.group === 'staged' ? 'staged' : 'unstaged') && 'bg-primary/10')} aria-pressed={selection?.path === item.file.path && selection.area === (item.group === 'staged' ? 'staged' : 'unstaged')} data-git-path={item.file.path} data-git-area={item.group} onClick={() => onSelect({ path: item.file.path, area: item.group === 'staged' ? 'staged' : 'unstaged' })}>
              <FileTypeIcon path={item.file.path} variant="tree" className="size-4 shrink-0" />
              <LabelTooltip content={item.file.oldPath ? `${item.file.oldPath} → ${item.file.path}` : item.file.path} wrapperClassName="min-w-0 flex-1"><span className="block truncate text-left text-xs">{item.file.path}</span></LabelTooltip>
              <GitLineCounts stats={[layerStats(item.file, item.group)]} />
              <GitStatus status={item.file.untracked ? '?' : item.group === 'staged' ? item.file.index : item.file.worktree} conflict={item.file.conflict} />
            </Button>
            {item.group === 'staged' ? action(t('git.unstageFile', { path: item.file.path }), Minus, () => onUnstage([item.file.path])) : action(t(item.file.conflict ? 'git.resolveFile' : 'git.stageFile', { path: item.file.path }), Plus, () => onStage([item.file.path]))}
            {!item.file.conflict && !item.file.submodule && item.group !== 'staged' && !item.file.path.endsWith('/') ? action(t('git.discardFile', { path: item.file.path }), RotateCcw, () => onDiscard([item.file.path])) : null}
          </>}
        </div>
      })}
    </div>}
    </div>
  </div>
}
