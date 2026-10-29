import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowLeft, Bell, BookOpen, Chart, Gavel, Globe, Keyboard, KeyRound, Monitor, Palette, PictureInPicture2, Plug, Puzzle, Settings2, Skills, Subagent, TextAlignCenter, Wrench } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { EASE_OUT } from '@/lib/ease'
import type { MessageKey } from '@/i18n/locales/en'
import type { UiStyle } from '@/lib/ui-style'
import { useI18n } from '@/i18n'
import { GeneralSection } from './GeneralSection'
import { NotificationsSection } from './NotificationsSection'
import { PromptSection } from './PromptSection'
import { AppearanceSection } from './AppearanceSection'
import { PictureInPictureSection } from './PictureInPictureSection'
import { ShortcutsSection } from './ShortcutsSection'
import { ProvidersSection } from './ProvidersSection'
import { ToolsSection } from './ToolsSection'
import { SubagentsSection } from './SubagentsSection'
import { ExtensionsSection } from './ExtensionsSection'
import { McpSection } from './McpSection'
import { SkillsSection } from './SkillsSection'
import { BrowserSection } from './BrowserSection'
import { UsageSection } from './UsageSection'
import { JevSection } from './JevSection'
import { WindowTitlebar } from '../WindowTitlebar'
import { LibrarySection } from './LibrarySection'
import { ResourcesSection } from './ResourcesSection'

interface SectionProps {
  active: boolean
  accent: string
  onAccentChange: (accent: string) => void
  uiStyle: UiStyle
  onUiStyleChange: (style: UiStyle) => void
}

/**
 * Settings registry — adding a section is one entry here plus a section
 * component file; the page shell (header, vertical tabs, transition) never
 * changes. Labels resolve through i18n so the registry stores keys, not
 * strings.
 */
const SECTIONS: {
  id: string
  labelKey: MessageKey
  descriptionKey: MessageKey
  /** Optional rail tag (e.g. Beta) shown at the end of the tab row. */
  badgeKey?: MessageKey
  /** A section with sub-pages supplies its own current heading. */
  ownsHeading?: boolean
  icon: ReactNode
  render: (props: SectionProps) => ReactNode
}[] = [
  // App basics first, then app features, then the agent stack, with reports
  // and the beta surface at the end.
  {
    id: 'general',
    labelKey: 'settings.general',
    descriptionKey: 'settings.generalDesc',
    icon: <Settings2 className="size-[18px]" />,
    render: () => <GeneralSection />
  },
  {
    id: 'appearance',
    labelKey: 'settings.appearance',
    descriptionKey: 'settings.appearanceDesc',
    icon: <Palette className="size-[18px]" />,
    render: (props) => (
      <AppearanceSection
        accent={props.accent}
        onAccentChange={props.onAccentChange}
        uiStyle={props.uiStyle}
        onUiStyleChange={props.onUiStyleChange}
      />
    )
  },
  {
    id: 'notifications',
    labelKey: 'settings.notifications',
    descriptionKey: 'settings.notificationsDesc',
    icon: <Bell className="size-[18px]" />,
    render: () => <NotificationsSection />
  },
  {
    id: 'prompt',
    labelKey: 'settings.prompt',
    descriptionKey: 'settings.promptDesc',
    icon: <TextAlignCenter className="size-[18px]" />,
    render: () => <PromptSection />
  },
  {
    id: 'shortcuts',
    labelKey: 'shortcuts.title',
    descriptionKey: 'shortcuts.description',
    icon: <Keyboard className="size-[18px]" />,
    render: () => <ShortcutsSection />
  },
  {
    id: 'library',
    labelKey: 'library.title',
    descriptionKey: 'library.settingsDesc',
    icon: <BookOpen className="size-[18px]" />,
    render: () => <LibrarySection />
  },
  {
    id: 'browser',
    labelKey: 'settings.browserTitle',
    descriptionKey: 'settings.browserDesc',
    icon: <Globe className="size-[18px]" />,
    render: () => <BrowserSection />
  },
  {
    id: 'picture-in-picture',
    labelKey: 'settings.pictureInPicture',
    descriptionKey: 'settings.pictureInPictureDesc',
    icon: <PictureInPicture2 className="size-[18px]" />,
    render: () => <PictureInPictureSection />
  },
  {
    id: 'providers',
    ownsHeading: true,
    labelKey: 'settings.providers',
    descriptionKey: 'settings.providersDesc',
    icon: <KeyRound className="size-[18px]" />,
    render: () => <ProvidersSection />
  },
  {
    id: 'tools',
    labelKey: 'settings.tools',
    descriptionKey: 'settings.toolsDesc',
    icon: <Wrench className="size-[18px]" />,
    render: () => <ToolsSection />
  },
  {
    id: 'subagents',
    labelKey: 'subagent.settingsTitle',
    descriptionKey: 'subagent.settingsDesc',
    icon: <Subagent className="size-[18px]" />,
    render: () => <SubagentsSection />
  },
  {
    id: 'extensions',
    labelKey: 'settings.extensions',
    descriptionKey: 'settings.extensionsDesc',
    icon: <Puzzle className="size-[18px]" />,
    render: () => <ExtensionsSection />
  },
  {
    id: 'mcp',
    labelKey: 'settings.mcp',
    descriptionKey: 'settings.mcpDesc',
    icon: <Plug className="size-[18px]" />,
    render: () => <McpSection />
  },
  {
    id: 'skills',
    labelKey: 'settings.skills',
    descriptionKey: 'settings.skillsDesc',
    icon: <Skills className="size-[18px]" />,
    render: () => <SkillsSection />
  },
  {
    id: 'usage',
    labelKey: 'settings.usage',
    descriptionKey: 'settings.usageDesc',
    icon: <Chart className="size-[18px]" />,
    render: () => <UsageSection />
  },
  {
    id: 'resources',
    labelKey: 'resources.title',
    descriptionKey: 'resources.description',
    icon: <Monitor className="size-[18px]" />,
    render: (props) => <ResourcesSection active={props.active} />
  },
  {
    id: 'jev',
    labelKey: 'jev.title',
    descriptionKey: 'jev.description',
    badgeKey: 'settings.beta',
    icon: <Gavel className="size-[18px]" />,
    render: () => <JevSection />
  }
]

