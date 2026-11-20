import type { AssistantMessageDiagnosticDTO } from '../../shared/provider-errors'

export function providerErrorDiagnostic(error: unknown): AssistantMessageDiagnosticDTO
export function appendProviderErrorDiagnostic(
  message: { diagnostics?: AssistantMessageDiagnosticDTO[] }, error: unknown
): void
