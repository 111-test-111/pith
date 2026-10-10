import { useEffect, useMemo, useState } from 'react'
import { FileText, FolderOpen, RefreshCw } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Input } from '@/components/motion/input'
import { Checkbox } from '@/components/motion/checkbox'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { Tooltip } from '@/components/motion/tooltip'
import { useI18n } from '@/i18n'
import {
  refreshCatalog,
  setSkillModelInvocation,
  useToolCatalog
} from '@/lib/extensions-catalog'
import { Markdown } from '@/lib/markdown'
import { cn } from '@/lib/utils'
import type { SkillContentDTO, SkillInfoDTO } from '../../../../../shared/types'

/**
 * Settings → Skills: every skill the loader discovered — from installed
 * packages and the global/project skills directories. Each skill's detail shows
 * its description and origin, toggles `disable-model-invocation` (whether the
 * skill is formatted into the system prompt), and previews the SKILL.md itself.
 *
 * beUI-native: `Tabs` for the list/detail split, `Input` for search,
 * `Checkbox`, `Button`, `Tooltip`, and the app's `Markdown` renderer (the one
 * allowed non-beUI renderer) for the preview.
 */
export function SkillsSection() {
  const { t } = useI18n()
  const { status, data, error, busy } = useToolCatalog()
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    void refreshCatalog()
  }, [])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return data.skills
    return data.skills.filter((skill) =>
      `${skill.name} ${skill.description} ${skill.packageName ?? ''} ${skill.source}`
        .toLowerCase()
        .includes(needle)
    )
  }, [data.skills, query])

  if (status === 'loading' && data.skills.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('settings.skillsLoading')}</p>
  }
  if (status === 'error') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">{t('settings.skillsLoadFailed')}</p>
        {error ? <p className="text-xs text-muted-foreground/70">{error}</p> : null}
        <Button variant="outline" size="sm" onClick={() => void refreshCatalog()}>
          <RefreshCw className="size-3.5" />
          {t('settings.toolsRetry')}
        </Button>
      </div>
    )
  }
  if (data.skills.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('settings.skillsEmpty')}</p>
  }

  const current = filtered.find((skill) => skill.filePath === selected) ?? filtered[0]

  return (
    <div className="space-y-4">
      {data.skillDiagnostics.length > 0 ? (
        <div className="space-y-1.5 rounded-xl border border-border/70 bg-card px-3 py-2">
          {data.skillDiagnostics.map((diagnostic, index) => (
            <p key={index} className="break-words text-xs text-muted-foreground">
              <span className="font-medium text-destructive">{diagnostic.type}</span>{' '}
              {diagnostic.message}
            </p>
          ))}
        </div>
      ) : null}

      <Input
        value={query}
        onChange={setQuery}
        placeholder={t('settings.skillSearchPlaceholder')}
        aria-label={t('settings.skillSearchPlaceholder')}

      />

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('settings.skillSearchEmpty', { query: query.trim() })}
        </p>
      ) : (
        <Tabs
          value={current.filePath}
          onValueChange={setSelected}
          variant="pill"
          // Stretch (the default), NOT `items-start`: with start alignment the
          // detail column ended wherever its own content ended, so the preview
          // stopped short and left the two columns visibly uneven. Stretched,
          // the detail owns the row's height and its preview can run down to
          // the skills list's own last row.
          className="grid gap-4 sm:grid-cols-[12rem_minmax(0,1fr)]"
        >
          <TabsList className="flex h-max flex-col items-stretch gap-1 rounded-2xl p-1.5 sm:sticky sm:top-0">
            {filtered.map((skill) => (
              <TabsTrigger
                key={skill.filePath}
                value={skill.filePath}
                className="w-full justify-between gap-2 rounded-control px-3 py-2"
              >
                <span className="truncate text-xs">{skill.name}</span>
                <span
                  aria-hidden
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    skill.disableModelInvocation ? 'bg-muted-foreground/40' : 'bg-primary'
                  )}
                />
              </TabsTrigger>
            ))}
          </TabsList>

          {filtered.map((skill) =>
            skill.filePath === current.filePath ? (
              <TabsContent key={skill.filePath} value={skill.filePath} className="mt-0 flex min-w-0 flex-col">
                <SkillDetail
                  skill={skill}
                  busy={busy === `skill:${skill.filePath}`}
                  onToggle={(disable) => void setSkillModelInvocation(skill.filePath, disable)}
                />
              </TabsContent>
            ) : null
          )}
        </Tabs>
      )}
    </div>
  )
}

