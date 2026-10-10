import { useSyncExternalStore } from 'react'
import type { MermaidConfig } from 'mermaid'
import { mermaidImage } from './mermaid-image'

export const MERMAID_SOURCE_LIMIT = 50_000

export interface MermaidAppearance {
  dark: boolean
  background: string
  foreground: string
  primary: string
  muted: string
  border: string
  line: string
  fontFamily: string
  fontSize: number
  cornerShape: 'squircle' | 'round'
  nodeRadius: number
  labelRadius: number
  groupRadius: number
  detailRadius: number
}

// Mermaid's theme calculator accepts hex, while app tokens use CSS Color 4.
// Let Chromium resolve the colors rather than maintaining a second palette.
let colorContext: CanvasRenderingContext2D | null = null
function hexColor(value: string): string {
  colorContext ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  if (!colorContext) throw new Error('Color conversion unavailable')
  colorContext.clearRect(0, 0, 1, 1)
  colorContext.fillStyle = value
  colorContext.fillRect(0, 0, 1, 1)
  return '#' + [...colorContext.getImageData(0, 0, 1, 1).data].slice(0, 3)
    .map(channel => channel.toString(16).padStart(2, '0')).join('')
}

function readAppearance(): string {
  const root = document.documentElement
  const css = getComputedStyle(root)
  const background = hexColor(css.getPropertyValue('--background').trim())
  const foreground = hexColor(css.getPropertyValue('--foreground').trim())
  const mix = (amount: number) => hexColor(`color-mix(in srgb, ${foreground} ${amount}%, ${background})`)
  return JSON.stringify({
    dark: root.classList.contains('dark'), background, foreground,
    primary: hexColor(css.getPropertyValue('--primary').trim()),
    muted: mix(5), border: mix(22), line: mix(55),
    fontFamily: css.getPropertyValue('--app-font-ui').trim() || css.fontFamily,
    fontSize: parseFloat(css.getPropertyValue('--app-text-ui-xs')) || 12,
    cornerShape: css.getPropertyValue('--app-corner-shape').trim() === 'squircle' ? 'squircle' : 'round',
    nodeRadius: parseFloat(css.getPropertyValue('--app-radius-item')) || 0,
    labelRadius: parseFloat(css.getPropertyValue('--app-radius-inner')) || 0,
    groupRadius: parseFloat(css.getPropertyValue('--app-radius-card')) || 0,
    detailRadius: parseFloat(css.getPropertyValue('--app-radius-detail')) || 0
  } satisfies MermaidAppearance)
}

let appearanceSnapshot: string | undefined
const getAppearanceSnapshot = () => appearanceSnapshot ??= readAppearance()
let appearanceObserver: MutationObserver | undefined
const appearanceListeners = new Set<() => void>()
function subscribeAppearance(listener: () => void): () => void {
  appearanceListeners.add(listener)
  if (!appearanceObserver) {
    appearanceSnapshot = readAppearance()
    appearanceObserver = new MutationObserver(() => {
      const next = readAppearance()
      if (next === appearanceSnapshot) return
      appearanceSnapshot = next
      appearanceListeners.forEach(notify => notify())
    })
    appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-accent', 'data-corners'] })
  }
  return () => {
    appearanceListeners.delete(listener)
    if (!appearanceListeners.size) {
      appearanceObserver?.disconnect(); appearanceObserver = undefined; appearanceSnapshot = undefined
    }
  }
}

export function useMermaidAppearance(): string {
  return useSyncExternalStore(subscribeAppearance, getAppearanceSnapshot)
}

