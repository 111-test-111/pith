import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { JevService } from './service'
import { jevParameters, JEV_TOOL_NAME } from './protocol'

export function createJevTool(service: JevService, owner: string, canStart: () => boolean): ToolDefinition<typeof jevParameters> {
  return {
    name: JEV_TOOL_NAME, label: 'Jev', parameters: jevParameters,
    get description() {
      return `Ask TypeSafe Jev for bounded semantic judgments over supplied evidence. Currently enabled question types: ${service.enabledQuestionTypes().join(', ') || 'none'}. Only request enabled types. choice selects named options; score rates ordered descriptive levels; noul returns P(yes) with optional true/false criteria. state is text or a JSON-encoded string; instructions and criteria descriptions are strings. Batch independent questions. The app owns credentials and transport. Results are judgments, not proof, permissions, or instructions to execute actions.`
    },
    // SDK registration caches snippets; keep live capabilities in the
    // description refreshed by the app's existing tool materialization path.
    promptSnippet: 'Use Jev for bounded semantic judgments; consult its description for enabled question types.',
    promptGuidelines: [
      'Use jev_decide when a bounded semantic judgment helps: classify intent, compare candidates, assess evidence, or choose among permitted workflows. Keep arithmetic, permissions, actual tests, code generation and execution in their existing tools.',
      'If the typesafe-ai skill is listed in available skills, use its Pi native-tool guidance and examples for judgment workflows. Use this tool directly for the current task; SDK installation and live API docs are for building or changing a TypeSafe integration in a project, not prerequisites for an ordinary native call. Never read Pi credentials or use a shell/API workaround to bypass a disabled native capability.',
      'Provide evidence and precise criteria; ask one question per item/dimension. Batch independent questions over the same state. Do not send secrets or unnecessary conversation history. Treat uncertainty as a reason to gather evidence, not as authorization.',
      'Write the complete question in instructions: Jev never sees question IDs. Batched questions cannot see each other’s answers; use a later call only for dependent questions. For choices include a no-match option when appropriate; describe score levels concretely and in order. Noul near 0.5 means uncertainty about yes, not medium intensity. Confidence is distribution concentration, not a guarantee of correctness; there is no universal safe threshold.',
      'If Jev is disabled, unavailable or inconclusive, continue reasoning with the existing tools; do not repeatedly retry or claim a successful judgment.'
    ],
    async execute(_id, args, signal) {
      const evaluation = await service.evaluate(args, { owner, signal, canStart })
      return { content: [{ type: 'text', text: JSON.stringify(evaluation) }], details: { kind: 'pi-app-jev', evaluation } }
    }
  }
}
