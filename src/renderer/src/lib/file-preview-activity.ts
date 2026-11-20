import { createContext, useContext, useLayoutEffect, useState } from 'react'

export const FilePreviewActivity = createContext(true)
export const useFilePreviewActive = () => useContext(FilePreviewActivity)

/** Portals live outside the inert preview layer. Dismiss them during a switch. */
export function useFilePreviewPopup() {
  const active = useFilePreviewActive()
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => { if (!active && open) setOpen(false) }, [active, open])
  return { open: active && open, onOpenChange: setOpen }
}
