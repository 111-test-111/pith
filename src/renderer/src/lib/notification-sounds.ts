import { useEffect, useSyncExternalStore } from 'react'
import type { PiEvent } from '../../../shared/types'
import { useI18n } from '../i18n'
import { subscribeScheduledTransitions } from '../state/scheduled-tasks-store'

/**
 * Completion/question notifications — audio cues plus native OS alerts.
 *
 * Two cues, deliberately distinct in melody, timbre and rhythm so they can be
 * told apart without looking at the screen:
 *
 * - `turnComplete` — a rising three-note bell: the run is over and idle.
 * - `askUser`      — three crisp pings on one high pitch: the agent is blocked
 *                    on the user (an ask_user_question set is waiting for an
 *                    answer).
 *
 * They are synthesized with Web Audio instead of shipping audio files: two
 * short cues cost a handful of oscillator schedules, need no binary asset in
 * the bundle, follow the volume of the machine's own output device, and can be
 * re-tuned in one table. `NOTIFICATION_SOUNDS` is the single source for both.
 *
 * Cues are fired by the RENDERER, from the same `pi:event` stream the
 * transcript reads. The main process never decides to make noise; it ships
 * data — including the `subagentChild` fact, which is what keeps a
 * delegation's many child turns from chiming one by one.
 *
 * The sounds are a renderer preference (Settings → General → Sounds), stored
 * in localStorage like `show-reasoning`/`tool-grouping`/`spinner-verbs`: a
 * change applies to the very next cue with no session reload or IPC round
 * trip.
 */
export type NotificationSoundKind = 'turnComplete' | 'askUser' | 'scheduledTask'

/** One scheduled oscillator: a note of a cue. */
export interface NotificationTone {
  /** Pitch in Hz. */
  frequency: number
  /** Seconds after the cue's start. */
  at: number
  /** Seconds the note rings for. */
  duration: number
  wave: OscillatorType
  /** Level of this note within the cue (0–1), relative to the master gain. */
  gain: number
}

/**
 * The cue tables. Pitches are read as intervals rather than names:
 * `turnComplete` walks up a major triad (C5–E5–G5) so it can only read as an
 * ending that went well, while `askUser` repeats one A6 so it reads as a bright
 * call for attention instead of a sentence. The ask pings are also shorter and
 * triangle-waved, which keeps them distinct from the completion bell even
 * when the master volume is low.
 */
export const NOTIFICATION_SOUNDS: Record<NotificationSoundKind, readonly NotificationTone[]> = {
  turnComplete: [
    { frequency: 523.25, at: 0, duration: 0.55, wave: 'sine', gain: 0.85 },
    { frequency: 659.25, at: 0.09, duration: 0.6, wave: 'sine', gain: 0.9 },
    { frequency: 783.99, at: 0.18, duration: 0.9, wave: 'sine', gain: 1 }
  ],
  askUser: [
    { frequency: 1760, at: 0, duration: 0.12, wave: 'triangle', gain: 1 },
    { frequency: 1760, at: 0.18, duration: 0.12, wave: 'triangle', gain: 1 },
    { frequency: 1760, at: 0.42, duration: 0.28, wave: 'triangle', gain: 0.9 }
  ],
  // A soft two-chime descent (A5 → D5): it must read as "something landed on
  // its own" — the mirror of `turnComplete`'s rising triad (a run you were
  // watching ended well), and nothing like the ask pings' single repeated
  // pitch. Pitches deliberately share none with either cue (the bell owns
  // C5/E5/G5, the ask owns A6); sine keeps it in the bell family.
  scheduledTask: [
    { frequency: 880, at: 0, duration: 0.4, wave: 'sine', gain: 0.9 },
    { frequency: 587.33, at: 0.16, duration: 0.75, wave: 'sine', gain: 1 }
  ]
}

/** Every cue the app can play, in the order Settings lists them. */
export const NOTIFICATION_SOUND_KINDS: readonly NotificationSoundKind[] = ['turnComplete', 'askUser', 'scheduledTask']

/** Loud enough to be heard over other system audio, but not startling. */
const MASTER_GAIN = 0.75
/** Short fade-in — a hard gate on an oscillator clicks. */
const ATTACK_SECONDS = 0.012
/** `exponentialRampToValueAtTime` cannot reach zero; this is silence for it. */
const SILENCE = 0.0001
/** Scheduling lead, so a cue's first note is not already in the past. */
const START_LEAD_SECONDS = 0.02

// ── the audio engine ─────────────────────────────────────────────────────────

