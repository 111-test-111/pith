import type { PreviewImage } from '@/components/app/ImagePreview'
import type { GeneratedImageFile } from '../../../shared/image'
import type { ImageReplayRecord } from '../../../shared/image-replay'
import type { ImageContent } from '../../../shared/types'
import { mediaUrl } from '../../../shared/media'
import { basename } from './format'

/** Each delivered slot retains its original and committed retry versions in
 * creation order. Failed, cancelled and unfinished attempts add no image. */
export function generationPreviewImages({ files, images = [], savedFiles, replays, imageLabel }: {
  files: readonly GeneratedImageFile[]
  images?: readonly ImageContent[]
  savedFiles: boolean
  replays?: ReadonlyMap<string, readonly ImageReplayRecord[]>
  imageLabel: (index: number) => string
}): PreviewImage[] {
  const previews: PreviewImage[] = []
  for (let index = 0; index < Math.max(files.length, images.length); index++) {
    const file = files[index], image = images[index]
    const src = savedFiles && file ? mediaUrl(file.path) : image ? `data:${image.mimeType};base64,${image.data}` : undefined
    if (src) previews.push({ id: file?.path ?? `image-${index}`, src, label: file ? basename(file.path) : imageLabel(index), path: file?.path })
    for (const replay of file && replays?.get(file.path) || []) {
      if (replay.status !== 'complete' || replay.cancelled) continue
      for (const variant of replay.result?.files ?? []) previews.push({ id: variant.path, src: mediaUrl(variant.path), label: basename(variant.path), path: variant.path })
    }
  }
  return previews
}
