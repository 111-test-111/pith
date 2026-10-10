import { analyse } from 'chardet'
import { crc32 } from 'node:zlib'
import { TextDecoder } from 'node:util'
import { getFileNameLowLevel, type Entry } from 'yauzl'
import { PreviewFailure } from './errors'

type NameRecord = Pick<Entry, 'fileNameRaw' | 'generalPurposeBitFlag' | 'extraFields'>
type LegacyEncoding = 'gb18030' | 'big5'
const MAX_SAMPLE_BYTES = 65536
const utf8 = new TextDecoder('utf-8', { fatal: true })
const decoders = { gb18030: new TextDecoder('gb18030', { fatal: true }), big5: new TextDecoder('big5', { fatal: true }) }

function decode(bytes: Uint8Array, decoder: TextDecoder): string | null {
  try { return decoder.decode(bytes) } catch { return null }
}

/** Unicode Path fields only override the raw name when their version, CRC and
 * UTF-8 payload are valid. Raw bytes are decoded before normalizing separators:
 * Big5/GBK can contain 0x5c as the second byte of a character. */
function unicodeName(entry: NameRecord): { name: string | null; declared: boolean } {
  for (const field of entry.extraFields) {
    if (field.id !== 0x7075 || field.data.length < 6 || field.data[0] !== 1 || field.data.readUInt32LE(1) !== crc32(entry.fileNameRaw)) continue
    const name = decode(field.data.subarray(5), utf8)
    if (name !== null) return { name, declared: true }
  }
  const name = decode(entry.fileNameRaw, utf8)
  if ((entry.generalPurposeBitFlag & 0x800) && name === null) throw new PreviewFailure('invalid')
  return { name, declared: !!(entry.generalPurposeBitFlag & 0x800) }
}

function guess(bytes: Uint8Array): LegacyEncoding | undefined {
  const candidate = analyse(bytes).find(item => ['GB18030', 'Big5'].includes(item.name) && item.confidence >= 40)
  return candidate ? candidate.name === 'Big5' ? 'big5' : 'gb18030' : undefined
}

function chineseName(name: string | null, minimum: number): name is string {
  return name !== null && !/[\x00-\x1f\x7f\ue000-\uf8ff]/u.test(name) && (name.match(/\p{Script=Han}/gu)?.length ?? 0) >= minimum
}

/** ZIP's unlabelled legacy names have no universal code page. Share bounded
 * evidence across the archive so short Chinese basenames inherit the encoding
 * of their parent paths. Keep CP437 when there is no Chinese byte evidence. */
export function zipNames(entries: readonly NameRecord[]): string[] {
  const unicode = entries.map(unicodeName)
  const samples: Buffer[] = []
  let bytes = 0
  for (let i = 0; i < entries.length && bytes < MAX_SAMPLE_BYTES; i++) {
    if (unicode[i].name !== null) continue
    const sample = entries[i].fileNameRaw.subarray(0, MAX_SAMPLE_BYTES - bytes)
    samples.push(sample, Buffer.from('\n')); bytes += sample.length + 1
  }
  const shared = samples.length ? guess(Buffer.concat(samples)) : undefined
  return entries.map((entry, i) => {
    let name = unicode[i].name
    // Some two-byte Chinese names also happen to be valid UTF-8 (e.g. GBK
    // "图" becomes a Greek character). Without Unicode metadata, strong
    // archive-wide legacy evidence resolves these otherwise ambiguous names.
    if (name !== null && !unicode[i].declared && shared && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(name)) {
      const candidate = decode(entry.fileNameRaw, decoders[shared])
      if (chineseName(candidate, 1)) name = candidate
    }
    if (name === null) {
      const gbk = decode(entry.fileNameRaw, decoders.gb18030)
      const big5 = decode(entry.fileNameRaw, decoders.big5)
      const preferred = guess(entry.fileNameRaw) ?? shared
      const candidate = preferred === 'big5' ? big5 : preferred === 'gb18030' ? gbk : null
      const cp437 = getFileNameLowLevel(0, entry.fileNameRaw, [], true)
      const garbled = /[\u0370-\u03ff\u2200-\u22ff\u2500-\u259f]/u.test(cp437)
      if (chineseName(candidate, 1)) name = candidate
      // Short unlabelled names cannot always be distinguished. GBK is the
      // common legacy Chinese ZIP encoding; Big5 wins when GBK is invalid or
      // produces private-use characters instead of ordinary Chinese text.
      else if (garbled && chineseName(gbk, 1)) name = gbk
      else if ((garbled || gbk === null || /[\ue000-\uf8ff]/u.test(gbk)) && chineseName(big5, garbled ? 1 : 2)) name = big5
      else name = cp437
    }
    return name.replaceAll('\\', '/')
  })
}
