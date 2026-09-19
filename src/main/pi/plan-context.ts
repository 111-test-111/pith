import type { AgentSession, InlineExtension } from '@earendil-works/pi-coding-agent'

const TYPE = 'pith_plan_context'
export function createPlanContextExtension(runtime: {
  restricted(): boolean; isChild(): boolean; toolNames(): readonly string[]
}): InlineExtension {
  const instructions = () => `Current working mode: Plan Mode. Investigate, clarify and design; implementation requires an explicit user action in the app.
Read the relevant implementation and project rules first. Ask important decisions that cannot be learned from the repository with ask_user_question, when available. Summarize evidence and tradeoffs. Follow the user's language.
Effective tools: ${runtime.toolNames().join(', ') || '(none)'}. This list and these restrictions override stale registry guidance. Never request escalation, modify local files, or cause remote API/database/network side effects. DSH only enforces local file restrictions, not network isolation. Defer conflicting skill steps (writes, installs, commits) into the future plan.
Todo tracks investigation, not implementation authorization. Wait for background tasks, questions and delivered results before finishing.
${runtime.isChild() ? 'You are a child investigator: report findings to the parent. Never submit a parent plan or delegate.' : 'Submit the complete Markdown through submit_plan alone in its tool batch. Include goals/non-goals, concrete changes and file boundaries, interfaces/data flow, errors, compatibility/migration where applicable, implementation order, tests/acceptance and assumptions, scaled to the task. Each revision replaces the full document. Submission is not approval. Stop after submitting and await the user; requests to implement in chat do not exit Plan Mode.'}`
  return { name: 'pi-app-plan-context', hidden: true, factory: pi => {
    pi.on('before_agent_start', event => runtime.restricted()
      ? { systemPrompt: `${event.systemPrompt}\n\n${instructions()}` } : undefined)
    pi.on('context', event => {
      const messages = event.messages.filter(m => !(m.role === 'custom' && m.customType === TYPE))
      if (!runtime.restricted()) return { messages }
      return { messages: [...messages, { role: 'custom', customType: TYPE, display: false,
        timestamp: Date.now(), content: instructions() }] }
    })
  } }
}

/** Covers SDK summarization as well as ordinary requests without changing their task. */
export function installPlanStreamOverlay(session: AgentSession, restricted: () => boolean): () => void {
  const previous = session.agent.streamFunction
  const overlay: typeof previous = (model, context, options) => previous(model, restricted()
    ? { ...context, systemPrompt: `${context.systemPrompt ?? ''}\n\nCurrent working mode: Plan Mode; local model tools are read-only. Preserve the current request's task, including summarization; do not implement or approve the plan.` }
    : context, options)
  session.agent.streamFunction = overlay
  return () => { if (session.agent.streamFunction === overlay) session.agent.streamFunction = previous }
}