function SkillDetail({
  skill,
  busy,
  onToggle
}: {
  skill: SkillInfoDTO
  busy: boolean
  onToggle: (disableModelInvocation: boolean) => void
}) {
  const { t } = useI18n()
  const [content, setContent] = useState<SkillContentDTO | null>(null)
  const [readError, setReadError] = useState<string | null>(null)

  // Refetch when the skill changes or its frontmatter was rewritten by a toggle.
  useEffect(() => {
    let alive = true
    setContent(null)
    setReadError(null)
    void window.pi
      .readSkill(skill.filePath)
      .then((next) => {
        if (alive) setContent(next)
      })
      .catch((readFailure) => {
        if (alive) setReadError(readFailure instanceof Error ? readFailure.message : String(readFailure))
      })
    return () => {
      alive = false
    }
  }, [skill.filePath, skill.disableModelInvocation])

  const body = content ? stripFrontmatter(content.text) : ''

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5">
      <div className="min-w-0 space-y-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-semibold text-foreground">
            {skill.name}
          </span>
          {skill.packageName ? (
            <span className="shrink-0 rounded-control bg-muted px-2 py-0.5 text-caption font-medium text-muted-foreground">
              {skill.packageName}
            </span>
          ) : null}
          <Checkbox
            mark="square"
            className="ml-auto"
            checked={!skill.disableModelInvocation}
            onCheckedChange={(enabled) => onToggle(!enabled)}
            disabled={busy}
            aria-label={t('settings.skillModelInvocation')}
          />
        </div>
        <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span>{t('settings.skillModelInvocation')}</span>
          <span aria-hidden>·</span>
          <span>
            {skill.disableModelInvocation
              ? t('settings.skillExplicitOnly')
              : t('settings.skillInPrompt')}
          </span>
        </p>
        {skill.description ? (
          <p className="text-sm leading-ui text-muted-foreground">{skill.description}</p>
        ) : null}
      </div>

      <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[minmax(0,7rem)_minmax(0,1fr)]">
        <dt className="text-muted-foreground/70">{t('settings.extensionScope')}</dt>
        <dd className="min-w-0 text-foreground/90">
          <Tooltip content={scopeHint(skill, t)}>
            <span className="cursor-help underline decoration-dotted underline-offset-2">
              {scopeLabel(skill, t)}
            </span>
          </Tooltip>
        </dd>
        <dt className="text-muted-foreground/70">{t('settings.skillSource')}</dt>
        <dd className="min-w-0">
          <code className="break-all font-mono text-caption text-muted-foreground">
            {skill.source}
          </code>
        </dd>
        <dt className="text-muted-foreground/70">{t('settings.skillBaseDir')}</dt>
        <dd className="min-w-0">
          <span className="break-all font-mono text-caption text-muted-foreground">
            {skill.baseDir}
          </span>
        </dd>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => void window.pi.openPath(skill.filePath)}>
          <FileText className="size-3.5" />
          {t('settings.skillOpenFile')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void window.pi.showInFolder(skill.filePath)}>
          <FolderOpen className="size-3.5" />
          {t('settings.skillReveal')}
        </Button>
      </div>

      {/* The preview takes the detail column's leftover height, so its own
          bottom edge lands on the skills list's. `basis-96` is the 384px cap
          it keeps when the list is the shorter column (a long SKILL.md must
          not stretch the page); `grow` spends the spare height when the list
          is taller, and `overflow-y-auto` still scrolls the document inside. */}
      <section className="flex grow flex-col">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('settings.skillPreview')}
        </p>
        {readError ? (
          <p className="text-xs text-destructive">{t('settings.skillReadFailed')}</p>
        ) : content ? (
          <div className="grow basis-96 overflow-y-auto rounded-xl border border-border/70 bg-card px-4 py-3">
            <Markdown>{body}</Markdown>
            {content.truncated ? (
              <p className="mt-2 text-xs text-muted-foreground/70">
                {t('settings.skillPreviewTruncated')}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground/70">{t('settings.skillsLoading')}</p>
        )}
      </section>
    </div>
  )
}

/** Drop the YAML frontmatter so the preview starts at the skill's body. */
function stripFrontmatter(text: string): string {
  const match = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(text)
  return match ? text.slice(match[0].length) : text
}

function scopeLabel(skill: SkillInfoDTO, t: ReturnType<typeof useI18n>['t']): string {
  if (skill.scope === 'project') return t('settings.extensionScopeProject')
  if (skill.scope === 'temporary') return t('settings.extensionScopeTemporary')
  return t('settings.extensionScopeUser')
}

function scopeHint(skill: SkillInfoDTO, t: ReturnType<typeof useI18n>['t']): string {
  if (skill.scope === 'project') return t('settings.extensionScopeProjectHint')
  if (skill.scope === 'temporary') return t('settings.extensionScopeTemporaryHint')
  return t('settings.extensionScopeUserHint')
}
