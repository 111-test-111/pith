import { createCodemodeExtension, type ExtensionFactory, type ToolDefinition } from '@earendil-works/pi-coding-agent'

const DISCOVERY_GUIDANCE = `Discovery helpers are asynchronous. Use \`const hits = await searchTools("query", { limit: 8 });\` and \`const declaration = await describeTool("tool_name");\` before inspecting their results. \`ALL_TOOLS\` lists all callable nested tools; \`searchTools\` ranks matching entries from that list.`

const RESULT_GUIDANCE = `Result contracts: app read, bash/bash_task, browser_* and debug tools return {ok,isError,data,content,error?}. Inspect data using the discovered output schema; do not JSON.parse these objects or parse JSON from Error.message. Native mcp__* tools keep CallToolResult, including isError. SDK resource tools instead return {resources,...}, {resourceTemplates,...} or {server,uri,contents}; they reject on failure and do not have ok/isError fields. A structured failure RESOLVES, so Promise.allSettled status="fulfilled" alone is NOT success. Check isError/ok on EVERY result before using it. For dependent work you can define this local helper in your script:
async function checked(p) { const r = await p; if (r?.isError || r?.ok === false) throw new Error(r.error?.message || r.content?.filter(b => b.type === "text").map(b => b.text).join("\\n") || "Tool failed"); return r; }
Then use const r = await checked(tools.read({path:"file.txt"})). The helper is an example, not a built-in global; it also preserves resource payloads and propagates their rejections. Validation, permission and transport failures may still reject, even for a tool that also returns structured errors. Inspect every allSettled outcome, including rejected ones.
Forward images explicitly: for (const b of r.content ?? []) if (b.type === "image") image(b). Avoid text(r) for image results: that prints base64 instead of displaying the image. For read, continue with data.nextOffset or data.nextByteOffset until data.eof, passing data.version. bash output is a bounded tail; bash_task action="log" pages the retained log with a separate UTF-8 byte cursor and reports any retention truncation. A running command is pending even when the tool succeeded. Debug start/restart/stop use data.session, stack uses data.frames, registers uses data.scopes; expand scopes and any nested groups with variables. Debug sessions includes retained terminated/failed targets: inspect status before choosing a live target. Use debug wait to await a running target without sending another control action; settled describes target state and timedOut describes the wait, so both can be true.`

function withDiscoveryGuidance(description: string): string {
  const discovery = description.includes('await searchTools(') && description.includes('await describeTool(') ? '' : `${DISCOVERY_GUIDANCE}\n\n`
  // Correct the upstream shorthand without changing its native projection or
  // promising that a structured MCP business error rejects like a transport error.
  const native = description.replace('A nested tool call that fails, is blocked, or gets invalid arguments rejects with an Error carrying the tool\'s error text.',
    'Unstructured failures, blocked calls and invalid arguments reject with an Error carrying the tool\'s error text; structured error results resolve and must be checked as described above.')
  return `${discovery}${description.includes('Result contracts: app read') ? '' : `${RESULT_GUIDANCE}\n\n`}${native}`
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
