import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// Custom text roles are font sizes, so merging them must retain text colors.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['micro', 'caption', 'keycap', 'content', 'content-tight', 'content-small', 'content-heading', 'code', 'code-inline', 'terminal'] }],
      leading: [{ leading: ['content', 'content-tight', 'code', 'ui-tight', 'ui', 'ui-loose'] }]
    }
  }
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
