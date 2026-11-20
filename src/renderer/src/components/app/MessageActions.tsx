import { useState, type ReactNode } from 'react'
import { Check, Copy, FileCode2 } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'

/**
 * Hover-revealed action row under a message (revealed via the enclosing
 * beUI `Message` row's `group/message`). Composition of beUI primitives: ghost
 * icon buttons + Tooltip; labels come from i18n, never hardcoded.
 */
export function MessageActions({
  children,
  alwaysVisible = false,
  overlay = false
}: {
  children: ReactNode
  /** Keep the row visible instead of revealing it on hover — used for the
   * retry/fork fallback row of a turn that never produced a completion row. */
  alwaysVisible?: boolean
  /** Keeps the action row within the gap below a steering bubble. */
  overlay?: boolean
}) {
  return (
    <div
      data-message-actions={overlay ? 'overlay' : ''}
      data-transcript-gap-before="actions"
      className={cn(
        'flex min-h-7 items-center gap-0.5 px-1 transition-opacity',
        overlay && 'absolute end-0 top-full z-10 min-h-6 [&_button]:size-6',
        alwaysVisible
          ? 'opacity-100'
          : overlay
            ? 'pointer-events-none opacity-0 group-hover/steer:pointer-events-auto group-hover/steer:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100'
            : 'opacity-0 group-hover/message:opacity-100 focus-within:opacity-100'
      )}
    >
      {children}
    </div>
  )
}

/** One icon action. The tooltip label doubles as the accessible name. */
function MessageAction({
  label,
  onClick,
  children
}: {
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip content={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 rounded-md text-muted-foreground hover:text-foreground"
        aria-label={label}
        onClick={onClick}
      >
        {children}
      </Button>
    </Tooltip>
  )
}

/** Copy an arbitrary text with a transient check-mark confirmation. */
export function CopyAction({ text, label = 'chat.messageCopy', copiedLabel = 'chat.messageCopied', icon }: {
  text: string
  label?: MessageKey
  copiedLabel?: MessageKey
  icon?: ReactNode
}) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }
  return (
    <MessageAction label={t(copied ? copiedLabel : label)} onClick={copy}>
      {copied ? <Check className="size-3.5" /> : icon ?? <Copy className="size-3.5" />}
    </MessageAction>
  )
}

/** Copy the reply's raw Markdown source instead of its rendered text. */
export function CopyMarkdownAction({ text }: { text: string }) {
  return <CopyAction text={text} label="chat.copyMarkdown" copiedLabel="chat.markdownCopied" icon={<FileCode2 className="size-3.5" />} />
}

export { MessageAction }
