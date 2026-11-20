/** An app-local override; null uses the session's current model. */
export interface SessionNamingModelSelection { providerId: string; modelId: string }

export function normalizeSessionNamingModel(value: unknown): SessionNamingModelSelection | null {
  if (!value || typeof value !== 'object') return null
  const model = value as SessionNamingModelSelection
  return typeof model.providerId === 'string' && !!model.providerId.trim() && model.providerId.length <= 256 &&
    typeof model.modelId === 'string' && !!model.modelId.trim() && model.modelId.length <= 512
    ? { providerId: model.providerId.trim(), modelId: model.modelId.trim() } : null
}
