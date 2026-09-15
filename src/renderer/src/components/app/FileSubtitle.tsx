import { useMemo } from 'react'
import { useI18n } from '@/i18n'

/**
 * Preview for a subtitle file (`.srt`, `.vtt`): the cue list it describes —
 * timestamp range and text — instead of the raw cue blocks.
 *
 * Both formats are parsed here in a few regexes; there is no dependency and
 * nothing to load, which is the whole reason they are worth previewing at all.
 * The parse is deliberately forgiving: a malformed cue is skipped rather than
 * failing the file, because the source view is always one tab away and a
 * preview that renders nothing is less useful than one that renders what it
 * could read.
 */

/** How many cues are rendered. A feature-length film's subtitles are ~2000
 * cues; this only stops a pathological file from building a huge DOM. */
const MAX_CUES = 5000
/** Characters one cue keeps. */
const MAX_CUE_CHARS = 4000

interface Cue {
  start: string
  end: string
  text: string
}

/** `HH:MM:SS.mmm`, `MM:SS.mmm` and the comma decimal SRT uses → the same shape. */
function normalizeTime(value: string): string {
  const [clock, fraction] = value.replace(',', '.').split('.')
  const parts = clock.split(':').map(Number)
  const hours = parts.length === 3 ? parts[0] : 0
  const minutes = parts.length === 3 ? parts[1] : parts[0]
  const seconds = parts.at(-1) ?? 0
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${fraction ?? '000'}`
}

const TIMING = /^\s*(\d{1,3}:\d{1,2}:\d{1,2}[.,]\d{1,3}|\d{1,2}:\d{1,2}[.,]\d{1,3})\s*-->\s*(\d{1,3}:\d{1,2}:\d{1,2}[.,]\d{1,3}|\d{1,2}:\d{1,2}[.,]\d{1,3})/

/** Cue text with the inline markup both formats carry stripped: VTT's `<i>`,
 * `<c.class>`, `<v Speaker>` and SRT's `{\an8}`-style override blocks. */
function cueText(lines: string[]): string {
  return lines.join('\n').replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').trim().slice(0, MAX_CUE_CHARS)
}

export function parseCues(text: string): Cue[] {
  const cues: Cue[] = []
  // A block is a cue when one of its lines carries an arrow; the lines before it
  // are the cue id (SRT's index, or VTT's optional identifier) and the ones
  // after are its payload. `WEBVTT`, `NOTE`, `STYLE` and `REGION` blocks simply
  // never match, so they drop out without a special case.
  for (const block of text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n')
    const timing = lines.findIndex(line => TIMING.test(line))
    if (timing < 0) continue
    const match = TIMING.exec(lines[timing])!
    const payload = cueText(lines.slice(timing + 1))
    if (!payload) continue
    cues.push({ start: normalizeTime(match[1]), end: normalizeTime(match[2]), text: payload })
    if (cues.length >= MAX_CUES) break
  }
  return cues
}

export function FileSubtitle({ text }: { text: string }) {
  const { t } = useI18n()
  const cues = useMemo(() => parseCues(text), [text])
  const truncated = cues.length >= MAX_CUES
  if (cues.length === 0) return <div role="status" data-file-subtitle-empty className="flex min-h-0 flex-1 items-center justify-center p-5 text-center text-xs leading-5 text-muted-foreground">{t('files.subtitle.empty')}</div>
  return <div data-file-subtitle className="flex min-h-0 flex-1 flex-col">
    <div data-file-subtitle-bar role="status" className="flex h-9 shrink-0 items-center border-b border-border/40 px-3 text-[11px] tabular-nums text-muted-foreground">{t('files.subtitle.count', { count: cues.length })}</div>
    <div className="min-h-0 flex-1 overflow-auto py-1">
      <ol className="m-0 list-none p-0">
        {cues.map((cue, index) => <li key={`${index}:${cue.start}`} data-subtitle-cue={index + 1} className="grid grid-cols-[13.5rem_minmax(0,1fr)] items-baseline gap-3 px-3 py-1.5 hover:bg-primary/5">
          <span aria-hidden className="select-none text-right font-mono text-[10px] leading-5 tabular-nums text-muted-foreground/60">{cue.start} → {cue.end}</span>
          <span className="whitespace-pre-wrap break-words text-sm leading-5">{cue.text}</span>
        </li>)}
      </ol>
      {truncated ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t('files.subtitle.truncated', { count: MAX_CUES })}</p> : null}
    </div>
  </div>
}
