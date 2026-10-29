import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Viewer/editor backend for ~/.pi/agent/APPEND_SYSTEM.md — the file the Pi
 * SDK's resource loader appends to the system prompt of every session (the
 * project-local `.pi/APPEND_SYSTEM.md` is its trusted-project counterpart and
 * is deliberately not edited here). The SDK only READS the file; edits are
 * written directly and the live sessions are reloaded by the caller so the
 * next turn picks them up.
 */

export function appendPromptPath(): string {
  return join(getAgentDir(), 'APPEND_SYSTEM.md')
}

export function readAppendPrompt(): string {
  const path = appendPromptPath()
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

export function writeAppendPrompt(text: string): void {
  const path = appendPromptPath()
  // An empty prompt means "no append": remove the file so the SDK stops
  // treating it as a resource (and `getAppendSystemPromptSources` stays clean).
  if (text.trim().length === 0) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}
