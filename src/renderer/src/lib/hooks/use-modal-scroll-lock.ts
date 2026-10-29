import { useEffect } from 'react'

const owners = new Set<symbol>()
let previousOverflow = ''

/** Nested beUI surfaces can close in either order, including one React commit. */
export function useModalScrollLock(open: boolean): void {
  useEffect(() => {
    if (!open) return
    const owner = Symbol()
    if (!owners.size) previousOverflow = document.body.style.overflow
    owners.add(owner)
    document.body.style.overflow = 'hidden'
    return () => {
      owners.delete(owner)
      if (!owners.size) document.body.style.overflow = previousOverflow
    }
  }, [open])
}
