import { useMemo, useRef, useState } from 'react'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { WrapText, X } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { useScrollFade } from '@/lib/hooks/use-scroll-fade'
import { cn } from '@/lib/utils'
import type { DiffLayout } from '@/lib/diff-layout'
import { ReviewDiffBody } from '../ReviewDiff'
import { DiffLayoutButton } from '../DiffControls'
import { LabelTooltip } from '../LabelTooltip'
import type { GitState, GitStore } from '@/state/git-store'

export function GitDiffPreview({ state, store }: { state: GitState; store: GitStore }) {
  const { t } = useI18n()
  const scroll = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [layout, setLayout] = useState<DiffLayout>('stacked')
  const { maskImage } = useScrollFade(scroll, { contentRef: content, dependsOn: state.diff })
  // Renames use two exact literal paths. Keep Git file headers out of hunk rows.
  const parts = useMemo(() => state.diff?.patch.split(/(?=^diff --git )/m).filter(Boolean) ?? [], [state.diff])
  const { selection, wrapLines } = state
  if (!selection) return null
  const wrapLabel = t('files.wrap')
  const patchTextClass = cn('overflow-x-auto p-2 font-mono text-xs', wrapLines ? 'whitespace-break-spaces [overflow-wrap:anywhere]' : 'whitespace-pre')
  return <section data-git-diff className="git-detail flex min-h-0 min-w-0 flex-col border-t border-border/60">
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-2">
      <LabelTooltip content={selection.path} wrapperClassName="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{selection.path}</span></LabelTooltip>
      <span className="shrink-0 text-xs text-muted-foreground">{t(`git.${selection.area}`)}</span>
      {parts.some(patch => /^@@ -\d/m.test(patch)) ? <DiffLayoutButton layout={layout} onChange={setLayout} className="size-6" /> : null}
      <Tooltip content={wrapLabel} wrapperClassName="shrink-0">
        <Button variant="ghost" size="icon" className={cn('size-6', wrapLines && 'bg-muted text-primary')}
          aria-label={wrapLabel} aria-pressed={wrapLines} onClick={() => store.setWrapLines(!wrapLines)}>
          <WrapText aria-hidden className="size-3.5" />
        </Button>
      </Tooltip>
      <Button variant="ghost" size="icon" className="size-6" aria-label={t('git.closeDiff')} onClick={() => store.clearSelection()}><X aria-hidden className="size-3.5" /></Button>
    </div>
    <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto px-1 pb-2" style={{ maskImage, WebkitMaskImage: maskImage }}>
      <div ref={content}>
        {state.diffLoading ? <p role="status" className="p-3 text-xs text-muted-foreground">{t('git.loading')}</p> : state.diffError ? (
          <div role="alert" className="space-y-2 p-3">
            <p className="text-xs text-destructive">{t(`git.error.${state.diffError.code}`)}</p>
            <Button variant="outline" size="sm" onClick={() => void store.select(selection)}>{t('git.retry')}</Button>
          </div>
        ) : state.diff?.binary && parts.length < 2 ? <p className="p-3 text-xs text-muted-foreground">{t('git.binary')}</p> : parts.length ? parts.map((patch, index) => (
          <div key={index}>
            {parts.length > 1 ? <pre className={cn(patchTextClass, 'border-b border-border/60 text-muted-foreground')}>{patch.split('\n')[0]}</pre> : null}
            {/^(?:Binary files |GIT binary patch)/m.test(patch) ? <p className="p-3 text-xs text-muted-foreground">{t('git.binary')}</p> : /^@@ -\d/m.test(patch) ? (
              <ReviewDiffBody patch={patch} displayPath={selection.path} scrollRootRef={scroll} scrollContentRef={content} wrap={wrapLines} layout={layout} />
            ) : <pre className={patchTextClass}>{patch}</pre>}
          </div>
        )) : <p className="p-3 text-xs text-muted-foreground">{t('git.noDiff')}</p>}
      </div>
    </div>
  </section>
}
