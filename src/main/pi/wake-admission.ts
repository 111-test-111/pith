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
 * Ask the app for ONE request's admission.
 *
 * Returns a request-local, idempotent release that the caller must invoke when
 * that request is settled (sent, skipped, refused synchronously or abandoned),
 * or `null` when the wake must be deferred. Every delivery asks again right
 * before its own wake/steer side effect: a sibling's still-pending request must
 * never carry a later one across a seal or a transition that closed in between,
 * and no request may release another request's admission.
 *
 * With no gate configured (a session that owns no Plan controller) it returns
 * an inert release, so unwired owners behave exactly as before.
 */
export function admitWakeRequest(admit?: WakeAdmission): (() => void) | null {
  if (!admit) return () => {}
  const release = admit()
  if (!release) return null
  let released = false
  return () => {
    if (released) return
    released = true
    release()
  }
}
