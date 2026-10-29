/**
 * PDF preview contract shared by the main-process range reader and the renderer.
 *
 * pdf.js never takes the whole file: it asks its host for byte ranges, and its
 * own network reader sends `bytes=begin-(end-1)` — so **the end is exclusive**.
 * The worker validates each answer against its chunk grid (`begin` divisible by
 * `rangeChunkSize`, `begin + bytes` either a chunk multiple or exactly the file
 * length), which is why an off-by-one answer breaks the entire load rather than
 * one page.
 */

export const PDF_EXTENSION = '.pdf'

/** A `.pdf` path (case-insensitive), the only thing the range reader serves. */
export function isPdfPath(path: string): boolean {
  return path.slice(-PDF_EXTENSION.length).toLowerCase() === PDF_EXTENSION
}