/**
 * One AudioContext for the app's lifetime (created on the first cue, so a
 * session that never plays one never opens an output device). A context can
 * start suspended under an autoplay policy; scheduling still works and the
 * `resume()` below makes the pending notes audible once the gesture lands.
 */
let context: AudioContext | null = null
let contextUnavailable = false

function audioContext(): AudioContext | null {
  if (context || contextUnavailable) return context
  try {
    if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') {
      contextUnavailable = true
      return null
    }
    context = new window.AudioContext()
  } catch {
    // No audio output (headless/CI, no device). A cue is best-effort feedback:
    // failing to open a device must never propagate into the event stream.
    contextUnavailable = true
  }
  return context
}

/**
 * Schedule one cue's notes. Returns whether anything was scheduled at all, so
 * a caller can tell "silent on purpose" (settings/flags) from "no device".
 */
function scheduleSound(kind: NotificationSoundKind): boolean {
  const ctx = audioContext()
  if (!ctx) return false
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  const master = ctx.createGain()
  master.gain.value = MASTER_GAIN
  master.connect(ctx.destination)
  const start = ctx.currentTime + START_LEAD_SECONDS
  for (const tone of NOTIFICATION_SOUNDS[kind]) {
    const oscillator = ctx.createOscillator()
    oscillator.type = tone.wave
    oscillator.frequency.value = tone.frequency
    const envelope = ctx.createGain()
    const from = start + tone.at
    const to = from + tone.duration
    envelope.gain.setValueAtTime(SILENCE, from)
    envelope.gain.linearRampToValueAtTime(tone.gain, from + ATTACK_SECONDS)
    envelope.gain.exponentialRampToValueAtTime(SILENCE, to)
    oscillator.connect(envelope).connect(master)
    oscillator.start(from)
    oscillator.stop(to + 0.02)
  }
  return true
}

// ── preferences (Settings → General → Sounds) ────────────────────────────────

export interface NotificationSoundSettings {
  /** Master switch; off silences every cue without forgetting the per-cue ones. */
  enabled: boolean
  /** The turn-finished cue. */
  turnComplete: boolean
  /** The blocked-on-the-user cue. */
  askUser: boolean
  /** The scheduled-run-finished cue. */
  scheduledTask: boolean
}

/** One localStorage key per flag, like the other renderer preferences. */
const STORAGE_KEYS: Record<keyof NotificationSoundSettings, string> = {
  enabled: 'pi-app:sound-enabled',
  turnComplete: 'pi-app:sound-turn-complete',
  askUser: 'pi-app:sound-ask-user',
  scheduledTask: 'pi-app:sound-scheduled-task'
}

const DEFAULTS: NotificationSoundSettings = { enabled: true, turnComplete: true, askUser: true, scheduledTask: true }

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== 'off'
  } catch {
    return true
  }
}

let current: NotificationSoundSettings = DEFAULTS
/** Lazily initialized on first read so module import never touches storage. */
let initialized = false

const listeners = new Set<() => void>()

export function notificationSoundSettings(): NotificationSoundSettings {
  if (!initialized) {
    current = {
      enabled: readFlag(STORAGE_KEYS.enabled),
      turnComplete: readFlag(STORAGE_KEYS.turnComplete),
      askUser: readFlag(STORAGE_KEYS.askUser),
      scheduledTask: readFlag(STORAGE_KEYS.scheduledTask)
    }
    initialized = true
  }
  return current
}

export function setNotificationSoundSettings(patch: Partial<NotificationSoundSettings>): void {
  const previous = notificationSoundSettings()
  const next = { ...previous, ...patch }
  if (
    next.enabled === previous.enabled &&
    next.turnComplete === previous.turnComplete &&
    next.askUser === previous.askUser &&
    next.scheduledTask === previous.scheduledTask
  ) {
    return
  }
  current = next
  for (const key of Object.keys(patch) as (keyof NotificationSoundSettings)[]) {
    try {
      window.localStorage.setItem(STORAGE_KEYS[key], next[key] ? 'on' : 'off')
    } catch {
      /* persistence is best-effort; the in-memory value still applies */
    }
  }
  for (const listener of listeners) listener()
}

/** Whether a cue of this kind is currently allowed to sound. */
export function notificationSoundAllowed(kind: NotificationSoundKind): boolean {
  const settings = notificationSoundSettings()
  if (!settings.enabled) return false
  if (kind === 'turnComplete') return settings.turnComplete
  if (kind === 'askUser') return settings.askUser
  return settings.scheduledTask
}

/**
 * Play a cue IF the preferences allow it — the path every automatic trigger
 * takes.
 */
