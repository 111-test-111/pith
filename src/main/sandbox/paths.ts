import { realpathSync } from 'node:fs'
import path from 'node:path'
import type { SandboxPathDependencies } from './types'

function resolverFor(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix
}

export const NODE_SANDBOX_PATH_DEPENDENCIES: SandboxPathDependencies = {
  realpath(candidate) {
    try {
      return realpathSync.native(candidate)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
      throw error
    }
  }
}

/** Expand only a leading home marker. Embedded tildes are ordinary characters. */
export function expandSandboxHome(
  input: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform
): string {
  const resolver = resolverFor(platform)
  if (input === '~') return homeDir
  if (input.startsWith('~/') || (platform === 'win32' && input.startsWith('~\\'))) {
    return resolver.join(homeDir, input.slice(2))
  }
  return input
}

export function lexicalSandboxPath(
  input: string,
  cwd: string,
  homeDir: string,
  platform: NodeJS.Platform = process.platform
): string | null {
  if (!input || input.includes('\0')) return null
  const resolver = resolverFor(platform)
  const expanded = expandSandboxHome(input, homeDir, platform)
  return resolver.resolve(cwd, expanded)
}

/**
 * Canonicalize a possibly-not-yet-created path. The deepest existing ancestor
 * is resolved first, then the missing suffix is appended. This closes the
 * common `existing-symlink/new-file` escape without requiring the leaf to
 * exist.
 */
export function realpathWithNearestExistingAncestor(
  absolutePath: string,
  dependencies: SandboxPathDependencies = NODE_SANDBOX_PATH_DEPENDENCIES,
  platform: NodeJS.Platform = process.platform
): string | null {
  const resolver = resolverFor(platform)
  let cursor = resolver.resolve(absolutePath)
  const missingSegments: string[] = []

  try {
    while (true) {
      const real = dependencies.realpath(cursor)
      if (real !== undefined) {
        return resolver.resolve(real, ...missingSegments.reverse())
      }
      const parent = resolver.dirname(cursor)
      if (parent === cursor) return null
      missingSegments.push(resolver.basename(cursor))
      cursor = parent
    }
  } catch {
    // Permission and unexpected filesystem errors are never treated as proof.
    return null
  }
}

export function resolveSandboxPath(
  input: string,
  options: {
    cwd: string
    homeDir: string
    platform?: NodeJS.Platform
    dependencies?: SandboxPathDependencies
  }
): string | null {
  const platform = options.platform ?? process.platform
  const lexical = lexicalSandboxPath(input, options.cwd, options.homeDir, platform)
  if (lexical === null) return null
  return realpathWithNearestExistingAncestor(
    lexical,
    options.dependencies ?? NODE_SANDBOX_PATH_DEPENDENCIES,
    platform
  )
}

/** Segment-aware containment; Windows comparisons are case-insensitive. */
export function isSandboxPathWithin(
  target: string,
  root: string,
  platform: NodeJS.Platform = process.platform
): boolean {
  const resolver = resolverFor(platform)
  const normalizedTarget = resolver.resolve(target)
  const normalizedRoot = resolver.resolve(root)
  const relative = resolver.relative(normalizedRoot, normalizedTarget)
  if (relative === '') return true
  if (resolver.isAbsolute(relative) || relative === '..') return false
  return !relative.startsWith(`..${resolver.sep}`)
}
