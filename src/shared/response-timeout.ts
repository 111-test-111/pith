/**
 * Settings → General: how long a model request may go without an answer before
 * it is treated as failed and retried.
 *
 * The value is the Pi SDK's provider request timeout (`retry.provider.timeoutMs`
 * — "Provider/SDK request timeout"). It is applied to a session's in-memory
 * `SettingsManager` via `applyOverrides`, so the app-local preference never
 * writes the shared global pi settings file; the retry itself is the SDK's own
 * agent-level auto-retry (transient-error policy, `timeout`/`timed out` are
 * retryable), which already surfaces as the in-chat "retrying" notice.
 *
 * The SDK docs describe the deadline as: for OpenAI-family SDK clients it is
 * the wait until the first response, for Anthropic/Mistral-family clients it
 * caps the whole request, and for WebSocket providers it covers stream idleness
 * after connect.
 */

/** One minute: a request with no answer for this long is retried. */
export const RESPONSE_TIMEOUT_DEFAULT_S = 60
export const RESPONSE_TIMEOUT_MIN_S = 10
export const RESPONSE_TIMEOUT_MAX_S = 3600

/** Clamp a seconds value into the documented range; NaN falls back to the default. */
export function clampResponseTimeoutSeconds(value: number): number {
  if (!Number.isFinite(value)) return RESPONSE_TIMEOUT_DEFAULT_S
  return Math.min(RESPONSE_TIMEOUT_MAX_S, Math.max(RESPONSE_TIMEOUT_MIN_S, Math.round(value)))
}
