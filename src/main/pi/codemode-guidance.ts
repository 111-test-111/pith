import { createCodemodeExtension, type ExtensionFactory, type ToolDefinition } from '@earendil-works/pi-coding-agent'

const DISCOVERY_GUIDANCE = `Nested-tool contracts are discovered on demand: use \`await searchTools("query", {limit:4})\` to find a few candidates, \`await describeTool("tool_name")\` for the full input/output declaration (a string), and \`await describeNamespace("namespace")\` for server instructions. Await discovery before inspecting ALL_TOOLS while MCP connects in the background. Inspect unfamiliar contracts before calls or reading output fields; avoid printing the full catalog or bulk declarations. Test presence with \`"name" in tools\` or \`"name" in models\`; accessing a missing member throws.`

const RESULT_GUIDANCE = `Result contracts: app read, bash/bash_task, browser_* and debug return {ok,isError,data,content,error?}; native mcp__* returns CallToolResult. Check every resolved result for isError/ok===false and every rejection: fulfilled alone is not success. SDK resource helpers return direct payloads and reject on failure, without ok/isError. Use discovered output schemas; never JSON.parse objects or Error.message.
models.classify()/generateImages() succeed with stopReason==='stop'; resolved provider failures carry errorMessage. Generated image blocks are in result.output.
Forward image blocks with image(block); text(result) dumps base64. Page read via data.nextOffset/nextByteOffset with data.version until eof; bash_task log uses UTF-8 byte cursors, separate from the output tail. Running commands remain pending. For debug recipes use help with topic=action; wait observes without repeating control.`

function withDiscoveryGuidance(description: string): string {
  // Pi 1.0 owns the compact runtime text and its model/image API references.
  // Keep it verbatim; append only the app's discovery and result contracts.
  const discovery = description.includes(DISCOVERY_GUIDANCE) ? '' : `${DISCOVERY_GUIDANCE}\n\n`
  return `${discovery}${description.includes('Result contracts: app read') ? '' : `${RESULT_GUIDANCE}\n\n`}${description}`
}

/** Keep complete contracts in Pi's callable registry for on-demand discovery.
 * Direct tools already declare their parameters as JSON Schema; repeating the
 * generated input/output TypeScript in each description inflates every request. */
export function createAppCodemodeExtension(): ExtensionFactory {
  const upstream = createCodemodeExtension({ inlineBudget: 0 })
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
