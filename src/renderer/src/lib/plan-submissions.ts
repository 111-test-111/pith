import type { MessageKey } from '@/i18n/locales/en'
export function parsePlanCommand(text: string): 'toggle' | null { return text.trim() === '/plan' ? 'toggle' : null }
const errors: Record<string, MessageKey> = {
  initializing: 'plan.error.initializing', closing: 'plan.error.closing', 'child-session': 'plan.error.child',
  recovery: 'plan.error.recovery', transition: 'plan.error.transition', busy: 'plan.error.busy',
  tasks: 'plan.error.tasks', subagents: 'plan.error.subagents', deliveries: 'plan.error.deliveries',
  questions: 'plan.error.questions', escalations: 'plan.error.escalations', 'queued-messages': 'plan.error.queued',
  storage: 'plan.error.storage', 'not-plan': 'plan.error.notPlan', 'no-submission': 'plan.error.noPlan',
  'stale-submission': 'plan.error.stale', 'already-submitted': 'plan.error.submitted',
  'unsupported-version': 'plan.error.version', 'plan-command-attachments': 'plan.error.attachments'
}
export const planErrorKey = (code: string): MessageKey => errors[code] ?? 'plan.error.generic'
