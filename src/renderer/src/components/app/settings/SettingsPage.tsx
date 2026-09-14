import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowLeft, GraduationCap, KeyRound, Palette, Puzzle, ScrollText, Settings2, Wrench } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { EASE_OUT } from '@/lib/ease'
import type { MessageKey } from '@/i18n/locales/en'
import { useI18n } from '@/i18n'
import { GeneralSection } from './GeneralSection'
import { PromptSection } from './PromptSection'
import { AppearanceSection } from './AppearanceSection'
import { ProvidersSection } from './ProvidersSection'
import { ToolsSection } from './ToolsSection'
import { ExtensionsSection } from './ExtensionsSection'
import { SkillsSection } from './SkillsSection'
import { WindowTitlebar } from '../WindowTitlebar'

interface SectionProps {
  accent: string
  onAccentChange: (accent: string) => void
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
  icon: ReactNode
  render: (props: SectionProps) => ReactNode
}[] = [
  {
    id: 'general',
    labelKey: 'settings.general',
    descriptionKey: 'settings.generalDesc',
    icon: <Settings2 className="size-4" />,
    render: () => <GeneralSection />
  },
  {
    id: 'prompt',
    labelKey: 'settings.prompt',
    descriptionKey: 'settings.promptDesc',
    icon: <ScrollText className="size-4" />,
    render: () => <PromptSection />
  },
  {
    id: 'appearance',
    labelKey: 'settings.appearance',
    descriptionKey: 'settings.appearanceDesc',
    icon: <Palette className="size-4" />,
    render: (props) => (
      <AppearanceSection accent={props.accent} onAccentChange={props.onAccentChange} />
    )
  },
  {
    id: 'providers',
    labelKey: 'settings.providers',
    descriptionKey: 'settings.providersDesc',
    icon: <KeyRound className="size-4" />,
    render: () => <ProvidersSection />
  },
  {
    id: 'tools',
    labelKey: 'settings.tools',
    descriptionKey: 'settings.toolsDesc',
    icon: <Wrench className="size-4" />,
    render: () => <ToolsSection />
  },
  {
    id: 'extensions',
    labelKey: 'settings.extensions',
    descriptionKey: 'settings.extensionsDesc',
    icon: <Puzzle className="size-4" />,
    render: () => <ExtensionsSection />
  },
  {
    id: 'skills',
    labelKey: 'settings.skills',
    descriptionKey: 'settings.skillsDesc',
    icon: <GraduationCap className="size-4" />,
    render: () => <SkillsSection />
  }
]

interface SettingsPageProps extends SectionProps {
  open: boolean
  onBack: () => void
}

/**
 * Full-page Settings — back button top-left, beUI Tabs turned into a vertical
 * rail (the pill indicator glides between sections). Rendered above the
 * workspace instead of unmounting it, so composer drafts and scroll positions
 * survive the round-trip; the opaque background keeps it reading as a page.
 */
export function SettingsPage({ open, onBack, ...sectionProps }: SettingsPageProps) {
  const { t } = useI18n()
  const [section, setSection] = useState(SECTIONS[0].id)
  const reduce = useReducedMotion()

  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          initial={{ opacity: 0, x: reduce ? 0 : 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: reduce ? 0 : 24 }}
          transition={reduce ? { duration: 0 } : { duration: 0.22, ease: EASE_OUT }}
          className="absolute inset-0 z-40 flex flex-col bg-background"
        >
          <WindowTitlebar className="gap-1.5 border-b border-border/50">
            <Button variant="ghost" size="icon" aria-label={t('settings.back')} onClick={onBack}>
              <ArrowLeft className="size-4" />
            </Button>
            <h1 className="px-1 text-sm font-semibold text-foreground">{t('settings.title')}</h1>
          </WindowTitlebar>

          <Tabs
            value={section}
            onValueChange={setSection}
            variant="pill"
            className="flex min-h-0 flex-1"
          >
            <TabsList className="my-4 ml-4 mr-2 flex w-60 shrink-0 flex-col items-stretch gap-1 self-stretch rounded-2xl p-1.5">
              {SECTIONS.map((entry) => (
                <TabsTrigger
                  key={entry.id}
                  value={entry.id}
                  className="w-full justify-start gap-2.5 rounded-control px-3.5 py-2.5"
                >
                  {entry.icon}
                  {t(entry.labelKey)}
                </TabsTrigger>
              ))}
            </TabsList>
            {SECTIONS.map((entry) => (
              <TabsContent key={entry.id} value={entry.id} className="mt-0 min-h-0 flex-1">
                <div className="h-full overflow-y-auto overscroll-contain px-6 py-7 md:px-10">
                  <div className="mx-auto w-full max-w-2xl">
                    <h2 className="text-lg font-semibold tracking-tight text-foreground">
                      {t(entry.labelKey)}
                    </h2>
                    <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
                      {t(entry.descriptionKey)}
                    </p>
                    <div className="mt-7">{entry.render(sectionProps)}</div>
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
