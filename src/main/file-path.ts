import { homedir } from 'node:os'
import path from 'node:path'
import type { FileBrowserRequest } from '../shared/types'
import { expandSandboxHome } from './sandbox/paths'

/** UI file requests share the tools' leading-home semantics. Resolve lexically
 * so symlink names and nonexistent files keep their identity; readers still
 * own their format, size and filesystem checks. */
export function resolveFilePath(
  request: FileBrowserRequest,
  { homeDir = homedir(), platform = process.platform }: { homeDir?: string; platform?: NodeJS.Platform } = {}
): string {
  const resolver = platform === 'win32' ? path.win32 : path.posix
  if (!request || typeof request.cwd !== 'string' || !resolver.isAbsolute(request.cwd) ||
      request.cwd.includes('\0') || typeof request.path !== 'string' || request.path.includes('\0')) {
    throw new Error('Invalid file request')
  }
  const absolute = resolver.resolve(request.cwd, expandSandboxHome(request.path, homeDir, platform))
  return platform === 'win32' ? absolute.replaceAll('\\', '/') : absolute
}
