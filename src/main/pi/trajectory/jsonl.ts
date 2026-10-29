import { createReadStream } from 'node:fs'

const MAX_LINE = 16 * 1024 * 1024
const PREFIX_BYTES = 4096

/** Byte offsets count complete LF/CRLF records only. A partial SDK append is
 * retried on the next scan. Oversized lines preserve SDK entry ancestry from
 * their bounded metadata prefix without allocating the entire JSON string. */
export async function* trajectoryLines(path: string, start: number, end: number): AsyncGenerator<{ entry: any; offset: number }> {
  if (start >= end) return
  let parts: Buffer[] = [], bytes = 0, offset = start
  let prefix = Buffer.alloc(0), oversized = false
  const append = (part: Buffer): void => {
    if (prefix.length < PREFIX_BYTES) prefix = Buffer.concat([prefix, part.subarray(0, PREFIX_BYTES - prefix.length)])
    bytes += part.length
    if (bytes > MAX_LINE) { oversized = true; parts = [] }
    else if (!oversized) parts.push(part)
  }
  for await (const chunk of createReadStream(path, { start, end: end - 1, highWaterMark: 64 * 1024 })) {
    let from = 0
    for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10, from)) {
      append(chunk.subarray(from, at))
      offset += bytes + 1
      let entry: any = null
      try {
        if (oversized) {
          // The SDK emits envelope keys before message/content/summary bodies.
          const header = prefix.toString('utf8').split(/"(?:message|content|summary)"\s*:/, 1)[0].replace(/,\s*$/, '')
          entry = { ...JSON.parse(`${header}}`), trajectoryOmitted: true }
        } else entry = JSON.parse(Buffer.concat(parts, bytes).toString('utf8'))
      } catch { /* Malformed lines advance the offset but do not become data. */ }
      yield { entry, offset }
      parts = []; bytes = 0; prefix = Buffer.alloc(0); oversized = false
      from = at + 1
    }
    append(chunk.subarray(from))
  }
}
