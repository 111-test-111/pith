import { ToolApproval } from '@/components/agents/tool-approval'
import { AgentCode } from '@/components/agents/agent-code'
import { FileShield } from '@/lib/icons'
import { useI18n } from '@/i18n'
import type { MessageKey } from '@/i18n/locales/en'
import type { SandboxEscalationDecision, SandboxEscalationRequestDTO, SandboxMode } from '../../../../shared/types'
import { FadeScroll } from './FadeScroll'

const MODE_LABEL: Record<SandboxMode, MessageKey> = {
  'read-only': 'sandbox.readOnly',
  'workspace-write': 'sandbox.workspaceWrite',
  'danger-full-access': 'sandbox.fullAccess'
}

const PARAMETER_LABEL: Record<string, MessageKey> = {
  command: 'sandbox.escalationCommand',
  path: 'sandbox.escalationPath',
  content: 'sandbox.escalationContent',
  edits: 'sandbox.escalationEdits'
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
  const parameters = Object.entries(request.operation.parameters)
    .filter(([name]) => name !== 'sandbox_permissions' && name !== 'justification')
  return (
    <div data-sandbox-escalation={request.requestId} className="mb-2 w-full min-w-0">
      <ToolApproval
        collapsible={false}
        icon={<FileShield aria-hidden="true" className="size-4" />}
        iconClassName="size-4 border-0 bg-transparent"
        title={(
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate">{t('sandbox.escalationTitle')}</span>
            <span className="truncate font-mono text-xs font-normal text-muted-foreground">{request.toolName}</span>
          </span>
        )}
        description={t('sandbox.escalationBody', {
          from: t(MODE_LABEL[request.currentMode]),
          to: t(MODE_LABEL[request.requestedMode])
        })}
        labels={{
          status: t('sandbox.escalationRequired'),
          approve: t('sandbox.escalationApprove'),
          deny: t('sandbox.escalationDeny')
        }}
        onApprove={() => onAnswer('approve')}
        onDeny={() => onAnswer('deny')}
      >
        <FadeScroll
          tabIndex={0}
          aria-label={t('sandbox.escalationDetails')}
          className="mx-4 mb-4 max-h-[min(20rem,40vh,max(6rem,calc(100dvh-26rem)))] rounded-control border border-border/50 bg-background/70 p-3"
        >
          <dl className="grid gap-3 text-xs">
            {parameters.map(([name, value]) => (
              <div key={name} className="grid grid-cols-[minmax(0,5rem)_minmax(0,1fr)] items-start gap-3">
                <dt className="text-muted-foreground">{PARAMETER_LABEL[name] ? t(PARAMETER_LABEL[name]) : name}</dt>
                <dd className="min-w-0" data-sandbox-operation-parameter={name}>
                  <AgentCode
                    code={typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value)}
                    language={name === 'command' ? 'bash' : 'text'}
                    highlight={name === 'command'}
                    className="overflow-x-visible whitespace-pre-wrap [overflow-wrap:anywhere] text-xs"
                  />
                </dd>
              </div>
            ))}
            {[
              { id: 'cwd', label: t('sandbox.escalationDirectory'), value: request.operation.cwd },
              { id: 'reason', label: t('sandbox.escalationReason'), value: request.justification },
              { id: 'scope', label: t('sandbox.escalationScope'), value: t('sandbox.escalationOnce') }
            ].map(({ id, label, value }) => (
              <div key={id} className="grid grid-cols-[minmax(0,5rem)_minmax(0,1fr)] items-start gap-3">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/85">{value}</dd>
              </div>
            ))}
          </dl>
        </FadeScroll>
      </ToolApproval>
    </div>
  )
}
