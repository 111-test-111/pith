import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { ChatMessage, SubagentWrittenFileDTO } from '../../../shared/types'
import { SubagentError } from './errors.ts'
import { IMAGE_TOOL_NAME, parseImageToolResult } from '../../../shared/image.ts'

/**
 * Pure derivation helpers for subagent runs — no Electron, no manager imports,
 * so the persistence/derivation contract can be checked with plain node
 * (scripts/check-subagents.mjs).
 */

const MAX_SUBAGENT_INPUT_FILES = 8
const MAX_SUBAGENT_INPUT_BYTES = 512 * 1024
export const SUBAGENT_CONTEXT_LIMIT = 50_000
export const MAX_SUBAGENT_WRITTEN_PATCH_BYTES = 64 * 1024

/** Load and validate input files: realpath-confined to the session cwd, at
 * most 8 regular files, 512 KiB total, strictly UTF-8. Throws a
 * {@link SubagentError} the tool renders to the model verbatim. */
export function loadSubagentInputFiles(paths: readonly string[] | undefined, cwd: string): string {
  if (!paths?.length) return ''
  // Resolve the workspace root the same way the files are: on macOS `/var`
  // symlinks to `/private/var`, so comparing a literal cwd against
  // realpath-resolved files would classify EVERY file as outside.
  const root = realpathSync(cwd)
  const resolved: Array<{ rel: string; text: string }> = []
  let total = 0
  const seen = new Set<string>()
  for (const raw of paths.slice(0, MAX_SUBAGENT_INPUT_FILES)) {
    const path = isAbsolute(raw) ? raw : resolve(cwd, raw)
    let real: string
    try {
      real = realpathSync(path)
    } catch {
      throw new SubagentError(`Input file not found: ${raw}`)
    }
    const rel = relative(root, real)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new SubagentError(`Input file is outside the workspace: ${raw}`)
    if (seen.has(real)) continue
    seen.add(real)
    const info = existsSync(real) ? statSync(real) : null
    if (!info?.isFile()) throw new SubagentError(`Input path is not a regular file: ${raw}`)
    if (info.size + total > MAX_SUBAGENT_INPUT_BYTES) throw new SubagentError('Input files exceed the 512 KiB subagent budget')
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(real))
    } catch {
      throw new SubagentError(`Input file is not valid UTF-8 text: ${raw}`)
    }
    total += info.size
    resolved.push({ rel, text })
  }
  if (!resolved.length) return ''
  return `\n\n<documents>\n${resolved.map((file) => `<document path="${file.rel}">\n${file.text}\n</document>`).join('\n')}\n</documents>`
}

function trimForContext(message: ChatMessage): unknown {
  const compact: Record<string, unknown> = { role: message.role }
  const content = (message as any).content
  if (typeof content === 'string') compact.content = content
  else if (Array.isArray(content)) {
    // Image payloads never ride the inherited context.
    compact.content = content
      .filter((part: any) => part?.type !== 'image')
      .map((part: any) => part?.type === 'text' ? { type: 'text', text: part.text?.slice(0, 20_000) } : part)
  }
  return compact
}

/**
 * Parent context for inheritance: the parent's live messages, JSON-encoded
 * and hard-capped. Trimming drops WHOLE MESSAGES from the front (oldest
 * first, a quarter of the list per step so the re-encode stays cheap) and
 * says so in a preamble — the JSON itself stays valid and the newest task
 * state always survives. A single message larger than the whole budget (many
 * capped parts) falls back to a hard slice of its tail.
 */
