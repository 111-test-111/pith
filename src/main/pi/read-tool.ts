import { access, open, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { Type } from 'typebox'
import { createReadToolDefinition, detectSupportedImageMimeTypeFromFile, truncateHead, DEFAULT_MAX_BYTES,
  type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { appToolError, appToolOutputSchema, appToolResult, ToolFailure } from './tool-result'
import type { ReadRangeDTO } from '../../shared/types'
import { utf8Page } from './utf8-page'

const dataSchema = Type.Object({
  kind: Type.Union([Type.Literal('text'), Type.Literal('image')]),
  text: Type.Optional(Type.String()), version: Type.String(),
  mode: Type.Union([Type.Literal('lines'), Type.Literal('bytes'), Type.Literal('image')]),
  offset: Type.Optional(Type.Number()), nextOffset: Type.Union([Type.Number(), Type.Null()]),
  byteOffset: Type.Optional(Type.Number()), nextByteOffset: Type.Union([Type.Number(), Type.Null()]),
  totalLines: Type.Optional(Type.Number()), totalBytes: Type.Number(),
  eof: Type.Boolean(), truncated: Type.Boolean()
})

/** Keep SDK path resolution, image decoding and the ordinary text view. Derive
 * completeness from the bytes read, never from the SDK's English notices. */
export function createAppReadTool(cwd: string): ToolDefinition<any, any, any> {
  const base = createReadToolDefinition(cwd)
  const parameters = Type.Object({
    path: base.parameters.properties.path,
    offset: Type.Optional(Type.Integer({ minimum: 1, description: '1-based line offset; mutually exclusive with byteOffset.' })),
    limit: Type.Optional(Type.Integer({ minimum: 1, description: 'Maximum lines in line mode.' })),
    byteOffset: Type.Optional(Type.Integer({ minimum: 0, description: 'UTF-8 byte cursor; use nextByteOffset for long single lines. Mutually exclusive with offset/limit.' })),
    maxBytes: Type.Optional(Type.Integer({ minimum: 4, maximum: DEFAULT_MAX_BYTES, description: 'Byte page size, default 51200; used with byteOffset.' })),
    version: Type.Optional(Type.String({ description: 'Pass the previous page version to reject a file changed during pagination.' }))
  })
  return {
    ...base, renderCall: undefined, renderResult: undefined,
    parameters, outputSchema: appToolOutputSchema(dataSchema),
    description: `${base.description} Scripts receive {ok,isError,data,content}. data.text excludes notices; data.eof and nextOffset/nextByteOffset describe completeness. Oversized single lines use byte pages. Pass data.version on subsequent pages; a changed file returns FILE_CHANGED. Forward image blocks from content with image(block).`,
    async execute(id, args, signal, onUpdate, context) {
      try {
        if (args.byteOffset !== undefined && (args.offset !== undefined || args.limit !== undefined)) throw new ToolFailure('INVALID_ARGUMENTS', 'byteOffset cannot be combined with offset/limit')
        if (args.maxBytes !== undefined && args.byteOffset === undefined) throw new ToolFailure('INVALID_ARGUMENTS', 'maxBytes requires byteOffset')
        let buffer!: Buffer, mime: string | null | undefined, version = '', totalBytes = 0
        const signature = (s: Awaited<ReturnType<typeof stat>>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
        const result = await createReadToolDefinition(cwd, { operations: {
          access: path => access(path, constants.R_OK),
          detectImageMimeType: async path => {
            mime = await detectSupportedImageMimeTypeFromFile(path)
            if (mime && args.byteOffset !== undefined) throw new ToolFailure('INVALID_ARGUMENTS', 'Images do not support byte pagination; omit byteOffset')
            return mime
          },
          readFile: async path => {
            const file = await open(path, 'r')
            try {
              const before = await file.stat()
              if (!before.isFile()) throw new ToolFailure('NOT_A_FILE', 'read requires a regular file')
              version = signature(before); totalBytes = before.size
              if (args.version !== undefined && args.version !== version) throw new ToolFailure('FILE_CHANGED', 'File changed since the previous page; restart pagination')
              if (args.byteOffset === undefined) buffer = await file.readFile({ signal })
              else {
                if (args.byteOffset > totalBytes) throw new ToolFailure('INVALID_BYTE_CURSOR', 'byteOffset is beyond the end of the file')
                const bytes = Buffer.alloc(Math.min((args.maxBytes ?? DEFAULT_MAX_BYTES) + 4, totalBytes - args.byteOffset))
                const { bytesRead } = await file.read(bytes, 0, bytes.length, args.byteOffset)
                buffer = utf8Page(bytes.subarray(0, bytesRead), args.maxBytes ?? DEFAULT_MAX_BYTES)
              }
              if (signature(await file.stat()) !== version) throw new ToolFailure('FILE_CHANGED', 'File changed while reading; retry from the beginning')
              return buffer
            } finally { await file.close() }
          }
        } }).execute(id, { path: args.path, offset: args.offset, limit: args.limit }, signal, onUpdate, context)
        if (mime) return appToolResult(result, { kind: 'image', mode: 'image', version, totalBytes, nextOffset: null, nextByteOffset: null, eof: true, truncated: false })
        const allLines = buffer.toString('utf8').split('\n')
        const start = (args.offset ?? 1) - 1
        const selected = allLines.slice(start, args.limit === undefined ? undefined : start + args.limit).join('\n')
        const truncation = truncateHead(selected)
        if (args.byteOffset !== undefined || truncation.firstLineExceedsLimit) {
          const byteOffset = args.byteOffset ?? Buffer.byteLength(allLines.slice(0, start).join('\n') + (start ? '\n' : ''))
          const bytes = args.byteOffset !== undefined ? buffer : utf8Page(buffer.subarray(byteOffset), DEFAULT_MAX_BYTES)
          const next = byteOffset + bytes.length
          const eof = next === totalBytes
          const text = bytes.toString('utf8')
          const note = eof ? '' : `\n\n[Partial file. Continue with byteOffset=${next} and version=${version}.]`
          return appToolResult({ content: [{ type: 'text', text: text + note }], details: result.details }, {
            kind: 'text', mode: 'bytes', text, version, byteOffset, totalBytes, nextOffset: null,
            nextByteOffset: eof ? null : next, eof, truncated: !eof
          })
        }
        const next = start + (truncation.content === '' && !truncation.truncated ? 1 : truncation.outputLines) + 1
        const eof = next > allLines.length
        const range: ReadRangeDTO = { offset: start + 1, endLine: Math.min(next - 1, allLines.length), totalLines: allLines.length }
        return appToolResult({ ...result, details: { ...result.details, piAppRead: range } }, { kind: 'text', mode: 'lines', text: truncation.content, version,
          offset: range.offset, totalLines: range.totalLines, totalBytes, nextOffset: eof ? null : next,
          nextByteOffset: null, eof, truncated: !eof })
      } catch (error) { return appToolError(error) }
    }
  } satisfies ToolDefinition<typeof parameters, any>
}
