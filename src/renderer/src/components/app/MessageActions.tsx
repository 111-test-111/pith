import { useState, type ReactNode } from 'react'
import { Check, Copy } from '@/lib/icons'
import { Button } from '@/components/motion/button'
import { Tooltip } from '@/components/motion/tooltip'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'

/**
 * Hover-revealed action row under a message (revealed via the enclosing
 * beUI `Message` row's `group/message`). Composition of beUI primitives: ghost
 * icon buttons + Tooltip; labels come from i18n, never hardcoded.
 */
export function MessageActions({
  children,
  alwaysVisible = false
}: {
  children: ReactNode
  /** Keep the row visible instead of revealing it on hover — used for the
   * retry/fork fallback row of a turn that never produced a completion row. */
  alwaysVisible?: boolean
}) {
  return (
    <div
      data-message-actions
      data-transcript-gap-before="actions"
      className={cn(
        'flex min-h-7 items-center gap-0.5 px-1 transition-opacity',
        alwaysVisible
          ? 'opacity-100'
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
export function CopyAction({ text }: { text: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }
  return (
    <MessageAction label={t(copied ? 'chat.messageCopied' : 'chat.messageCopy')} onClick={copy}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </MessageAction>
  )
}

export { MessageAction }
