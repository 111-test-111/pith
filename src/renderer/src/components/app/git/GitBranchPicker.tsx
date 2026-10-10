import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Combobox, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from '@/components/motion/combobox'
import { MorphPopover, MorphPopoverContent, MorphPopoverTrigger } from '@/components/motion/popover-morph'
import { GitFork, ChevronDown, Plus } from '@/lib/icons'
import { FORM_INPUT_LABEL } from '@/lib/form-standard'
import { SINGLE_LINE_INPUT_PADDING_X, SINGLE_LINE_INPUT_PADDING_Y } from '@/lib/input-style'
import { useI18n } from '@/i18n'
import type { GitState, GitStore } from '@/state/git-store'

/** Search and select in one anchored surface; writes retain main's admission checks. */
export function GitBranchPicker({ state, store, disabled }: { state: GitState; store: GitStore; disabled: boolean }) {
  const { t } = useI18n(), [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false), [name, setName] = useState(''), [pending, setPending] = useState(false)
  const search = useRef<HTMLInputElement>(null), branchInput = useRef<HTMLInputElement>(null)
  const createVersion = useRef(0)
  const repo = state.repository!
  const openChange = useCallback((next: boolean) => { setOpen(next); if (next) void store.loadBranches() }, [store])
  useEffect(() => { ++createVersion.current; setOpen(false); setCreating(false); setName(''); setPending(false) }, [state.cwd])
  useEffect(() => { if (disabled && !pending) setOpen(false) }, [disabled, pending])
  useEffect(() => { if (creating) branchInput.current?.focus({ preventScroll: true }) }, [creating])
  const cancelCreate = () => { if (pending) return; setCreating(false); setName(''); store.dismissError(); search.current?.focus({ preventScroll: true }) }
  const create = async () => {
    if (disabled || pending || !name.trim()) return
    const version = ++createVersion.current
    setPending(true)
    const created = await store.execute('branch', { branch: name.trim() })
    if (version !== createVersion.current) return
    setPending(false)
    if (created) { setOpen(false); setCreating(false); setName('') }
    else branchInput.current?.focus({ preventScroll: true })
  }
  const select = (branch: string) => {
    if (disabled || !state.branches.some(item => item.name === branch && !item.current && !item.worktree && item.name !== repo.branch)) return
    setOpen(false); void store.execute('switch', { branch })
  }
  return <MorphPopover open={open} onOpenChange={openChange}>
    <MorphPopoverTrigger>
      <Button variant="ghost" size="sm" className="h-8 min-w-0 max-w-40 justify-start gap-1 px-1 text-xs font-medium" aria-label={t('git.switchBranch')} title={repo.branch ?? t('git.detached')} disabled={disabled || !repo.head}><GitFork aria-hidden className="size-3.5 shrink-0" /><span className="truncate">{repo.branch ?? t('git.detached')}</span><ChevronDown aria-hidden className="size-3 shrink-0 text-muted-foreground" /></Button>
    </MorphPopoverTrigger>
    <MorphPopoverContent side="bottom" align="start" className="w-72 max-w-[calc(100vw-2rem)] overflow-hidden">
      <div data-git-branches>
        <Combobox open value={repo.branch ?? ''} onValueChange={select}>
          <div className={`flex items-center border-b border-border/60 ${SINGLE_LINE_INPUT_PADDING_X} ${SINGLE_LINE_INPUT_PADDING_Y}`}><ComboboxInput ref={search} aria-label={t('git.searchBranches')} placeholder={t('git.searchBranches')} /></div>
          <ComboboxList ariaLabel={t('git.branchName')} className="max-h-[min(16rem,50vh)]">
            {state.branches.map(item => <ComboboxItem key={item.name} value={item.name} textValue={item.name} className="text-xs" disabled={disabled || item.current || item.name === repo.branch || !!item.worktree}>
              <span className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate" title={item.name}>{item.name}</span>{item.current || item.name === repo.branch ? <span className="shrink-0 text-xs text-muted-foreground">{t('git.currentBranch')}</span> : item.worktree ? <span className="shrink-0 text-xs text-muted-foreground">{t('git.otherWorktree')}</span> : null}</span>
            </ComboboxItem>)}
            {state.branches.length || !state.branchesLoading ? <ComboboxEmpty className="py-4">{t('git.noMatchingBranches')}</ComboboxEmpty> : null}
          </ComboboxList>
          <div role="group" aria-label={t('git.createBranch')} className="border-t border-border/60 p-2">
            {creating ? <form data-git-create-branch className="space-y-2 p-1" onSubmit={event => { event.preventDefault(); void create() }}>
              <Input ref={branchInput} label={t('git.branchName')} aria-label={t('git.branchName')} classNames={{ ...FORM_INPUT_LABEL, label: `${FORM_INPUT_LABEL.label} text-xs` }} value={name} onChange={value => { setName(value); if (state.actionError) store.dismissError() }} disabled={pending} spellCheck={false} autoComplete="off" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelCreate() } }} />
              <p className="text-xs text-muted-foreground">{t('git.createBranchHint')}</p>
              {state.actionError ? <p role="alert" className="text-xs text-destructive">{t(`git.error.${state.actionError.code}`)}</p> : null}
              <div className="flex justify-end gap-2"><Button type="button" variant="ghost" size="sm" className="h-7 text-xs" disabled={pending} onClick={cancelCreate}>{t('common.cancel')}</Button><Button type="submit" data-git-create-confirm size="sm" className="h-7 text-xs" disabled={disabled || pending || !name.trim()}>{t(pending ? 'git.working' : 'git.createBranch')}</Button></div>
            </form> : <Button variant="ghost" size="sm" className="h-8 w-full justify-start gap-2 text-xs" disabled={disabled || !repo.head} onClick={() => { store.dismissError(); setCreating(true) }}><Plus aria-hidden className="size-4" />{t('git.createBranch')}</Button>}
          </div>
        </Combobox>
      </div>
    </MorphPopoverContent>
  </MorphPopover>
}
