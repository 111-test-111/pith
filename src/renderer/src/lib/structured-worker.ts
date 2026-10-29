import { parseStructured } from './structured-parse'
import type { StructuredFormat } from '../../../shared/file-preview'
self.onmessage = ({ data }: MessageEvent<{ text: string; format: StructuredFormat; truncated: boolean }>) => {
  self.postMessage(parseStructured(data.text, data.format, data.truncated))
}
