import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { Button } from '@/components/motion/button'
import { RangeSlider } from '@/components/motion/range-slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/motion/select'
import { Tooltip } from '@/components/motion/tooltip'
import { Maximize2, Minimize2, MusicNote, Pause, Play, Volume2, VolumeX } from '@/lib/icons'
import { useI18n } from '@/i18n'
import { basename } from '@/lib/format'
import { cn } from '@/lib/utils'
import { mediaUrl } from '../../../../shared/media'
import { MiddleEllipsis } from './MiddleEllipsis'
import { RunningLoader } from './RunningLoader'

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2]

function mediaTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(whole / 60)
  const remainder = String(whole % 60).padStart(2, '0')
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`
}

/** Native media owns decoding and Range requests; beUI owns every control.
 * The same element survives pane resizing, refreshes and full-screen changes. */
export function FileMediaPlayer({ path, kind }: { path: string; kind: 'audio' | 'video' }) {
  const { t } = useI18n()
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const lastVolume = useRef(1)
  const [failed, setFailed] = useState(false)
  const [actionError, setActionError] = useState<'play' | 'fullscreen' | null>(null)
  const [buffering, setBuffering] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [playback, setPlayback] = useState({ ready: false, playing: false, time: 0, duration: 0, volume: 1, muted: false, rate: 1 })
  const setMediaRef = useCallback((node: HTMLMediaElement | null) => { mediaRef.current = node }, [])

  const sync = useCallback((media: HTMLMediaElement) => {
    if (media.volume > 0) lastVolume.current = media.volume
    setPlayback({
      ready: media.readyState >= HTMLMediaElement.HAVE_METADATA,
      playing: !media.paused && !media.ended,
      time: Number.isFinite(media.currentTime) ? media.currentTime : 0,
      duration: Number.isFinite(media.duration) ? media.duration : 0,
      volume: media.volume,
      muted: media.muted,
      rate: media.playbackRate
    })
  }, [])
  const onMediaChange = (event: SyntheticEvent<HTMLMediaElement>) => sync(event.currentTarget)

  useEffect(() => {
    const update = () => setFullscreen(surfaceRef.current !== null && document.fullscreenElement === surfaceRef.current)
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])

  const togglePlay = async () => {
    const media = mediaRef.current
    if (!media) return
    setActionError(null)
    if (!media.paused) { media.pause(); return }
    try {
      if (media.ended) media.currentTime = 0
      await media.play()
    } catch (error) {
      // Switching files or pausing during play() aborts its pending promise.
      if (mediaRef.current === media && !(error instanceof DOMException && error.name === 'AbortError')) setActionError('play')
    }
  }

  const seek = (time: number) => {
    const media = mediaRef.current
    if (!media || playback.duration <= 0) return
    media.currentTime = Math.min(playback.duration, Math.max(0, time))
    sync(media)
  }

  const toggleMute = () => {
    const media = mediaRef.current
    if (!media) return
    if (media.muted || media.volume === 0) {
      if (media.volume === 0) media.volume = lastVolume.current
      media.muted = false
    } else media.muted = true
    sync(media)
  }

  const changeVolume = (volume: number) => {
    const media = mediaRef.current
    if (!media) return
    media.volume = volume / 100
    media.muted = volume === 0
    sync(media)
  }

  const changeRate = (value: string) => {
    const media = mediaRef.current
    const rate = Number(value)
    if (!media || !RATES.includes(rate)) return
    media.playbackRate = rate
    sync(media)
  }

  const toggleFullscreen = async () => {
    const surface = surfaceRef.current
    if (!surface) return
    setActionError(null)
    try {
      if (document.fullscreenElement === surface) await document.exitFullscreen()
      else await surface.requestFullscreen()
    } catch { if (surfaceRef.current === surface) setActionError('fullscreen') }
  }

  if (failed) return <div role="status" className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-muted/30 p-5 text-center text-xs leading-ui text-muted-foreground">
    {kind === 'audio' ? <MusicNote aria-hidden className="size-5 text-muted-foreground/60" /> : <Play aria-hidden className="size-5 text-muted-foreground/60" />}{t('files.media.failed')}
  </div>

  const name = basename(path)
  const muted = playback.muted || playback.volume === 0
  const playLabel = t(playback.playing ? 'files.media.pause' : 'files.media.play')
  const muteLabel = t(muted ? 'files.media.unmute' : 'files.media.mute')
  const fullscreenLabel = t(fullscreen ? 'files.media.exitFullscreen' : 'files.media.fullscreen')
  const mediaProps = {
    ref: setMediaRef,
    src: mediaUrl(path),
    preload: 'metadata',
    onLoadedMetadata: onMediaChange,
    onDurationChange: onMediaChange,
    onTimeUpdate: onMediaChange,
    onVolumeChange: onMediaChange,
    onRateChange: onMediaChange,
    onPlay: onMediaChange,
    onPause: (event: SyntheticEvent<HTMLMediaElement>) => { setBuffering(false); sync(event.currentTarget) },
    onEnded: (event: SyntheticEvent<HTMLMediaElement>) => { setBuffering(false); sync(event.currentTarget) },
    onWaiting: () => setBuffering(true),
    onPlaying: () => setBuffering(false),
    onSeeked: (event: SyntheticEvent<HTMLMediaElement>) => { setBuffering(false); sync(event.currentTarget) },
    onCanPlay: () => setBuffering(false),
    onError: () => setFailed(true)
  }

  return <div data-file-media={kind} className="flex min-h-0 min-w-0 flex-1 flex-col justify-center bg-muted/30 p-3">
    <div ref={surfaceRef} className={cn('file-media-player sidebar-pane-container flex w-full min-w-0 flex-col rounded-item border border-border bg-background shadow-xs', kind === 'video' && 'min-h-0 flex-1', fullscreen && 'size-full rounded-none border-0 shadow-none')}>
      {kind === 'video' ? <div className="min-h-0 flex-1 overflow-hidden rounded-t-item">
        <video {...mediaProps} playsInline aria-label={t('files.media.videoAria', { name })} className="block size-full object-contain" />
      </div> : <>
        <div className="flex min-w-0 items-center gap-3 px-4 pb-1 pt-4">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-item bg-primary/10 text-primary"><MusicNote aria-hidden className="size-4" /></span>
          <MiddleEllipsis name={name} className="min-w-0 text-sm font-medium" />
        </div>
        <audio {...mediaProps} aria-label={t('files.media.audioAria', { name })} />
      </>}
      <div role="group" aria-label={t('files.media.controlsAria')} data-media-controls className={cn('shrink-0 space-y-1.5 p-3', kind === 'video' && 'border-t border-border')}>
        <RangeSlider
          value={playback.time} min={0} max={playback.duration} step={0.1} showTicks={false}
          disabled={!playback.ready || playback.duration <= 0} onValueChange={seek}
          aria-label={t('files.media.seek')}
          formatValueText={value => t('files.media.position', { current: mediaTime(value), duration: mediaTime(playback.duration) })}
          className="h-6"
        />
        <div className="file-media-toolbar">
          <div className="file-media-playback flex min-w-0 flex-wrap items-center gap-2">
            <Tooltip content={playLabel} disabled={fullscreen}><Button variant="ghost" size="icon" className="size-8 shrink-0 text-foreground hover:bg-muted hover:text-primary" disabled={!playback.ready} aria-label={playLabel} onClick={() => { void togglePlay() }}>
              {buffering ? <RunningLoader label={t('files.media.buffering')} size={16} /> : playback.playing ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="size-4" />}
            </Button></Tooltip>
            <span data-media-time className="whitespace-nowrap text-xs tabular-nums"><span className="text-foreground">{mediaTime(playback.time)}</span><span className="text-muted-foreground"> / {playback.duration > 0 ? mediaTime(playback.duration) : '–:––'}</span></span>
          </div>
          <div className="file-media-volume flex min-w-0 items-center gap-1.5">
            <Tooltip content={muteLabel} disabled={fullscreen}><Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={muteLabel} aria-pressed={muted} onClick={toggleMute}>
              {muted ? <VolumeX aria-hidden className="size-4" /> : <Volume2 aria-hidden className="size-4" />}
            </Button></Tooltip>
            <RangeSlider value={muted ? 0 : Math.round(playback.volume * 100)} min={0} max={100} step={1} showTicks={false} onValueChange={changeVolume} aria-label={t('files.media.volume')} formatValueText={value => `${value}%`} className="h-6 min-w-0 flex-1" />
          </div>
          <Select value={String(playback.rate)} onValueChange={changeRate} className="file-media-speed" disabled={!playback.ready}>
            <SelectTrigger aria-label={t('files.media.speed')} className="h-7 gap-1 rounded-control px-2 py-0 text-xs tabular-nums"><SelectValue /></SelectTrigger>
            <SelectContent portal={!fullscreen} portalAlign="end" portalWidth={112} className={cn('rounded-control', fullscreen && 'left-auto w-28')}>
              <ul>{RATES.map(rate => <SelectItem key={rate} value={String(rate)} className="rounded-inner text-xs">{`${rate}×`}</SelectItem>)}</ul>
            </SelectContent>
          </Select>
          {kind === 'video' ? <div className="file-media-fullscreen"><Tooltip content={fullscreenLabel} disabled={fullscreen}><Button variant="ghost" size="icon" className="size-7" disabled={!document.fullscreenEnabled} aria-label={fullscreenLabel} onClick={() => { void toggleFullscreen() }}>
            {fullscreen ? <Minimize2 aria-hidden className="size-4" /> : <Maximize2 aria-hidden className="size-4" />}
          </Button></Tooltip></div> : null}
        </div>
        {actionError ? <p role="alert" className="text-xs text-destructive">{t(actionError === 'play' ? 'files.media.playFailed' : 'files.media.fullscreenFailed')}</p> : null}
      </div>
    </div>
  </div>
}
