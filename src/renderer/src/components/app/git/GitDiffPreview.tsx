import { useMemo, useRef } from 'react'
import { Button } from '@/components/motion/button'
import { X } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { useScrollFade } from '@/lib/hooks/use-scroll-fade'
import { ReviewDiffBody } from '../ReviewDiff'
import { LabelTooltip } from '../LabelTooltip'
import type { GitState, GitStore } from '@/state/git-store'

export function GitDiffPreview({ state, store }: { state: GitState; store: GitStore }) {
  const { t } = useI18n(), scroll = useRef<HTMLDivElement>(null)
  const { maskImage } = useScrollFade(scroll, { dependsOn: state.diff })
  // Renames use two exact literal paths. Keep Git file headers out of hunk rows.
  const parts = useMemo(() => state.diff?.patch.split(/(?=^diff --git )/m).filter(Boolean) ?? [], [state.diff])
  if (!state.selection) return null
  return <section data-git-diff className="git-detail flex min-h-0 min-w-0 flex-col border-t border-border/60">
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-2">
      <LabelTooltip content={state.selection.path} wrapperClassName="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{state.selection.path}</span></LabelTooltip>
      <span className="shrink-0 text-xs text-muted-foreground">{t(`git.${state.selection.area}`)}</span>
      <Button variant="ghost" size="icon" className="size-6" aria-label={t('git.closeDiff')} onClick={() => store.clearSelection()}><X aria-hidden className="size-3.5" /></Button>
    </div>
    <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto px-1 pb-2" style={{ maskImage, WebkitMaskImage: maskImage }}>
      {state.diffLoading ? <p role="status" className="p-3 text-xs text-muted-foreground">{t('git.loading')}</p> : state.diffError ? <div role="alert" className="space-y-2 p-3"><p className="text-xs text-destructive">{t(`git.error.${state.diffError.code}`)}</p><Button variant="outline" size="sm" onClick={() => void store.select(state.selection!)}>{t('git.retry')}</Button></div> : state.diff?.binary && parts.length < 2 ? <p className="p-3 text-xs text-muted-foreground">{t('git.binary')}</p> : parts.length ? parts.map((patch, index) => <div key={index}>
        {parts.length > 1 ? <pre className="break-all whitespace-pre-wrap border-b border-border/60 p-2 font-mono text-xs text-muted-foreground">{patch.split('\n')[0]}</pre> : null}
        {/^(?:Binary files |GIT binary patch)/m.test(patch) ? <p className="p-3 text-xs text-muted-foreground">{t('git.binary')}</p> : /^@@ -\d/m.test(patch) ? <ReviewDiffBody patch={patch} displayPath={state.selection!.path} scrollRootRef={scroll} /> : <pre className="overflow-x-auto p-2 font-mono text-xs">{patch}</pre>}
      </div>) : <p className="p-3 text-xs text-muted-foreground">{t('git.noDiff')}</p>}
    </div>
  </section>
}
