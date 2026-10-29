/** Deterministic recording sources. Every command remains keyless and offline. */
import { providerReplayContext } from './session-replay.mjs'
const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
const usage = { input: 17, output: 9, cacheRead: 3, cacheWrite: 0, totalTokens: 29, cost: zeroCost }
const text = value => ({ type: 'text', text: value })
const tool = (name, args) => ({ type: 'toolCall', id: `recorded-${name}`, name, arguments: args })

export const replayScenarios = [
  {
    id: 'ordinary-turn', description: 'A streamed answer followed by a second user turn retains prior assistant context.',
    tools: [], prompts: ['Reply with a short greeting.', 'Now say goodbye.'],
    replies: [[text('Hello from replay.')], [text('Goodbye from replay.')]]
  },
  {
    id: 'read-write-present', description: 'Real read → write → present tools produce persisted results and an explicit delivery.',
    tools: ['read', 'write', 'present'], prompts: ['Read input.txt, write report.md, then present the report.'],
    files: [{ path: 'input.txt', content: 'Revenue: 42\n成本：17\n' }], outputFiles: ['report.md'],
    replies: [
      [tool('read', { path: 'input.txt' })],
      [tool('write', { path: 'report.md', content: '# Report\nRevenue: 42\n成本：17\n' })],
      [tool('present', { files: [{ path: 'report.md', description: 'Checked revenue report' }] })],
      [text('The report is ready.')]
    ]
  },
  {
    id: 'failed-present', description: 'A directory cannot become a deliverable; SDK tool failure persists and reaches the next request.',
    tools: ['present'], prompts: ['Present the output directory.'], files: [{ path: 'output', directory: true }],
    replies: [[tool('present', { files: [{ path: 'output' }] })], [text('The output is a directory, so it cannot be delivered as a file.')]]
  },
  {
    id: 'provider-retry', description: 'Two transient provider errors trigger the real SDK retry path and a third successful request.',
    tools: [], prompts: ['Answer after transient provider failures.'], retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
    replies: [{ error: '503 Service Unavailable (synthetic regression fixture 1)' }, { error: '503 Service Unavailable (synthetic regression fixture 2)' }, [text('Recovered after retries.')]]
  },
  {
    id: 'cancelled-stream', description: 'The driver aborts the SDK after actual partial text; replay waits for that same abort signal.',
    tools: [], prompts: ['Start a long answer, which I will cancel.'], cancelAfterTextDelta: true,
    replies: [{ cancel: true, content: [text('Partial answer before cancellation.')] }]
  },
  {
    id: 'cancelled-retry', description: 'The driver aborts real SDK retry backoff; no next provider call may start.',
    tools: [], prompts: ['Attempt an answer; I will cancel retry backoff.'], cancelDuringRetry: true,
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 100 },
    replies: [{ error: '503 Service Unavailable (synthetic cancellation fixture)' }]
  }
]

export function recordingScenario(id) {
  const scenario = replayScenarios.find(value => value.id === id)
  if (!scenario) throw new Error(`Unknown replay scenario: ${id}`)
  return scenario
}

export function scenarioContract(scenario) {
  const { replies, ...contract } = scenario
  return contract
}

/** SDK-shaped stream grammar; retained chunks are recorded from actual
 * consumption, not manufactured later from settled UI rows. */
export function syntheticProvider(scenario) {
  let cursor = 0
  let time = 1_600_000_000_000
  return (model, context, options) => {
    const script = scenario.replies[cursor++]
    if (!script) throw new Error(`Synthetic provider exhausted in ${scenario.id}`)
    const content = Array.isArray(script) ? script : script.content ?? []
    const message = { role: 'assistant', content: structuredClone(content), provider: model.provider, model: model.id, api: model.api,
      timestamp: ++time, stopReason: script.cancel ? 'aborted' : script.error ? 'error' : content.some(value => value.type === 'toolCall') ? 'toolUse' : 'stop',
      usage: structuredClone(usage), ...(script.error ? { errorMessage: script.error } : {}), ...(script.cancel ? { errorMessage: 'Request cancelled' } : {}) }
    return {
      async *[Symbol.asyncIterator]() {
        await options?.onPayload?.({ model: model.id, messages: providerReplayContext(context).messages, authorization: 'synthetic-secret-never-use' }, model)
        await options?.onResponse?.({ status: script.error ? 503 : 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'synthetic-request', authorization: 'synthetic-secret-never-use' } }, model)
        let partial = { ...structuredClone(message), content: [], stopReason: 'pending' }
        yield { type: 'start', partial }
        for (const [contentIndex, block] of content.entries()) {
          const toolCall = block.type === 'toolCall'
          partial = { ...partial, content: [...partial.content, toolCall ? { ...structuredClone(block), arguments: {} } : text('')] }
          yield { type: toolCall ? 'toolcall_start' : 'text_start', contentIndex, partial }
          const source = toolCall ? JSON.stringify(block.arguments) : block.text
          // Two actual deltas exercise incremental processing, including CJK.
          const split = Math.max(1, Math.floor(source.length / 2))
          for (const delta of [source.slice(0, split), source.slice(split)].filter(Boolean)) {
            partial = { ...partial, content: partial.content.map((value, index) => index !== contentIndex ? value : toolCall ? structuredClone(block) : text(value.text + delta)) }
            yield { type: toolCall ? 'toolcall_delta' : 'text_delta', contentIndex, delta, partial }
            if (script.cancel) {
              if (!options.signal.aborted) await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
              message.content = structuredClone(partial.content)
              yield { type: 'error', reason: 'aborted', error: message }
              return
            }
          }
          yield toolCall ? { type: 'toolcall_end', contentIndex, toolCall: block, partial } : { type: 'text_end', contentIndex, content: block.text, partial }
        }
        if (script.error) yield { type: 'error', reason: 'error', error: message }
        else yield { type: 'done', reason: message.stopReason, message }
      },
      async result() { return message }
    }
  }
}
