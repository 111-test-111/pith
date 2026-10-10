import type { SessionManager } from '@earendil-works/pi-coding-agent'

/** SDK initialization treats a pre-message goal/Plan branch as a new session
 * and appends its initial selection again. Identical metadata must not move a
 * reviewed/checkpoint leaf on reopen. Scope these public-method adapters to
 * construction; intentional later picker changes still append normally. */
export async function preserveInitialSelections<T>(manager: SessionManager, construct: () => Promise<T>): Promise<T> {
  const model = manager.appendModelChange, thinking = manager.appendThinkingLevelChange
  const appendModel: typeof model = (provider, modelId) => {
    const previous = manager.getBranch().findLast(entry => entry.type === 'model_change')
    return previous?.type === 'model_change' && previous.provider === provider && previous.modelId === modelId ? previous.id : model.call(manager, provider, modelId)
  }
  const appendThinking: typeof thinking = level => {
    const previous = manager.getBranch().findLast(entry => entry.type === 'thinking_level_change')
    return previous?.type === 'thinking_level_change' && previous.thinkingLevel === level ? previous.id : thinking.call(manager, level)
  }
  manager.appendModelChange = appendModel
  manager.appendThinkingLevelChange = appendThinking
  try { return await construct() }
  finally {
    if (manager.appendModelChange === appendModel) manager.appendModelChange = model
    if (manager.appendThinkingLevelChange === appendThinking) manager.appendThinkingLevelChange = thinking
  }
}
