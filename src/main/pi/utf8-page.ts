import { ToolFailure } from './tool-result'

/** The caller reads up to limit + 4 bytes. Cursors always land between UTF-8
 * code points, so concatenating pages reproduces the original text. */
export function utf8Page(bytes: Buffer, limit: number): Buffer {
  if (bytes.length && (bytes[0]! & 0xc0) === 0x80) throw new ToolFailure('INVALID_BYTE_CURSOR', 'Byte cursor is inside a UTF-8 character; use the returned nextByteOffset.')
  let end = Math.min(limit, bytes.length)
  while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return bytes.subarray(0, end)
}
