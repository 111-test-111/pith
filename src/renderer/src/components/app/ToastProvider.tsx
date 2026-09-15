import { createContext, useContext, useMemo, type ReactNode } from 'react'
import {
  AnimatedToastStack,
  useAnimatedToastStack,
  type ToastStatus
} from '@/components/motion/animated-toast-stack'

/**
 * App-level transient feedback. The stack itself is beUI's vendored
 * AnimatedToastStack; this module only owns the shared instance and the
 * shorthand callers use.
 *
 * Prose stays at the call site (`t(...)`) — the stack takes rendered nodes, and
 * the main process never sends user-visible strings.
 */
export type ToastMessage = {
  title: ReactNode
  description?: ReactNode
  status?: ToastStatus
  /** Milliseconds; `0` keeps the toast until it is dismissed. */
  duration?: number
  action?: { label: ReactNode; onClick: () => void }
}

export type ToastApi = {
  show: (message: ToastMessage) => string
  success: (message: Omit<ToastMessage, 'status'>) => string
  error: (message: Omit<ToastMessage, 'status'>) => string
  info: (message: Omit<ToastMessage, 'status'>) => string
  dismiss: (id: string) => void
}

/** A failure is worth reading twice; a success is worth noticing once. */
const ERROR_DURATION_MS = 6000
const SUCCESS_DURATION_MS = 3200
const INFO_DURATION_MS = 4200

/** Stable handle for the app's one toast region (floating, so it portals). */
const TOAST_REGION_CLASS = 'app-toast-region'

/**
 * Isolated mounts (a check fixture rendering one pane, a preview playground)
 * may sit outside the provider: report nothing instead of throwing, so a
 * missing wrapper degrades to silence rather than a blank screen.
 */
const NO_PROVIDER: ToastApi = {
  show: () => '',
  success: () => '',
  error: () => '',
  info: () => '',
  dismiss: () => {}
}

const ToastContext = createContext<ToastApi>(NO_PROVIDER)

export function useToast(): ToastApi {
  return useContext(ToastContext)
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { toasts, showToast, dismissToast } = useAnimatedToastStack()

  const api = useMemo<ToastApi>(
    () => ({
      show: (message) => showToast(message),
      success: (message) => showToast({ ...message, status: 'success', duration: message.duration ?? SUCCESS_DURATION_MS }),
      error: (message) => showToast({ ...message, status: 'error', duration: message.duration ?? ERROR_DURATION_MS }),
      info: (message) => showToast({ ...message, status: 'info', duration: message.duration ?? INFO_DURATION_MS }),
      dismiss: (id) => dismissToast(id)
    }),
    [showToast, dismissToast]
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Fixed + portal: transient feedback must survive any transformed or
          clipping ancestor, exactly like the app's other overlays. */}
      <AnimatedToastStack
        toasts={toasts}
        onDismiss={dismissToast}
        position="bottom-right"
        fixed
        maxVisible={3}
        classNames={{ root: TOAST_REGION_CLASS }}
      />
    </ToastContext.Provider>
  )
}
