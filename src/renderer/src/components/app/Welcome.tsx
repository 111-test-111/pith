import { useState } from 'react'
import { FolderOpen, Loader2 } from 'lucide-react'
import { Button } from '@/components/motion/button'
import { ThemeToggle } from '@/components/motion/theme-toggle'
import { useI18n } from '@/i18n'

interface WelcomeProps {
  onPickFolder: () => Promise<void>
}

export function Welcome({ onPickFolder }: WelcomeProps) {
  const { t } = useI18n()
  const [opening, setOpening] = useState(false)

  return (
    <div className="relative grid h-full place-items-center bg-background px-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="flex max-w-md flex-col items-center gap-5 text-center">
        <div className="grid size-16 place-items-center rounded-3xl bg-primary/10 font-mono text-4xl font-bold text-primary">
          π
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            {t('welcome.title')}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('welcome.body')}</p>
        </div>
        <Button
          size="lg"
          disabled={opening}
          onClick={async () => {
            setOpening(true)
            try {
              await onPickFolder()
            } finally {
              setOpening(false)
            }
          }}
        >
          {opening ? <Loader2 className="size-4 animate-spin" /> : <FolderOpen className="size-4" />}
          {t('welcome.choose')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('welcome.footnote')}</p>
      </div>
    </div>
  )
}