export function triggerNotificationSound(kind: NotificationSoundKind): boolean {
  if (!notificationSoundAllowed(kind)) return false
  return scheduleSound(kind)
}

/**
 * Play a cue unconditionally — the Settings → Sounds "preview" action. An
 * explicit "let me hear it" must work while the cue is switched off, or the
 * switch could never be judged before turning it on.
 */
export function previewNotificationSound(kind: NotificationSoundKind): boolean {
  return scheduleSound(kind)
}

// ── native system notifications ─────────────────────────────────────────────

export interface SystemNotificationCopy {
  title: string
  body: string
}

export interface SystemNotificationSettings {
  /** Independent of audio: off suppresses automatic OS notifications only. */
  enabled: boolean
}

export type SystemNotificationPermission = NotificationPermission | 'unsupported'

const SYSTEM_NOTIFICATION_STORAGE_KEY = 'pi-app:system-notifications-enabled'
const DEFAULT_SYSTEM_NOTIFICATION_SETTINGS: SystemNotificationSettings = { enabled: false }
let currentSystemNotifications = DEFAULT_SYSTEM_NOTIFICATION_SETTINGS
let systemNotificationsInitialized = false
const systemNotificationListeners = new Set<() => void>()
let notificationPermissionRequest: Promise<NotificationPermission> | null = null

export function systemNotificationSettings(): SystemNotificationSettings {
  if (!systemNotificationsInitialized) {
    let enabled = false
    try {
      enabled = window.localStorage.getItem(SYSTEM_NOTIFICATION_STORAGE_KEY) === 'on'
    } catch {
      /* use the safe default */
    }
    currentSystemNotifications = { enabled }
    systemNotificationsInitialized = true
  }
  return currentSystemNotifications
}

export function setSystemNotificationSettings(patch: Partial<SystemNotificationSettings>): void {
  const previous = systemNotificationSettings()
  const next = { ...previous, ...patch }
  if (next.enabled === previous.enabled) return
  currentSystemNotifications = next
  try {
    window.localStorage.setItem(SYSTEM_NOTIFICATION_STORAGE_KEY, next.enabled ? 'on' : 'off')
  } catch {
    /* persistence is best-effort; the in-memory value still applies */
  }
  for (const listener of systemNotificationListeners) listener()
}

export function systemNotificationPermission(): SystemNotificationPermission {
  if (typeof window === 'undefined' || typeof window.Notification !== 'function') return 'unsupported'
  return window.Notification.permission
}

/**
 * Request permission only when enabling or previewing notifications (or when a
 * previously enabled installation has had its OS permission reset). Concurrent
 * callers share one request and a denial is never requested again.
 */
export async function requestSystemNotificationPermission(): Promise<SystemNotificationPermission> {
  const current = systemNotificationPermission()
  if (current !== 'default') return current
  try {
    if (!notificationPermissionRequest) {
      const request = window.Notification.requestPermission()
      notificationPermissionRequest = request
      const clear = () => {
        if (notificationPermissionRequest === request) notificationPermissionRequest = null
      }
      void request.then(clear, clear)
    }
    return await notificationPermissionRequest
  } catch {
    return 'default'
  }
}

async function showSystemNotification(copy: SystemNotificationCopy): Promise<boolean> {
  if ((await requestSystemNotificationPermission()) !== 'granted') return false
  try {
    const notification = new window.Notification(copy.title, { body: copy.body })
    notification.onclick = () => {
      window.focus()
      notification.close()
    }
    return true
  } catch {
    // Native notifications are best-effort (for example, unsigned macOS dev
    // builds cannot post them); audio and the in-app UI must keep working.
    return false
  }
}

/** Automatic event path: obey the independent system-notification switch. */
export async function triggerSystemNotification(copy: SystemNotificationCopy): Promise<boolean> {
  if (!systemNotificationSettings().enabled) return false
  return showSystemNotification(copy)
}

/** Settings preview: try once even while automatic notifications are off. */
export async function previewSystemNotification(copy: SystemNotificationCopy): Promise<boolean> {
  return showSystemNotification(copy)
}

export function useSystemNotifications(): [
  SystemNotificationSettings,
  (patch: Partial<SystemNotificationSettings>) => void
] {
  const settings = useSyncExternalStore(
    (listener) => {
      systemNotificationListeners.add(listener)
      return () => systemNotificationListeners.delete(listener)
    },
    systemNotificationSettings
  )
  return [settings, setSystemNotificationSettings]
}

/** Subscribable sound preferences, shared by the cue triggers and Settings. */
export function useNotificationSounds(): [
  NotificationSoundSettings,
  (patch: Partial<NotificationSoundSettings>) => void
] {
  const settings = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    notificationSoundSettings
  )
  return [settings, setNotificationSoundSettings]
}

