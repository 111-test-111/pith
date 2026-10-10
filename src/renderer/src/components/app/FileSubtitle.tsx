import { useMemo } from 'react'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { SubtitleFormat } from '../../../../shared/preview'
import { FadeScroll } from './FadeScroll'

/**
 * Preview for subtitles (`.srt`, `.vtt`) and timed lyrics (`.lrc`): the cue
 * list it describes, with a range for subtitles and a start time for lyrics.
 *
 * These formats are parsed here in a few regexes; there is no dependency and
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
  end: string | null
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

function lyricTime(milliseconds: number): string {
  const value = Math.max(0, milliseconds)
  const hours = Math.floor(value / 3600000)
  const minutes = Math.floor(value / 60000) % 60
  const seconds = Math.floor(value / 1000) % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(value % 1000).padStart(3, '0')}`
}

function parseLyrics(text: string): Cue[] {
  const source = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n')
  // Offset is global, including when the metadata follows the lyrics.
  // Positive offsets make a lyric appear earlier in the track.
  let offset = 0
  for (const match of source.matchAll(/^\s*\[offset:\s*([+-]?\d{1,9})\]\s*$/gim)) offset = Number(match[1])
  const lyrics: { time: number; text: string }[] = []
  for (const line of source.split('\n')) {
    if (lyrics.length >= MAX_CUES) break
    // Only leading time tags count; metadata and untimed lines stay in source.
    const stamps = /\s*\[(\d{1,6}):([0-5]\d)(?:\.(\d{1,3}))?\]/y
    const times: number[] = []
    let end = 0
    let match: RegExpExecArray | null
    while ((match = stamps.exec(line))) {
      if (times.length < MAX_CUES - lyrics.length) times.push(Number(match[1]) * 60000 + Number(match[2]) * 1000 + Number((match[3] ?? '').padEnd(3, '0')))
      end = stamps.lastIndex
    }
    // Enhanced LRC's inline word timestamps are markup, not visible prose.
    const payload = cueText([line.slice(end)])
    if (!payload) continue
    for (const time of times) lyrics.push({ time: time - offset, text: payload })
  }
  // Repeated timestamps on one line may refer to later choruses. Keep equal
  // times in source order so translations stay beside their original line.
  return lyrics.sort((a, b) => a.time - b.time).map(lyric => ({ start: lyricTime(lyric.time), end: null, text: lyric.text }))
}

export function parseCues(text: string, format: SubtitleFormat = 'srt'): Cue[] {
  if (format === 'lrc') return parseLyrics(text)
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

export function FileSubtitle({ text, format = 'srt' }: { text: string; format?: SubtitleFormat }) {
  const { t } = useI18n()
  const cues = useMemo(() => parseCues(text, format), [text, format])
  const lyrics = format === 'lrc'
  const truncated = cues.length >= MAX_CUES
  if (cues.length === 0) return <div role="status" data-file-subtitle-empty className="flex min-h-0 flex-1 items-center justify-center p-5 text-center text-xs leading-ui text-muted-foreground">{t(lyrics ? 'files.lyrics.empty' : 'files.subtitle.empty')}</div>
  return <div data-file-subtitle className="flex min-h-0 flex-1 flex-col">
    <div data-file-subtitle-bar role="status" className="flex h-9 shrink-0 items-center border-b border-border/40 px-3 text-caption tabular-nums text-muted-foreground">{t(lyrics ? 'files.lyrics.count' : 'files.subtitle.count', { count: cues.length })}</div>
    <FadeScroll className="min-h-0 flex-1 py-1">
      <ol className="m-0 list-none p-0">
        {cues.map((cue, index) => <li key={`${index}:${cue.start}`} data-subtitle-cue={index + 1} className={cn('grid items-baseline gap-3 px-3 py-1.5 hover:bg-primary/5', lyrics ? 'grid-cols-[6.5rem_minmax(0,1fr)]' : 'grid-cols-[13.5rem_minmax(0,1fr)]')}>
          <span aria-hidden className="select-none text-right font-mono text-micro leading-ui tabular-nums text-muted-foreground/60">{cue.start}{cue.end !== null ? ` → ${cue.end}` : ''}</span>
          <span className="whitespace-pre-wrap break-words text-content-tight">{cue.text}</span>
        </li>)}
      </ol>
      {truncated ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t(lyrics ? 'files.lyrics.truncated' : 'files.subtitle.truncated', { count: MAX_CUES })}</p> : null}
    </FadeScroll>
  </div>
}
