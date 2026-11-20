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
      {/* One title row, mirroring the search panel: a bare primary glyph beside
          the heading, with the size readout pushed to the row's right end. */}
      <div className="flex items-center gap-2">
        <TextAlignCenter aria-hidden="true" className="size-4 shrink-0 text-primary" />
        <h2 className="shrink-0 text-base font-semibold text-foreground">{t('systemPrompt.title')}</h2>
        <p className="ml-auto min-w-0 truncate text-xs text-muted-foreground">
          {t('systemPrompt.stats', {
            chars: text.length,
            lines: text === '' ? 0 : text.split('\n').length
          })}
        </p>
      </div>

      <pre className="mt-4 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/60 p-3 font-mono text-code text-foreground">
        {text}
      </pre>

      {/* The button row is this panel's last row, so it carries the whole bottom
          band: a tighter gap above it, and `-mb-2` against the modal's shared
          `p-5` (one padding for every dialog) so the 12px rhythm on each side
          of the row replaces the 20px of empty padding it used to leave. */}
      <div className="-mb-2 mt-3 flex justify-end gap-2">
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
