/**
 * App-owned admission for background wake/steer work.
 *
 * The three notification owners (bash completions, async ask outcomes,
 * subagent completions) can only reach a session by asking it first: a sealed
 * planning turn (the model already submitted its plan) or an in-flight mode
 * transition must DEFER the wake, never let it through. A deferred wake keeps
 * owning its pending result, spends no wake attempt and arms no retry loop; it
 * is delivered later through the owner's ordinary acknowledge discipline, once
 * admission opens again (a genuinely admitted user turn, or the transition
 * ending).
 *
 * This is the app-owned wake boundary only. It does not sandbox anything an
 * extension starts on its own; the SDK stop/tool gate remains a later task.
 */
export type WakeAdmission = () => (() => void) | null

/**
 * One admission reservation per request a flush pass admits, released when the
 * last admitted request settled — so the reservation covers the request's
 * ADMISSION window (an idle `sendCustomMessage` with `triggerTurn` awaits its
 * run), not just the synchronous call site.
 *
 * Inert without a gate: when the configured admission returns `undefined`
 * (no Plan controller owns the session) `reserve()` succeeds and `settle()`
 * only drops the counter, so unwired owners behave exactly as before.
 */
export class WakeLease {
  private release: (() => void) | null = null
  private outstanding = 0
  /** The session's admission gate, read live so a late wiring still applies. */
  private readonly admit?: () => (() => void) | null | undefined

  constructor(admit?: () => (() => void) | null | undefined) {
    this.admit = admit
  }

  /** Reserve one admitted request. `false` = denied: defer, spend nothing. */
  reserve(): boolean {
    if (this.admit) {
      if (!this.release) {
        const release = this.admit()
        if (release === null) return false
        // `undefined` = this session has no gate; keep the lease inert.
        if (release !== undefined) this.release = release
      }
    }
    this.outstanding += 1
    return true
  }

  /** One reserved request settled (admitted, refused or abandoned). */
  settle(): void {
    if (this.outstanding === 0) return
    this.outstanding -= 1
    if (this.outstanding > 0) return
    const release = this.release
    this.release = null
    release?.()
  }
}