// ── event → cue routing ──────────────────────────────────────────────────────

export interface NotificationSoundDecision {
  kind: NotificationSoundKind
  /** An ask set to remember as announced, so a republish cannot ring twice. */
  announce?: string
}

/**
 * Ask sets this renderer has already announced.
 *
 * Main REPUBLISHES a chat's whole pending ask list whenever anything about it
 * changes — and again when the session is activated, so a question asked while
 * another chat was on screen can be answered. Both are the same question, and
 * the user must hear one ping per question, not one per republish. Request ids
 * are therefore remembered here and only a fresh one rings.
 */
const announcedAsks = new Set<string>()
/** Bounded so a long-lived renderer cannot grow this set without limit. */
const ANNOUNCED_ASK_LIMIT = 200

function rememberAnnouncedAsk(requestId: string): void {
  announcedAsks.add(requestId)
  while (announcedAsks.size > ANNOUNCED_ASK_LIMIT) {
    const oldest = announcedAsks.values().next().value
    if (oldest === undefined) break
    announcedAsks.delete(oldest)
  }
}

/**
 * Which cue (if any) an event should sound. Pure apart from the caller's
 * "already announced" lookup, so the rules can be read and checked without an
 * audio device:
 *
 * - `agent_settled` is the end of a run (never `agent_end`), and only when it
 *   is NOT `continuing` — a continuation means a queued message, an auto-retry
 *   or a background completion is about to keep the same run alive — and not
 *   `userAborted`, which marks the run the user stopped themselves.
 * - A subagent child settles many times per delegation; its turns are steps of
 *   the parent's own turn, so they never chime.
 * - `ask_user` carries the whole pending list of one owner chat; only a
 *   request id we have not seen rings.
 */
export function notificationSoundForEvent(
  event: PiEvent,
  isAnnounced: (requestId: string) => boolean
): NotificationSoundDecision | null {
  if (event.subagentChild === true) return null
  if (event.type === 'agent_settled') {
    return event.continuing || event.userAborted ? null : { kind: 'turnComplete' }
  }
  if (event.type === 'ask_user') {
    const requests = Array.isArray(event.requests) ? event.requests : []
    for (const request of requests) {
      const requestId = (request as { requestId?: unknown } | null)?.requestId
      if (typeof requestId !== 'string' || requestId === '') continue
      if (isAnnounced(requestId)) continue
      return { kind: 'askUser', announce: requestId }
    }
  }
  return null
}

/**
 * Scheduled run completions: one cue per snapshot batch (never per run), fed
 * by the store's active→terminal transition diff, so app boots and already-
 * read history stay silent. Native copy names the task and its outcome.
 */
export function useScheduledTaskCompletionCue(): void {
  const { t } = useI18n()
  useEffect(() => {
    const off = subscribeScheduledTransitions((runs) => {
      triggerNotificationSound('scheduledTask')
      const failed = runs.filter((run) => run.status !== 'succeeded').length
      const copy =
        runs.length === 1
          ? {
              title: t('notification.scheduledTaskTitle'),
              body: t('notification.scheduledTaskBodyOne', {
                name: runs[0].taskName,
                status: t(`scheduledTasks.run.status.${runs[0].status}`)
              })
            }
          : {
              title: t('notification.scheduledTaskTitle'),
              body: t('notification.scheduledTaskBodyMany', { count: runs.length, failed })
            }
      void triggerSystemNotification(copy)
    })
    return () => off()
  }, [t])
}

/**
 * Play the app's cues from the live `pi:event` stream. Mounted once, at the top
 * of the app: the events arrive for background sessions too, which is exactly
 * what makes the cues useful — the user is told a chat finished or needs an
 * answer without having to watch it.
 */
export function useNotificationSoundEvents(): void {
  const { t } = useI18n()
  useEffect(() => {
    const off = window.pi?.onEvent?.((event) => {
      const decision = notificationSoundForEvent(event, (requestId) => announcedAsks.has(requestId))
      if (!decision) return
      // Remember before notifying: a republished ask is the same question even
      // if sound is muted or native notification permission is denied.
      if (decision.announce) rememberAnnouncedAsk(decision.announce)
      triggerNotificationSound(decision.kind)
      const copy = decision.kind === 'turnComplete'
        ? { title: t('notification.turnCompleteTitle'), body: t('notification.turnCompleteBody') }
        : { title: t('notification.askUserTitle'), body: t('notification.askUserBody') }
      void triggerSystemNotification(copy)
    })
    return () => off?.()
  }, [t])
}