export function mermaidConfig(appearance: MermaidAppearance): MermaidConfig {
  const { dark, background, foreground, primary, muted, border, line, fontFamily, fontSize } = appearance
  const fill = hexColor(`color-mix(in srgb, ${primary} 8%, ${background})`)
  const text = hexColor(`color-mix(in srgb, ${primary} 12%, ${foreground})`)
  const labelBorder = hexColor(`color-mix(in srgb, ${primary} 18%, ${border})`)
  return {
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
    maxTextSize: MERMAID_SOURCE_LIMIT, maxEdges: 500,
    // Source directives cannot weaken confinement or replace the app theme.
    secure: ['secure', 'securityLevel', 'startOnLoad', 'suppressErrorRendering', 'maxTextSize', 'maxEdges',
      'htmlLabels', 'theme', 'themeVariables', 'themeCSS', 'fontFamily', 'fontSize', 'look', 'layout'],
    theme: 'base', look: 'classic', layout: 'elk', htmlLabels: false, fontFamily, fontSize,
    flowchart: { curve: appearance.nodeRadius ? 'rounded' : 'linear', padding: 16, nodeSpacing: 40, rankSpacing: 54, useMaxWidth: false },
    sequence: { useMaxWidth: false, actorFontFamily: fontFamily, actorFontSize: fontSize, noteFontFamily: fontFamily, noteFontSize: fontSize, messageFontFamily: fontFamily, messageFontSize: fontSize },
    // classDef/style colors compile to inline styles and stay authoritative.
    // Only defaults, geometry and typography belong to the app.
    themeCSS: `
      .node text, .edgeLabels text { font-weight: 500; }
      .node tspan[font-weight="normal"], .edgeLabels tspan[font-weight="normal"] { font-weight: 500; }
      .actor text, text.actor, .messageText, .noteText { font-weight: 500; }
      .sequenceNumber { font-family: ${fontFamily}; font-weight: 500; }
      [id$="-sequencenumber"] { fill: ${foreground}; }
      text { text-rendering: optimizeLegibility; }
      :where(.edgeLabel .label rect) { fill: ${background}; stroke: ${labelBorder}; stroke-width: 1px; opacity: 1; }
      .node.pith-mermaid-decision .label-container { fill: ${background}; stroke: ${labelBorder}; stroke-dasharray: 2 2; }
      .edgePaths .flowchart-link { stroke-linecap: round; stroke-linejoin: round; }
    `,
    themeVariables: {
      darkMode: dark, background, fontFamily, fontSize: `${fontSize}px`,
      primaryColor: fill, primaryTextColor: text, primaryBorderColor: border,
      secondaryColor: muted, secondaryTextColor: foreground, secondaryBorderColor: border,
      tertiaryColor: background, tertiaryTextColor: foreground, tertiaryBorderColor: border,
      textColor: foreground, lineColor: line, mainBkg: fill, nodeBorder: border,
      clusterBkg: background, clusterBorder: border, edgeLabelBackground: background,
      titleColor: foreground, nodeTextColor: text,
      actorBkg: fill, actorBorder: border, actorTextColor: foreground, actorLineColor: line,
      signalColor: line, signalTextColor: foreground, sequenceNumberColor: background, labelBoxBkgColor: muted,
      labelBoxBorderColor: border, labelTextColor: foreground, loopTextColor: foreground,
      noteBkgColor: muted, noteTextColor: foreground, noteBorderColor: border,
      activationBkgColor: fill, activationBorderColor: border,
      taskTextColor: foreground, taskTextOutsideColor: foreground,
      taskTextLightColor: foreground, taskTextDarkColor: foreground,
      sectionBkgColor: muted, altSectionBkgColor: background, gridColor: border,
      cScaleLabel0: foreground, cScaleLabel1: foreground, cScaleLabel2: foreground,
      cScaleLabel3: foreground, cScaleLabel4: foreground, cScaleLabel5: foreground
    }
  }
}

export interface MermaidImage { src: string; width: number; height: number }
const cache = new Map<string, MermaidImage>()
let cacheBytes = 0
const CACHE_LIMIT = 64
const CACHE_BYTES = 4_000_000
let engine: Promise<typeof import('mermaid')['default']> | undefined
let renderQueue: Promise<unknown> = Promise.resolve()
let sequence = 0

export function renderMermaid(source: string, appearanceJSON: string, signal: AbortSignal): Promise<MermaidImage> {
  if (source.length > MERMAID_SOURCE_LIMIT) return Promise.reject(new Error('Diagram source exceeds limit'))
  const key = JSON.stringify([source, appearanceJSON])
  // initialize() mutates Mermaid's singleton, so initialization AND rendering
  // share one queue. Cancelled/stale requests never start another DOM render.
  const result = renderQueue.then(async () => {
    signal.throwIfAborted()
    const hit = cache.get(key)
    if (hit) { cache.delete(key); cache.set(key, hit); return hit }
    const mermaid = await (engine ??= Promise.all([import('mermaid'), import('./mermaid-layout')]).then(([module, layout]) => {
      module.default.registerLayoutLoaders([layout.pithMermaidLayout])
      return module.default
    }).catch(error => { engine = undefined; throw error }))
    signal.throwIfAborted()
    await document.fonts.ready
    signal.throwIfAborted()
    const appearance: MermaidAppearance = JSON.parse(appearanceJSON)
    await document.fonts.load(`${appearance.fontSize}px ${appearance.fontFamily}`, source.slice(0, 2000))
    signal.throwIfAborted()
    const container = document.createElement('div')
    container.dataset.mermaidMeasure = ''
    container.setAttribute('aria-hidden', 'true')
    container.className = 'mermaid-measure'
    document.body.append(container)
    try {
      const config = mermaidConfig(appearance)
      mermaid.initialize(config)
      // Let Mermaid handle directives/frontmatter when detecting the type.
      // Only flowcharts change decision shapes and edge-label layout.
      if (/^flowchart(?:-|$)/.test(mermaid.detectType(source, config))) {
        mermaid.initialize({ ...config, layout: 'pith-flowchart' })
      }
      const { svg } = await mermaid.render(`pith-mermaid-${++sequence}`, source, container)
      signal.throwIfAborted()
      const image = mermaidImage(svg, appearance, container)
      const bytes = key.length + image.src.length
      if (bytes <= CACHE_BYTES) {
        cache.set(key, image); cacheBytes += bytes
        while (cache.size > CACHE_LIMIT || cacheBytes > CACHE_BYTES) {
          const oldest = cache.entries().next().value!
          cacheBytes -= oldest[0].length + oldest[1].src.length
          cache.delete(oldest[0])
        }
      }
      return image
    } finally { container.remove() }
  })
  renderQueue = result.catch(() => {})
  return result
}
