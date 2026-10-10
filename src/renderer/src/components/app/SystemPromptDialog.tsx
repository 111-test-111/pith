import { useMemo, useState } from 'react'
import { Check, Copy, TextAlignCenter } from '@/lib/icons'
import { MorphingModal } from '@/components/motion/morphing-modal'
import { Button } from '@/components/motion/button'
import { formatSystemPromptForDisplay } from '@/lib/system-prompt-format'
import { useI18n } from '@/i18n'

/**
 * Read-only view of the session's effective system prompt. The text arrives
 * with each open — the overflow menu entry fetches it fresh from main every
 * time — so what is shown is always what the next model request would carry;
 * a reload of extensions/skills/context files is reflected on the next open.
 *
 * One display concession: the machine-generated <available_skills> block is
 * re-indented and entity-decoded for readability (see system-prompt-format);
 * the rest of the prompt renders byte-for-byte. Stats and Copy follow the
 * displayed text.
 */
export function SystemPromptDialog({
  prompt,
  onClose
}: {
  /** `null` keeps the dialog closed; a string opens it with that text. */
  prompt: string | null
  onClose: () => void
}) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const text = useMemo(() => (prompt === null ? '' : formatSystemPromptForDisplay(prompt)), [prompt])
  const copy = () => {
    if (prompt === null) return
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {})
  }
  return (
    <MorphingModal
      viewId={prompt !== null ? 'system-prompt' : null}
      onClose={onClose}
      placement="center"
      className="max-w-3xl"
    >
      <div className="flex items-center gap-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
          <TextAlignCenter className="size-4.5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-foreground">{t('systemPrompt.title')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('systemPrompt.stats', {
              chars: text.length,
              lines: text === '' ? 0 : text.split('\n').length
            })}
          </p>
        </div>
      </div>

      <pre className="mt-4 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/60 p-3 font-mono text-content text-foreground">
        {text}
      </pre>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? (
            <Check aria-hidden="true" className="size-3.5" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
          {t(copied ? 'systemPrompt.copied' : 'systemPrompt.copy')}
        </Button>
        <Button variant="primary" size="sm" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>
    </MorphingModal>
  )
}
