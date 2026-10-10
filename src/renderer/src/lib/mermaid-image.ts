import type { MermaidAppearance, MermaidImage } from './mermaid'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XHTML_NS = 'http://www.w3.org/1999/xhtml'

/** Only app-created, empty frames use HTML; all source labels remain SVG text. */
function applyCorners(root: SVGSVGElement, appearance: MermaidAppearance, container: HTMLElement): void {
  const host = document.createElement('div')
  container.append(host)
  // Compute only the diagram's embedded styles, isolated from beUI/app CSS.
  host.attachShadow({ mode: 'closed' }).append(root)
  try {
    const frames = [...root.querySelectorAll<SVGRectElement>(
      '.node rect.label-container, .cluster rect, .edgeLabel rect.background, rect.actor, rect.note, rect.labelBox, rect[class^="activation"], rect.loopLine'
    )]
    for (const rect of frames) {
      const label = !!rect.closest('.edgeLabel') || rect.classList.contains('labelBox')
      const activation = rect.matches('[class^="activation"]')
      const radius = label ? appearance.labelRadius : activation ? appearance.detailRadius
        : rect.closest('.cluster') ? appearance.groupRadius : appearance.nodeRadius
      if (!radius) {
        rect.setAttribute('rx', '0')
        rect.setAttribute('ry', '0')
        rect.style.setProperty('rx', '0')
        rect.style.setProperty('ry', '0')
        continue
      }
      const css = getComputedStyle(rect)
      const width = rect.width.baseVal.value, height = rect.height.baseVal.value
      if (width <= 0 || height <= 0) continue
      // A local gradient/pattern remains an SVG primitive, rather than losing
      // source-defined artwork through a CSS background conversion.
      const fill = css.fill === 'none' ? 'transparent' : css.fill
      const stroke = css.stroke === 'none' ? 'transparent' : css.stroke
      if (!CSS.supports('color', fill) || !CSS.supports('color', stroke)) continue
      const borderWidth = stroke === 'transparent' ? 0 : parseFloat(css.strokeWidth) || 1
      const frame = document.createElementNS(SVG_NS, 'foreignObject')
      frame.setAttribute('data-mermaid-frame', '')
      frame.setAttribute('x', String(rect.x.baseVal.value - borderWidth / 2))
      frame.setAttribute('y', String(rect.y.baseVal.value - borderWidth / 2))
      frame.setAttribute('width', String(width + borderWidth))
      frame.setAttribute('height', String(height + borderWidth))
      if (rect.hasAttribute('transform')) frame.setAttribute('transform', rect.getAttribute('transform')!)
      const box = document.createElementNS(XHTML_NS, 'div')
      const alpha = (color: string, value: string) => Number(value) < 1
        ? `color-mix(in srgb, ${color} ${Number(value) * 100}%, transparent)` : color
      Object.assign(box.style, {
        width: '100%', height: '100%', boxSizing: 'border-box', pointerEvents: 'none',
        backgroundColor: alpha(fill, css.fillOpacity), borderColor: alpha(stroke, css.strokeOpacity),
        borderWidth: `${borderWidth}px`, borderStyle: css.strokeDasharray.split(/[\s,]+/).some(value => parseFloat(value) > 0) ? 'dashed' : 'solid',
        borderRadius: `${radius}px`, cornerShape: appearance.cornerShape, opacity: css.opacity
      })
      frame.append(box)
      rect.replaceWith(frame)
    }
  } finally {
    root.remove()
    host.remove()
  }
}

export function mermaidImage(svg: string, appearance: MermaidAppearance, container: HTMLElement): MermaidImage {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = parsed.documentElement as unknown as SVGSVGElement
  if (root.localName !== 'svg' || parsed.querySelector('parsererror')) throw new Error('Invalid diagram SVG')
  // Discard all source-produced HTML/executable/external elements BEFORE
  // creating our empty native-corner frames. No source HTML is ever retained.
  root.querySelectorAll('script, foreignObject, image, a').forEach(element => {
    if (element.localName === 'a') element.replaceWith(...element.childNodes)
    else element.remove()
  })
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      if (/^on/i.test(attribute.name) || (/(?:^|:)href$/i.test(attribute.name) && !attribute.value.startsWith('#'))) {
        element.removeAttribute(attribute.name)
      }
    }
  }
  const box = root.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
  if (!box || box.length !== 4 || box.some(value => !Number.isFinite(value)) || box[2] <= 0 || box[3] <= 0) {
    throw new Error('Invalid diagram dimensions')
  }
  const width = Math.ceil(box[2]), height = Math.ceil(box[3])
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  root.setAttribute('xmlns', SVG_NS)
  root.style.maxWidth = 'none'
  root.style.backgroundColor = appearance.background
  root.style.color = appearance.foreground
  applyCorners(root, appearance, container)
  // SVG is an isolated image, without app DOM insertion or event bindings.
  return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`, width, height }
}
