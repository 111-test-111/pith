import { createHash } from 'node:crypto'
import { resizeImage, type AgentSession } from '@earendil-works/pi-coding-agent'

type Agent = AgentSession['agent']
type Message = Agent['state']['messages'][number]
type Stream = Agent['streamFunction']
type RequestContext = Parameters<Stream>[1]
type Image = { type: 'image'; data: string; mimeType: string }

const INVALID_IMAGE_NOTE = '[Image omitted: the image data could not be decoded. Other tool output is preserved.]'
const OVERSIZE_IMAGE_NOTE = '[Image omitted: the encoded image exceeds the 64 MiB decode safety limit.]'
const TEXT_ONLY_IMAGE_NOTE = '[Image omitted from this request: the selected model does not accept images.]'
// Pi's file attachments allow 12 MiB. The SDK normally resizes tool output
// below provider limits; this larger bound only prevents unbounded decoding.
const MAX_BASE64_LENGTH = 64 * 1024 * 1024
const MAX_CACHE_ENTRIES = 128

export function imageBytes(image: Image): Buffer | null {
  if (typeof image.data !== 'string' || typeof image.mimeType !== 'string') return null
  // MCP image blocks may use unpadded base64; only a remainder of one is
  // impossible to decode. Padded payloads still need complete quartets.
  if (image.data.length === 0 || image.data.length % 4 === 1 ||
      (image.data.includes('=') && image.data.length % 4 !== 0) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return null
  const bytes = Buffer.from(image.data, 'base64')
  const mime = image.mimeType.toLowerCase()
  const matches = mime === 'image/png'
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mime === 'image/jpeg'
      ? bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : mime === 'image/gif'
        ? bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a'
        : mime === 'image/webp'
          ? bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
          : false
  return matches ? bytes : null
}

/** The SDK normalizes image size but keeps undecodable tool blocks unchanged. */
export class ImageSafety {
  private readonly validated = new Map<string, Promise<boolean>>()

  private valid(image: Image): Promise<boolean> {
    const bytes = imageBytes(image)
    if (!bytes) return Promise.resolve(false)
    const key = `${image.mimeType}:${createHash('sha256').update(bytes).digest('hex')}`
    const cached = this.validated.get(key)
    if (cached) return cached
    const pending = resizeImage(bytes, image.mimeType).then(result => result !== null, () => false)
    this.validated.set(key, pending)
    if (this.validated.size > MAX_CACHE_ENTRIES) this.validated.delete(this.validated.keys().next().value!)
    return pending
  }

  async sanitizeMessages(messages: Message[]): Promise<Message[]> {
    let changed = false
    const next: Message[] = []
    for (const message of messages) {
      if (message.role !== 'toolResult' && message.role !== 'user') { next.push(message); continue }
      if (!Array.isArray(message.content) || !message.content.some(block => block.type === 'image')) {
        next.push(message); continue
      }
      const content = await this.sanitizeContent(message.content)
      if (content !== message.content) changed = true
      next.push(content === message.content ? message : { ...message, content } as Message)
    }
    return changed ? next : messages
  }

  private async sanitizeContent<T extends { type: string }>(content: T[]): Promise<T[]> {
    let changed = false
    const next: T[] = []
    for (const block of content) {
      if (block.type !== 'image') { next.push(block); continue }
      const image = block as unknown as Image
      const oversize = typeof image.data === 'string' && image.data.length > MAX_BASE64_LENGTH
      if (!oversize && await this.valid(image)) { next.push(block); continue }
      changed = true
      next.push({ type: 'text', text: oversize ? OVERSIZE_IMAGE_NOTE : INVALID_IMAGE_NOTE } as unknown as T)
    }
    return changed ? next : content
  }

  /** Run after the SDK's own image normalization and before result persistence. */
  install(session: AgentSession): () => void {
    const agent = session.agent
    const previousAfter = agent.afterToolCall
    const after: Agent['afterToolCall'] = async (context, signal) => {
      const prior = await previousAfter?.(context, signal)
      const content = prior?.content ?? context.result.content
      if (!content.some(block => block.type === 'image')) return prior
      const safe = await this.sanitizeContent(content)
      // A replaced content array must not retain structuredContent describing
      // the original image blocks (the SDK applies the same rule for hooks).
      return safe === content ? prior : { ...prior, content: safe, structuredContent: undefined }
    }
    agent.afterToolCall = after

    const previousTransform = agent.transformContext
    const transform: NonNullable<Agent['transformContext']> = async (messages, signal) => {
      const transformed = previousTransform ? await previousTransform(messages, signal) : messages
      return this.sanitizeMessages(transformed)
    }
    agent.transformContext = transform
    return () => {
      if (agent.afterToolCall === after) agent.afterToolCall = previousAfter
      if (agent.transformContext === transform) agent.transformContext = previousTransform
      this.validated.clear()
    }
  }
}

/** Provider models declaring text-only input must not receive historical images. */
export function omitImagesForTextOnlyModel(context: RequestContext): RequestContext {
  let changed = false
  const messages = context.messages.map(message => {
    if (message.role !== 'toolResult' && message.role !== 'user') return message
    if (!Array.isArray(message.content) || !message.content.some(block => block.type === 'image')) return message
    changed = true
    return { ...message, content: message.content.map(block => block.type === 'image'
      ? { type: 'text' as const, text: TEXT_ONLY_IMAGE_NOTE } : block) }
  })
  return changed ? { ...context, messages } : context
}

export function installTextOnlyImageOverlay(session: AgentSession): () => void {
  const previous = session.agent.streamFunction
  const overlay: Stream = (model, context, options) => previous(model,
    Array.isArray(model.input) && !model.input.includes('image') ? omitImagesForTextOnlyModel(context) : context,
    options)
  session.agent.streamFunction = overlay
  return () => { if (session.agent.streamFunction === overlay) session.agent.streamFunction = previous }
}
