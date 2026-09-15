import { ToolApproval } from '@/components/agents/tool-approval'
import { ShieldCheck } from '@/lib/icons'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import type { SandboxEscalationDecision, SandboxEscalationRequestDTO, SandboxMode } from '../../../../shared/types'

const MODE_LABEL: Record<SandboxMode, MessageKey> = {
  'read-only': 'sandbox.readOnly',
  'workspace-write': 'sandbox.workspaceWrite',
  'danger-full-access': 'sandbox.fullAccess'
}

/**
 * One pending escalation: a model-written tool call wants a strictly wider
 * sandbox mode for that call alone, and only the user can say yes.
 *
 * The surface is beUI's ToolApproval. There is deliberately no "always allow":
 * DSH's escalation is one call at a time, so a standing grant is not something
 * this app can offer — the session's mode is a separate, explicit choice in the
 * composer.
 */
export function SandboxEscalationPanel({
  request,
  onAnswer
}: {
  request: SandboxEscalationRequestDTO
  onAnswer: (decision: SandboxEscalationDecision) => void
}) {
  const { t } = useI18n()
  return (
    <div data-sandbox-escalation={request.requestId} className="px-4 pb-2">
      <ToolApproval
        defaultOpen
        tool={
          <span className="flex items-center gap-1.5">
            <ShieldCheck aria-hidden="true" className="size-3.5" />
            {request.toolName}
          </span>
        }
        title={t('sandbox.escalationTitle')}
        description={t('sandbox.escalationBody', {
          from: t(MODE_LABEL[request.currentMode]),
          to: t(MODE_LABEL[request.requestedMode])
        })}
        parameters={[
          { id: 'reason', label: t('sandbox.escalationReason'), value: request.justification },
          { id: 'scope', label: t('sandbox.escalationScope'), value: t('sandbox.escalationOnce') }
        ]}
        onApprove={() => onAnswer('approve')}
        onDeny={() => onAnswer('deny')}
      />
    </div>
  )
}
