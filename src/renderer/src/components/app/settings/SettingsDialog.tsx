import { useState, type ReactNode } from 'react'
import { KeyRound, Palette, Settings2 } from 'lucide-react'
import { MorphingModal } from '@/components/motion/morphing-modal'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/motion/tabs'
import { useI18n } from '@/i18n'
import { GeneralSection } from './GeneralSection'
import { AppearanceSection } from './AppearanceSection'
import { ProvidersSection } from './ProvidersSection'

interface SectionProps {
  accent: string
  onAccentChange: (accent: string) => void
}

/**
 * Settings registry — adding a section is one entry here plus a section
 * component file; the dialog shell (tabs, modal) never changes. Labels resolve
 * through i18n so the registry stores keys, not strings.
 */
const SECTIONS: {
  id: string
  labelKey: 'settings.general' | 'settings.appearance' | 'settings.providers'
  icon: ReactNode
  render: (props: SectionProps) => ReactNode
}[] = [
  {
    id: 'general',
    labelKey: 'settings.general',
    icon: <Settings2 className="size-3.5" />,
    render: () => <GeneralSection />
  },
  {
    id: 'appearance',
    labelKey: 'settings.appearance',
    icon: <Palette className="size-3.5" />,
    render: (props) => (
      <AppearanceSection accent={props.accent} onAccentChange={props.onAccentChange} />
    )
  },
  {
    id: 'providers',
    labelKey: 'settings.providers',
    icon: <KeyRound className="size-3.5" />,
    render: () => <ProvidersSection />
  }
]

interface SettingsDialogProps extends SectionProps {
  open: boolean
  onClose: () => void
}

export function SettingsDialog({ open, onClose, ...sectionProps }: SettingsDialogProps) {
  const { t } = useI18n()
  const [section, setSection] = useState(SECTIONS[0].id)

  return (
    <MorphingModal
      viewId={open ? 'settings' : null}
      onClose={onClose}
      placement="center"
      className="max-w-2xl"
    >
      <div className="flex flex-col">
        <h2 className="px-1 text-base font-semibold text-foreground">{t('settings.title')}</h2>

        <Tabs value={section} onValueChange={setSection} variant="underline" className="mt-1">
          <TabsList>
            {SECTIONS.map((entry) => (
              <TabsTrigger key={entry.id} value={entry.id} className="gap-1.5">
                {entry.icon}
                {t(entry.labelKey)}
              </TabsTrigger>
            ))}
          </TabsList>
          {SECTIONS.map((entry) => (
            <TabsContent
              key={entry.id}
              value={entry.id}
              // Fixed height keeps the modal panel from resizing (and spring-
              // bouncing outward) whenever sections of different heights swap.
              className="mt-4 h-[28rem] overflow-y-auto pb-1 pr-1"
            >
              {entry.render(sectionProps)}
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </MorphingModal>
  )
}
