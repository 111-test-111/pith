import type { AgentSession } from '@earendil-works/pi-coding-agent'

type RequestContext = Parameters<AgentSession['agent']['streamFunction']>[1]
type SystemMessage = Extract<RequestContext['messages'][number], { role: 'system' }>

/** Same replay semantics as the SDK: append content, patch/delete sections,
 * remove tools before adding/replacing definitions. Historical patches are not
 * additional prompt/schema content. Accepts both persisted and request lists. */
export function currentSystemMessage(messages: readonly any[]): SystemMessage | undefined {
  const content: string[] = []
  const sections = new Map<string, string>()
  const tools = new Map<string, NonNullable<SystemMessage['toolsAdded']>[number]>()
  let timestamp: number | undefined
  for (const message of messages) {
    if (message?.role !== 'system') continue
    timestamp ??= message.timestamp ?? 0
    const text = typeof message.content === 'string' ? message.content
      : (message.content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')
    if (text) content.push(text)
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name)
      else if (typeof value === 'string') sections.set(name, value)
    }
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool)
  }
  if (timestamp === undefined) return undefined
  return { role: 'system', content: content.join('\n\n'), timestamp,
    ...(sections.size ? { sections: Object.fromEntries(sections) } : {}),
    ...(tools.size ? { toolsAdded: [...tools.values()] } : {}) }
}

/** Replay the SDK's transcript system updates for request diagnostics. */
export function currentSystemPrompt(context: RequestContext): string {
  const system = currentSystemMessage(context.messages)
  return system ? [system.content, ...Object.values(system.sections ?? {})].filter(Boolean).join('\n\n') : ''
}

/** Resolve the definitions visible at the end of a transcript. */
export function currentTools(context: RequestContext): Array<{
  name: string; description: string; parameters: unknown; constrainedSampling?: unknown
}> {
  return currentSystemMessage(context.messages)?.toolsAdded ?? []
}
