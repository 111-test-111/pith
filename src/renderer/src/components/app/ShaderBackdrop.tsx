import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { ShaderBackground } from '@/components/motion/shader-background'
import { useReduceMotion } from '@/lib/reduce-motion'

/**
 * Resolve any CSS color expression (including `color-mix()` in oklch) to the
 * rgb form the shader's color parser accepts. The shader package only
 * understands hex/rgb/hsl — an oklch token would fall back to a hard-coded
 * color with a console error — and Chromium hands oklch back out of both
 * `getComputedStyle` and `fillStyle`, so the value is painted into a 1x1 canvas
 * and read back as sRGB bytes.
 */
function resolveColor(expression: string): string | null {
  const probe = document.createElement('span')
  probe.style.cssText = `position:absolute;visibility:hidden;color:${expression}`
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = '#000000'
  context.fillStyle = computed
  context.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
  if (a === 0) return null
  return a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`
}

function buildPalette(): string[] {
  const mix = (primary: number) =>
    resolveColor(`color-mix(in oklch, var(--primary) ${primary}%, var(--background))`)
  return [mix(60), mix(30), resolveColor('var(--background)')].filter(
    (color): color is string => Boolean(color)
  )
}

/**
 * A soft, theme-aware wash behind the welcome and new-chat landing surfaces.
 * The palette follows the live theme tokens (`class`/`data-accent` on <html>,
 * plus `style`: the custom accent's derived tokens ride inline custom
 * properties there, so dragging the color well must repaint the wash),
 * the layer is pointer-transparent and hidden from assistive tech, and a radial
 * mask keeps it reading as light rather than as an image.
 *
 * Two independent signals freeze the shader's `speed`, because a WebGL effect is
 * neither motion's nor CSS's to stop: the OS preference (the vendored wrapper
 * reads `useReducedMotion()`) and reduced motion, which this component reads itself
 * and passes as `speed={0}` — a preference flip has to freeze the running shader
 * without waiting for the component to remount.
 */
export function ShaderBackdrop({ className }: { className?: string }) {
  const { resolvedTheme } = useTheme()
  const reduceMotion = useReduceMotion()
  const [colors, setColors] = useState<string[]>(() => buildPalette())
  useEffect(() => {
    const update = () => setColors(buildPalette())
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'data-accent', 'style']
    })
    return () => observer.disconnect()
  }, [resolvedTheme])

  return (
    <div
      aria-hidden="true"
      data-shader-backdrop=""
      data-shader-colors={colors.join(" ")}
      data-shader-motion={reduceMotion ? 'frozen' : 'live'}
      className={`pointer-events-none absolute inset-0 -z-10 overflow-hidden ${className ?? ''}`}
    >
      {colors.length >= 2 ? (
        <ShaderBackground
          variant="mesh-gradient"
          colors={colors}
          distortion={0.9}
          swirl={0.5}
          grainOverlay={0.04}
          speed={reduceMotion ? 0 : 0.6}
          scale={1.4}
          className="h-full w-full opacity-55 [mask-image:radial-gradient(120%_95%_at_50%_38%,#000_30%,transparent_100%)] dark:opacity-40"
        />
      ) : null}
    </div>
  )
}
