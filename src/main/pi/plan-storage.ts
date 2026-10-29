import { openSync, fsyncSync, closeSync } from 'node:fs'
import type { SessionManager } from '@earendil-works/pi-coding-agent'

export class PlanStorage {
  failed = false
  constructor(private manager: SessionManager) {
    // SDK appendMessage mutates memory before its filesystem write. An error
    // happens before later awaited subscribers, so latch it at this public
    // persistence boundary as well as at our own append/fsync boundary.
    const append = manager.appendMessage.bind(manager)
    manager.appendMessage = (...args) => {
      if (this.failed) throw new Error('plan-storage-locked')
      try { return append(...args) }
      catch (error) { this.failed = true; throw error }
    }
  }
  append(customType: string, data: unknown): string {
    if (this.failed) throw new Error('plan-storage-locked')
    try {
      const id = this.manager.appendCustomEntry(customType, data)
      this.sync()
      return id
    } catch (error) {
      this.failed = true
      throw error
    }
  }
  sync(): void {
    if (this.failed) throw new Error('plan-storage-locked')
    const path = this.manager.getSessionFile()
    if (!path) {
      this.failed = true
      throw new Error('plan-session-not-persisted')
    }
    try {
      const fd = openSync(path, 'r+')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      this.failed = true
      throw error
    }
  }
}
