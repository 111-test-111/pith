import elkLayouts from '@mermaid-js/layout-elk'
import type { LayoutLoaderDefinition } from 'mermaid'

export const MERMAID_LAYOUT = 'pith-flowchart'
const rectangular = new Set(['rect', 'squareRect', 'proc', 'process', 'rectangle', 'rounded', 'roundedRect', 'event', 'stadium', 'terminal', 'pill'])
const decisions = new Set(['diamond', 'diam', 'decision', 'question'])

/** Decorate the public ELK loader, rather than import Mermaid's hashed internals. */
export const pithMermaidLayout: LayoutLoaderDefinition = {
  name: MERMAID_LAYOUT,
  algorithm: 'elk.layered',
  async loader() {
    const layout = await elkLayouts.find(layout => layout.name === 'elk')!.loader()
    return {
      async render(data, svg, helpers, options) {
        const fontSize = parseFloat(data.config.themeVariables?.fontSize) || 14
        for (const node of data.nodes) {
          if (node.isGroup) continue
          if (decisions.has(node.shape ?? '')) {
            node.shape = 'rect'
            node.cssClasses = `${node.cssClasses ?? ''} pith-mermaid-decision`
          }
          if (rectangular.has(node.shape ?? '')) {
            node.shape = 'rect'
            node.padding = fontSize
            node.labelPaddingX = fontSize * 2.4
            node.height = Math.max(node.height ?? 0, fontSize * 4)
          }
        }
        const root = svg.node()
        if (!root) throw new Error('Missing diagram SVG')
        const padded = new WeakSet<SVGRectElement>()
        const padLabels = () => {
          for (const label of root.querySelectorAll('.edgeLabel .label')) {
            const text = label.querySelector('text')
            const background = label.querySelector<SVGRectElement>('rect.background')
            if (text?.textContent && background && !padded.has(background)) {
              const bounds = text.getBBox()
              if (!bounds.width || !bounds.height) continue
              const padding = fontSize * 0.65
              const height = Math.max(fontSize * 1.9, bounds.height + fontSize * 0.5)
              background.setAttribute('x', String(bounds.x - padding))
              background.setAttribute('y', String(bounds.y - (height - bounds.height) / 2))
              background.setAttribute('width', String(bounds.width + padding * 2))
              background.setAttribute('height', String(height))
              padded.add(background)
            }
          }
        }
        // ELK 12 owns its label helpers. Pad labels as they enter this SVG,
        // BEFORE its async measurement/layout reserves their bounding boxes.
        // The observer stays local to this one render and never sees Markdown.
        const observer = new MutationObserver(padLabels)
        observer.observe(root, { childList: true, subtree: true })
        try {
          await layout.render(data, svg, helpers, options)
          padLabels()
        } finally { observer.disconnect() }

        // Open chevrons retain the edge's own color and direction. Other marker
        // shapes (circles, crosses, cardinality, etc.) keep their semantics.
        for (const marker of root.querySelectorAll<SVGMarkerElement>('marker[id*="-pointEnd"], marker[id*="-pointStart"]')) {
          const start = marker.id.includes('-pointStart')
          marker.setAttribute('viewBox', '-6 -5 12 10')
          marker.setAttribute('markerWidth', '12')
          marker.setAttribute('markerHeight', '10')
          marker.setAttribute('refX', '0')
          marker.setAttribute('refY', '0')
          for (const path of marker.querySelectorAll('path')) {
            path.setAttribute('d', start ? 'M 5 -3.5 L 0 0 L 5 3.5' : 'M -5 -3.5 L 0 0 L -5 3.5')
            path.style.fill = 'none'
            path.style.strokeWidth = '1'
            path.style.strokeDasharray = 'none'
            path.style.strokeLinecap = 'round'
            path.style.strokeLinejoin = 'round'
          }
        }
      }
    }
  }
}
