/** Bounded header inspection for layout metadata, never an image transform.
 * Unrecognized/truncated formats keep the gallery's fixed fallback frame. */
export function libraryImageDimensions(bytes: Buffer, extension = ''): { imageWidth: number; imageHeight: number } | undefined {
  const dimensions = (width: number, height: number) => Number.isSafeInteger(width) && Number.isSafeInteger(height)
    && width > 0 && height > 0 && width <= 1_000_000 && height <= 1_000_000 ? { imageWidth: width, imageHeight: height } : undefined
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return dimensions(bytes.readUInt16LE(6), bytes.readUInt16LE(8))
  if (bytes.length >= 26 && bytes.subarray(0, 2).toString('ascii') === 'BM') return dimensions(Math.abs(bytes.readInt32LE(18)), Math.abs(bytes.readInt32LE(22)))
  if (bytes.length >= 30 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    const type = bytes.subarray(12, 16).toString('ascii')
    if (type === 'VP8X') return dimensions(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1)
    if (type === 'VP8 ' && bytes.subarray(23, 26).equals(Buffer.from([157,1,42]))) return dimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
    if (type === 'VP8L' && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21)
      return dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
    }
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break
      while (bytes[offset] === 255) offset++
      const marker = bytes[offset++]
      if (marker === 217 || marker === 218) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      if (offset + 2 > bytes.length) break
      const length = bytes.readUInt16BE(offset)
      if (length < 2 || offset + length > bytes.length) break
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 7) return dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))
      offset += length
    }
  }
  if (extension.toLowerCase() === '.svg') {
    const root = bytes.toString('utf8').match(/<svg\b[^>]*>/i)?.[0]
    if (root) {
      const width = root.match(/\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i)?.[1]
      const height = root.match(/\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i)?.[1]
      if (width && height) return dimensions(Math.round(Number(width)), Math.round(Number(height)))
      const box = root.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1].trim().split(/[\s,]+/).map(Number)
      if (box?.length === 4) return dimensions(Math.round(box[2]), Math.round(box[3]))
    }
  }
  return undefined
}
