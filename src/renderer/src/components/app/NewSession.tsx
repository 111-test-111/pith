import { ArrowUpRight, Compass, Folder, GitPullRequest, Lightbulb, Shapes, WandSparkles } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { useI18n } from '@/i18n'
import { PithIcon } from './PithIcon'

export interface NewSessionContext {
  /** Display name only; the internal projectless workspace must stay hidden. */
  projectName: string | null
}

export function NewSessionHeader({ projectName }: NewSessionContext) {
  const { t } = useI18n()

  return (
    <div className="mb-6 flex flex-col items-start text-left">
      <div className="mb-5 flex max-w-full items-center gap-2 text-xs text-muted-foreground">
        <PithIcon className="mr-1 size-9" />
        <span className="shrink-0">{t('newSession.label')}</span>
        {projectName ? (
          <>
            <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
            <Folder aria-hidden="true" className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{projectName}</span>
          </>
        ) : null}
      </div>
      <h1 className="text-2xl font-medium tracking-tight text-foreground @lg:text-[32px] @lg:leading-tight">
        {t('newSession.title')}
      </h1>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
        {t('newSession.description')}
      </p>
    </div>
  )
}

const PROJECT_STARTERS = [
  { key: 'explore', icon: Compass },
  { key: 'feature', icon: WandSparkles },
  { key: 'review', icon: GitPullRequest }
] as const

const GENERAL_STARTERS = [
  { key: 'plan', icon: Lightbulb },
  { key: 'create', icon: WandSparkles },
  { key: 'learn', icon: Shapes }
] as const

export function NewSessionSuggestions({ projectName, onSelect }: NewSessionContext & {
  onSelect: (prompt: string) => void
}) {
  const { t } = useI18n()
  const starters = projectName ? PROJECT_STARTERS : GENERAL_STARTERS

  return (
    <div className="mt-5">
      <p className="mb-3 px-1 text-xs text-muted-foreground">{t('newSession.suggestions')}</p>
      <div className="grid grid-cols-1 gap-2 @xl:grid-cols-3">
        {starters.map(({ key, icon: Icon }) => (
          <Button
            key={key}
            type="button"
            variant="ghost"
            pressScale={0.99}
            onClick={() => onSelect(t(`newSession.${key}.prompt`))}
            className="group h-auto min-w-0 flex-col items-start justify-start gap-1.5 rounded-control border border-border/50 bg-card/30 px-3.5 py-3 text-left hover:border-border"
          >
            <span className="flex w-full items-center gap-2.5">
              <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
              <span className="text-sm font-medium text-foreground">{t(`newSession.${key}.title`)}</span>
              <ArrowUpRight aria-hidden="true" className="ml-auto size-3.5 shrink-0 text-muted-foreground/50" />
            </span>
            <span className="text-xs font-normal leading-5 text-muted-foreground">
              {t(`newSession.${key}.description`)}
            </span>
          </Button>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-xs text-muted-foreground/80">
        <span className="inline-flex items-center gap-1.5">
          <span className="font-mono">@</span>
          {t('newSession.hintMention')}
        </span>
        <span>{t('newSession.hintDrop')}</span>
      </div>
    </div>
  )
}
