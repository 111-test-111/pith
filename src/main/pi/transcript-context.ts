import type { AgentSession } from '@earendil-works/pi-coding-agent'

type RequestContext = Parameters<AgentSession['agent']['streamFunction']>[1]

/** Replay the SDK's transcript system updates for request diagnostics. */
export function currentSystemPrompt(context: RequestContext): string {
  const content: string[] = []
  const sections = new Map<string, string>()
  for (const message of context.messages) {
    if (message.role !== 'system') continue
    const text = typeof message.content === 'string'
      ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (text) content.push(text)
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name)
      else sections.set(name, value)
    }
  }
  return [content.join('\n\n'), ...sections.values()].filter(Boolean).join('\n\n')
}

/** Resolve the definitions visible at the end of a transcript. */
export function currentTools(context: RequestContext): Array<{
  name: string; description: string; parameters: unknown; constrainedSampling?: unknown
}> {
  const tools = new Map<string, NonNullable<Extract<RequestContext['messages'][number], { role: 'system' }>['toolsAdded']>[number]>()
  for (const message of context.messages) {
    if (message.role !== 'system') continue
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool)
  }
  return [...tools.values()]
}