interface SettingsPageProps extends Omit<SectionProps, 'active'> {
  open: boolean
  onBack: () => void
  requestedSection?: string | null
}

/**
 * Full-page Settings — back button top-left, beUI Tabs turned into a vertical
 * rail (the pill indicator glides between sections). Rendered above the
 * workspace instead of unmounting it, so composer drafts and scroll positions
 * survive the round-trip; content stays opaque below the shared glass title row.
 */
export function SettingsPage({ open, onBack, requestedSection, ...sectionProps }: SettingsPageProps) {
  const { t } = useI18n()
  const [section, setSection] = useState(SECTIONS[0].id)
  // Sections mount lazily: a panel's content renders on first activation and
  // stays mounted afterwards (its scroll position survives switching). The
  // vendored TabsContent keeps inactive panels in the DOM but `hidden` —
  // rendering all eight sections the moment Settings opens mounts ~2.4k nodes
  // and fires every section's IPC reads (usage aggregation, catalog,
  // providers…) in the same frame the entry animation starts, which lands the
  // responses mid-animation as a second stutter. Opening Settings now mounts
  // only the first section; each other section loads when the user first
  // visits it.
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set([SECTIONS[0].id]))
  const reduce = useReducedMotion()

  const selectSection = (id: string) => {
    setSection(id)
    setMounted((previous) => (previous.has(id) ? previous : new Set(previous).add(id)))
  }
  useEffect(() => {
    if (open && requestedSection && SECTIONS.some(entry => entry.id === requestedSection)) selectSection(requestedSection)
  }, [open, requestedSection])

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          initial={{ opacity: 0, x: reduce ? 0 : 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: reduce ? 0 : 24 }}
          transition={reduce ? { duration: 0 } : { duration: 0.22, ease: EASE_OUT }}
          className="window-page absolute inset-0 z-40 flex flex-col"
          // A full-page surface: the shortcut dispatcher's layer. Only its
          // own ⌘, toggle passes through to close it.
          data-shortcut-layer
          data-shortcut-passthrough="openSettings"
        >
          <WindowTitlebar className="gap-1.5 border-b border-border/50">
            <Button variant="ghost" size="icon" aria-label={t('settings.back')} onClick={onBack}>
              <ArrowLeft className="size-4" />
            </Button>
            <h1 className="px-1 text-sm font-semibold text-foreground">{t('settings.title')}</h1>
          </WindowTitlebar>

          <Tabs
            value={section}
            onValueChange={selectSection}
            variant="pill"
            className="flex min-h-0 flex-1"
          >
            <TabsList className="my-4 ml-4 mr-2 flex w-60 shrink-0 flex-col items-stretch gap-1 self-stretch rounded-2xl p-1.5">
              {SECTIONS.map((entry) => (
                <TabsTrigger
                  key={entry.id}
                  value={entry.id}
                  className="group w-full justify-start gap-2.5 rounded-control px-3.5 py-2.5"
                >
                  {entry.icon}
                  {t(entry.labelKey)}
                  {entry.badgeKey ? (
                    // Keep the tag readable on the selected tab's theme tint.
                    <span
                      data-tab-badge
                      className="ml-auto shrink-0 rounded-control bg-muted px-1.5 py-px text-micro font-medium leading-3.5 text-muted-foreground group-aria-selected:bg-muted-foreground/10 group-aria-selected:text-foreground"
                    >
                      {t(entry.badgeKey)}
                    </span>
                  ) : null}
                </TabsTrigger>
              ))}
            </TabsList>
            {SECTIONS.map((entry) => (
              <TabsContent key={entry.id} value={entry.id} className="mt-0 min-h-0 flex-1">
                <div data-settings-scrollport className="h-full overflow-y-auto overscroll-contain px-6 py-7 md:px-10">
                  <div className="mx-auto w-full max-w-5xl">
                    {!entry.ownsHeading ? <><h2 className="text-base font-semibold tracking-tight text-foreground">
                      {t(entry.labelKey)}
                    </h2>
                    <p className="mt-1.5 text-sm leading-ui text-muted-foreground">
                      {t(entry.descriptionKey)}
                    </p></> : null}
                    <div className={entry.ownsHeading ? undefined : 'mt-7'}>
                      {mounted.has(entry.id) ? entry.render({ ...sectionProps, active: open && section === entry.id }) : null}
                    </div>
                  </div>
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