export function parentContextText(messages: readonly ChatMessage[]): string | undefined {
  let kept = messages.map(trimForContext)
  let encoded: string
  try {
    encoded = JSON.stringify(kept)
  } catch {
    return undefined
  }
  let dropped = 0
  while (encoded.length > SUBAGENT_CONTEXT_LIMIT && kept.length > 1) {
    const remove = Math.max(1, Math.ceil(kept.length / 4))
    dropped += remove
    kept = kept.slice(remove)
    try {
      encoded = JSON.stringify(kept)
    } catch {
      return undefined
    }
  }
  if (encoded.length <= SUBAGENT_CONTEXT_LIMIT) {
    return dropped > 0
      ? `[parent context truncated: ${dropped} older message${dropped === 1 ? '' : 's'} dropped]\n${encoded}`
      : encoded
  }
  return `${encoded.slice(encoded.length - SUBAGENT_CONTEXT_LIMIT)}\n…[parent context truncated at ${SUBAGENT_CONTEXT_LIMIT} characters]`
}

/** Count +/- lines of a unified patch, header lines excluded. */
export function countPatchLines(patch: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

export function synthesizeWritePatch(displayPath: string, content: string): string {
  const lines = content.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return `--- /dev/null\n+++ b/${displayPath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`
}

/**
 * Extract the files a child session wrote, from committed `edit`/`write`/`image`
 * receipts only (reply prose is never a source). Same-file calls merge; total
 * patch bytes are capped, keeping counts but dropping patches beyond budget.
 */
export function extractSubagentWrittenFiles(messages: readonly ChatMessage[], cwd: string): SubagentWrittenFileDTO[] {
  const calls = new Map<string, { name: string; args: any }>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.content) {
      if (part.type === 'toolCall') calls.set(part.id, { name: part.name, args: part.arguments })
    }
  }
  const byPath = new Map<string, SubagentWrittenFileDTO>()
  let patchBudget = MAX_SUBAGENT_WRITTEN_PATCH_BYTES
  for (const message of messages) {
    if (message.role !== 'toolResult') continue
    if (message.toolName === IMAGE_TOOL_NAME && calls.get(message.toolCallId)?.name === IMAGE_TOOL_NAME) {
      for (const file of parseImageToolResult(message.details)?.files ?? []) {
        const rel = relative(cwd, file.path)
        if (!byPath.has(file.path)) byPath.set(file.path, { filePath: file.path,
          displayPath: rel.startsWith('..') || isAbsolute(rel) ? file.path : rel, kind: 'generated-image' })
      }
      continue
    }
    if (message.isError) continue
    if (message.toolName !== 'edit' && message.toolName !== 'write') continue
    const call = calls.get(message.toolCallId)
    if (!call) continue
    const rawPath = call.args?.path ?? call.args?.file_path
    if (typeof rawPath !== 'string' || !rawPath) continue
    const filePath = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath)
    const rel = relative(cwd, filePath)
    const displayPath = rel.startsWith('..') || isAbsolute(rel) ? filePath : rel
    let patch: string | null = null
    if (message.toolName === 'edit') {
      const reported = (message.details as { patch?: unknown } | undefined)?.patch
      if (typeof reported === 'string' && reported.length > 0) patch = reported
    } else if (typeof call.args?.content === 'string') {
      patch = synthesizeWritePatch(displayPath, call.args.content)
    }
    const counts = patch ? countPatchLines(patch) : { added: undefined as number | undefined, removed: undefined as number | undefined }
    const existing = byPath.get(filePath)
    if (!existing) {
      byPath.set(filePath, {
        filePath,
        displayPath,
        ...(counts.added !== undefined ? { added: counts.added } : {}),
        ...(counts.removed !== undefined ? { removed: counts.removed } : {}),
        ...(patch && patch.length <= patchBudget ? { patch } : {})
      })
      if (patch) patchBudget -= patch.length
    } else {
      // A real text edit/write on the same path still belongs in code review.
      delete existing.kind
      existing.added = (existing.added ?? 0) + (counts.added ?? 0)
      existing.removed = (existing.removed ?? 0) + (counts.removed ?? 0)
      if (patch && patch.length <= patchBudget) {
        existing.patch = existing.patch ? `${existing.patch}\n${patch}` : patch
        patchBudget -= patch.length
      }
    }
  }
  return [...byPath.values()]
}
