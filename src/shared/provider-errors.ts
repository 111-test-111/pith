/** Serializable SDK diagnostics; provider failures retain bounded cause trees. */
export interface ProviderErrorDTO {
  name?: string
  message: string
  stack?: string
  code?: string | number
  errno?: string | number
  syscall?: string
  status?: number
  address?: string
  port?: number
  socket?: {
    localAddress?: string
    localPort?: number
    remoteAddress?: string
    remotePort?: number
    bytesWritten?: number
    bytesRead?: number
  }
  cause?: ProviderErrorDTO
  errors?: ProviderErrorDTO[]
  truncated?: boolean
}

export interface AssistantMessageDiagnosticDTO {
  type: string
  timestamp: number
  error?: ProviderErrorDTO
  details?: Record<string, unknown>
}
