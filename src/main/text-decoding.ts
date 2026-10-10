import { analyse } from 'chardet'
import { TEXT_ENCODINGS, type DecodedEncoding, type TextEncoding } from '../shared/file-preview'

const hasControls = (text: string) => /[\x00-\x08\x0e-\x1f]/.test(text)
export function validTextEncoding(value: unknown): value is TextEncoding { return TEXT_ENCODINGS.includes(value as TextEncoding) }

/** Explicit selection wins. Auto honours BOMs and only guesses Chinese
 * encodings after strict UTF-8 fails; arbitrary binary remains binary. */
export function sniffTextEncoding(bytes: Uint8Array, requested: TextEncoding = 'auto'): { encoding: DecodedEncoding; bom: number; unit: 1 | 2 } {
  if (!validTextEncoding(requested)) throw new Error('Invalid encoding')
  let encoding: DecodedEncoding = requested === 'auto' ? 'utf-8' : requested
  let bom = 0
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { if (requested === 'auto') encoding = 'utf-8'; if (encoding === 'utf-8') bom = 3 }
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { if (requested === 'auto') encoding = 'utf-16le'; if (encoding === 'utf-16le') bom = 2 }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { if (requested === 'auto') encoding = 'utf-16be'; if (encoding === 'utf-16be') bom = 2 }
  else if (requested === 'auto') {
    const sample = bytes.subarray(0, 65536)
    let even = 0, odd = 0
    for (let i = 0; i + 1 < sample.length; i += 2) { if (sample[i] === 0) even++; if (sample[i + 1] === 0) odd++ }
    const pairs = Math.max(1, sample.length >> 1)
    if (even / pairs > 0.25 && odd / pairs < 0.05) encoding = 'utf-16be'
    else if (odd / pairs > 0.25 && even / pairs < 0.05) encoding = 'utf-16le'
    else {
      try { new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true }) }
      catch {
        const candidate = analyse(sample).find(item => ['GB18030', 'Big5'].includes(item.name) && item.confidence >= 40)
        if (candidate) encoding = candidate.name === 'Big5' ? 'big5' : 'gb18030'
      }
    }
  }
  return { encoding, bom, unit: encoding.startsWith('utf-16') ? 2 : 1 }
}

export function decodeFileText(bytes: Uint8Array, truncated = false, requested: TextEncoding = 'auto'): { text: string; encoding: DecodedEncoding } | null {
  try {
    const { encoding, bom } = sniffTextEncoding(bytes, requested)
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(bom), { stream: truncated })
    if (hasControls(text)) return null
    return { text, encoding }
  } catch { return null }
}
