import { createCodemodeExtension, type ExtensionFactory, type ToolDefinition } from '@earendil-works/pi-coding-agent'

const DISCOVERY_GUIDANCE = `Discovery helpers are asynchronous. Use \`const hits = await searchTools("query", { limit: 8 });\` and \`const declaration = await describeTool("tool_name");\` before inspecting their results. \`ALL_TOOLS\` lists all callable nested tools; \`searchTools\` ranks matching entries from that list.`

function withDiscoveryGuidance(description: string): string {
  if (description.includes('await searchTools(') && description.includes('await describeTool(')) return description
  return `${DISCOVERY_GUIDANCE}\n\n${description}`
}

/** Keep Pi's codemode implementation while clarifying its async discovery API
 * in the dynamic model-facing description, including after a tool reload. */
export function createAppCodemodeExtension(): ExtensionFactory {
  const upstream = createCodemodeExtension()
  return (api) => upstream(new Proxy(api, {
    get(target, property) {
      if (property === 'registerTool') {
        const register = target.registerTool.bind(target)
        return ((definition: ToolDefinition) => {
          if (definition.name !== 'codemode') return register(definition)
          const prepareLoadout = definition.prepareLoadout
          return register({
            ...definition,
            description: withDiscoveryGuidance(definition.description),
            prepareLoadout: (loadout) => {
              const changes = prepareLoadout?.(loadout)
              return {
                ...changes,
                descriptions: {
                  ...changes?.descriptions,
                  codemode: withDiscoveryGuidance(changes?.descriptions?.codemode ?? definition.description)
                }
              }
            }
          })
        }) as typeof target.registerTool
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  }))
}
