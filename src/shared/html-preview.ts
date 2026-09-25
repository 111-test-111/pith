/** A memory-only session, separate from both the shell and the signed-in browser. */
export const HTML_PREVIEW_PARTITION = 'pith-html-preview'

/** A random host is both an unguessable capability and a separate web origin.
 * Chromium resolves *.localhost internally to loopback. Keeping the capability
 * in the host lets /assets/x.css and relative URLs use normal website semantics. */
export function isHtmlPreviewUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && /^pith-[a-f0-9]{32}\.localhost$/.test(url.hostname) &&
      !!url.port && !url.username && !url.password
  } catch { return false }
}
