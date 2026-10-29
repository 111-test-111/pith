import { useCallback, useEffect, useRef, useState } from 'react'
import { CenterMorphModal, CenterMorphModalContent } from '@/components/motion/center-morph-modal'
import { Button } from '@/components/motion/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select'
import { FORM_FIELD_HEADING, FORM_PANEL_TITLE } from '@/lib/form-standard'
import { useI18n } from '@/i18n'
import { FadeScroll } from '../FadeScroll'
import type { GitDiscardPreview } from '../../../../../shared/git'
import type { GitState, GitStore } from '@/state/git-store'

export type GitDialogKind = { kind: 'push' | 'init' } | { kind: 'discard'; preview: GitDiscardPreview; cwd: string; revision: string }
export function GitDialog({ dialog, state, store, onClose }: { dialog: GitDialogKind; state: GitState; store: GitStore; onClose: () => void }) {
  const { t } = useI18n(), cancel = useRef<HTMLButtonElement>(null)
  // The modal creates its portal after mounting; focus when the control exists.
  const focusCancelOnMount = useCallback((button: HTMLButtonElement | null) => { cancel.current = button; button?.focus({ preventScroll: true }) }, [])
  const [remote, setRemote] = useState(state.repository?.remotes[0] ?? '')
  const [pending, setPending] = useState(false)
  const title = t(`git.dialog.${dialog.kind}`)
  const openChange = useCallback((open: boolean) => { if (!open && !pending) onClose() }, [onClose, pending])
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; return () => previous?.focus({ preventScroll: true }) }, [])
  const submit = async () => {
    if (pending) return
    if (dialog.kind === 'discard' && (dialog.cwd !== state.cwd || dialog.revision !== state.repository?.revision)) { store.stalePreview(); onClose(); return }
    setPending(true)
    const ok = await store.execute(dialog.kind === 'discard' ? 'discard' : dialog.kind, dialog.kind === 'discard' ? { token: dialog.preview.token } : dialog.kind === 'push' ? { remote } : {})
    setPending(false)
    if (ok || dialog.kind === 'discard') onClose()
  }
  return <CenterMorphModal open onOpenChange={openChange}>
    <CenterMorphModalContent ariaLabel={title} closeButtonLabel={t('common.cancel')} showCloseButton={false} initialFocusRef={cancel} dismissible={!pending} className="max-w-md p-5">
      <h2 className={FORM_PANEL_TITLE}>{title}</h2>
      {dialog.kind === 'discard' ? <>
        <p className="mt-2 text-sm leading-ui text-muted-foreground">{t('git.discardHint')}</p>
        <FadeScroll className="mt-3 max-h-60 border border-border rounded-card p-2"><ul className="space-y-1">{dialog.preview.paths.map(path => <li key={path} className="break-all text-xs">{path}{dialog.preview.untracked.includes(path) ? <span className="ml-2 text-muted-foreground">{t('git.trash')}</span> : null}</li>)}</ul></FadeScroll>
      </> : dialog.kind === 'init' ? <p className="mt-2 break-words text-sm text-muted-foreground">{t('git.initHint', { path: state.cwd ?? '' })}</p> : dialog.kind === 'push' ? <div data-form-items className="mt-4 grid grid-cols-2 gap-5"><div className="col-span-2"><p className={FORM_FIELD_HEADING}>{t('git.remote')}</p><Select value={remote} onValueChange={setRemote} disabled={pending}><SelectTrigger aria-label={t('git.remote')}><SelectValue className="text-sm" placeholder={t('git.remote')} /></SelectTrigger><SelectContent portal>{state.repository?.remotes.map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}</SelectContent></Select><p className="mt-1.5 text-xs text-muted-foreground">{t('git.firstPushHint', { branch: state.repository?.branch ?? '' })}</p></div></div> : null}
      {state.actionError ? <p role="alert" className="mt-3 text-xs text-destructive">{t(`git.error.${state.actionError.code}`)}</p> : null}
      <div className="mt-5 flex justify-end gap-2"><Button ref={focusCancelOnMount} variant="outline" size="sm" onClick={() => { if (pending) void store.cancel(); else onClose() }}>{t('common.cancel')}</Button><Button data-git-confirm variant={dialog.kind === 'discard' ? 'destructive' : 'primary'} size="sm" disabled={pending || (dialog.kind === 'push' && !remote) || !!state.repository?.blocked} onClick={() => void submit()}>{t(pending ? 'git.working' : dialog.kind === 'discard' ? 'git.discard' : dialog.kind === 'init' ? 'git.init' : dialog.kind === 'push' ? 'git.push' : 'git.createBranch')}</Button></div>
    </CenterMorphModalContent>
  </CenterMorphModal>
}
