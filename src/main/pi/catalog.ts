import { APP_BASH_TOOL_NAMES } from './bash-tools'
import { APP_BROWSER_TOOL_NAMES } from '../browser/tools'
import { TODO_TOOL_NAME } from './todo-protocol'
import { IMAGE_TOOL_NAME } from '../../shared/image'
import { JEV_TOOL_NAME } from './jev/protocol'

import {
  DefaultPackageManager,
  SettingsManager,
  type Extension,
  type ResolvedResource,
  type ResourceLoader,
  type ToolInfo
} from '@earendil-works/pi-coding-agent'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative } from 'node:path'
import type {
  ExtensionInfoDTO,
  ExtensionResourceDTO,
  ExtensionResourceKind,
  SkillDiagnosticDTO,
  SkillInfoDTO,
  ToolCatalogDTO,
  ToolInfoDTO
} from '../../shared/types'

const APP_TOOL_NAMES: readonly string[] = [...APP_BASH_TOOL_NAMES, 'debug', 'present', IMAGE_TOOL_NAME, TODO_TOOL_NAME, JEV_TOOL_NAME, 'get_goal', 'update_goal', ...APP_BROWSER_TOOL_NAMES]
/** Hidden SDK factories are not listed as user-managed extensions, but their
 * tools still need a useful source name in Settings → Tools. Match their exact
 * factory identity so third-party inline extensions keep their own source. */
const NATIVE_INLINE_TOOL_SOURCES = new Map([
  ['<inline:native-mcp>', 'Pi MCP'],
  ['<inline:native-codemode>', 'codemode'],
  ['<inline:native-tool-search>', 'tool_search']
])

/**
 * Settings → Tools / Extensions reads the *unfiltered* resource loader, so a
 * disabled extension stays visible (with its tools listed but inactive) even
 * though the session's runner never sees it. The manager keeps the real loader
 * and wraps only the runner-facing one in a Proxy (see `PiManager.servicesFor`).
 *
 * Two registration styles matter here: extensions like Tavily register their
 * tools at load time (visible on `extension.tools`), while others (e.g. pi-fff)
 * call `pi.registerTool` from `session_start`, so their tools only exist on the
 * live session's registry. The catalog merges both.
 */

/** Stable identity for an extension: its resolved entry file. */
export function extensionId(extension: Extension): string {
  return extension.resolvedPath || extension.path
}

/** Package name/version for an installed package root. */
function readPackageJson(packageRoot: string): { name?: string; version?: string } {
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      version: typeof parsed.version === 'string' ? parsed.version : undefined
    }
  } catch {
    return {}
  }
}

/**
 * Recover package metadata when configured package details are unavailable.
 * Package sources may point at their root or an entry subdirectory.
 */
function findPackageMeta(baseDir?: string): { name?: string; version?: string } {
  if (!baseDir) return {}
  let dir = baseDir
  for (let depth = 0; depth < 4; depth += 1) {
    const meta = readPackageJson(dir)
    if (meta.name) return meta
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return {}
}

/** Version pinned in the configured source spec (`npm:pkg@1.2.3`, `git:…#tag`). */
function configuredVersion(source: string): string | undefined {
  if (source.startsWith('npm:')) {
    const spec = source.slice(4)
    const at = spec.lastIndexOf('@')
    const nameEnd = spec.startsWith('@') ? spec.indexOf('/', 1) : 0
    return at > nameEnd ? spec.slice(at + 1) || undefined : undefined
  }
  if (source.startsWith('git:') || /^[a-z]+:\/\//.test(source)) {
    const at = source.lastIndexOf('@')
    if (at > Math.max(source.lastIndexOf('/'), source.lastIndexOf(':'))) {
      return source.slice(at + 1) || undefined
    }
  }
  return undefined
}

const GENERIC_SOURCE_DIRS = new Set(['src', 'dist', 'lib', 'build', 'out', 'esm', 'cjs'])

function resourceName(path: string, kind: ExtensionResourceKind): string {
  const file = basename(path)
  const ext = extname(file)
  if (kind === 'skill' && file.toLowerCase() === 'skill.md') return basename(dirname(path))
  if (kind === 'extension' && /^index\.(ts|js|mjs|cjs)$/.test(file)) {
    const dir = basename(dirname(path))
    // `src/index.ts`, `dist/index.js`: the enclosing package is the useful name.
    return GENERIC_SOURCE_DIRS.has(dir) ? basename(dirname(dirname(path))) : dir
  }
  return ext ? file.slice(0, -ext.length) : file
}

function toResourceInfo(resource: ResolvedResource, kind: ExtensionResourceKind): ExtensionResourceDTO {
  const baseDir = resource.metadata.baseDir
  const rel = baseDir ? relative(baseDir, resource.path) : ''
  return {
    kind,
    name: resourceName(resource.path, kind),
    path: resource.path,
    relativePath: rel && !rel.startsWith('..') ? rel : undefined
  }
}

/** Package-derived details the Extensions tab shows alongside each extension. */
export interface PackageResources {
  installedPath?: string
  packageName?: string
  version?: string
  configuredVersion?: string
  resources: ExtensionResourceDTO[]
}

/**
 * Resolve every configured package's installed path and the resources it ships
 * (extensions/skills/prompts/themes). Missing sources are skipped — a settings
 * entry with nothing installed must not trigger a surprise network install.
 */
export async function loadPackageResources(
  cwd: string,
  agentDir: string
): Promise<Map<string, PackageResources>> {
  const packages = new Map<string, PackageResources>()
  const settingsManager = SettingsManager.create(cwd, agentDir)
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager })

  for (const pkg of packageManager.listConfiguredPackages()) {
    const meta = pkg.installedPath ? readPackageJson(pkg.installedPath) : {}
    packages.set(pkg.source, {
      installedPath: pkg.installedPath,
      packageName: meta.name,
      version: meta.version,
      configuredVersion: configuredVersion(pkg.source),
      resources: []
    })
  }

  let resolved
  try {
    resolved = await packageManager.resolve(async () => 'skip')
  } catch {
    return packages
  }

  const kinds: [readonly ExtensionResourceKind[], ResolvedResource[]][] = [
    [['extension'], resolved.extensions],
    [['skill'], resolved.skills],
    [['prompt'], resolved.prompts],
    [['theme'], resolved.themes]
  ]
  for (const [kindList, resources] of kinds) {
    for (const resource of resources) {
      if (resource.metadata.origin !== 'package') continue
      const entry = packages.get(resource.metadata.source)
      if (!entry) continue
      entry.resources.push(toResourceInfo(resource, kindList[0]))
    }
  }
  return packages
}

/** Drop functions/symbols (TypeBox schemas carry a `Kind` symbol) before IPC. */
function plain(value: unknown): any {
  try {
    return JSON.parse(JSON.stringify(value ?? {}))
  } catch {
    // Serialization fails only for structures JSON cannot represent (a cycle,
    // a BigInt). One unrepresentable tool schema must not fail the whole
    // catalog response, so report that entry as empty instead.
    return {}
  }
}

interface ToolLike {
  description?: string
  parameters?: unknown
  promptGuidelines?: string[]
  exposure?: ToolInfoDTO['exposure']
}

function toolDTO(
  name: string,
  definition: ToolLike,
  source: ToolInfoDTO['source'],
  active: boolean,
  disabledByExtension: boolean
): ToolInfoDTO {
  return {
    name,
    description: definition.description ?? '',
    parameters: plain(definition.parameters),
    promptGuidelines: definition.promptGuidelines ? [...definition.promptGuidelines] : undefined,
    source,
    exposure: definition.exposure ?? 'direct',
    active,
    disabledByExtension
  }
}

function setTool(
  map: Map<string, Map<string, ToolInfoDTO>>,
  id: string,
  dto: ToolInfoDTO
): void {
  const tools = map.get(id) ?? new Map<string, ToolInfoDTO>()
  tools.set(dto.name, dto)
  map.set(id, tools)
}

/**
 * One entry of the session's EFFECTIVE tool view (see `plan-gate.ts`). The
 * catalog uses these for active rows so it describes the implementation the
 * model actually calls, never the registry's same-name definition — SDK
 * `ToolInfo` is raw registration data, not authority over a replacement.
 */
export interface EffectiveCatalogTool {
  name: string
  description: string
  parameters: unknown
  promptGuidelines?: string[]
  provenance: 'safe-read' | 'app' | 'reviewed-extension' | 'unreviewed'
}

/**
 * Build the catalog for one workspace. `sessionTools`/`activeToolNames` come
 * from the live session (built-ins, enabled extension tools — including ones
 * registered lazily during `session_start`); the extension list comes from the
 * real loader and therefore covers disabled ones too.
 *
 * `effectiveTools` is the gate's materialized view. When it names an active
 * tool, its metadata wins; a `safe-read` row is labelled as the app's own
 * read-only implementation instead of the extension whose name it replaced.
 *
 * `knownTools` is the manager's snapshot of tools an extension had while it was
 * still enabled, used to keep a disabled lazy extension's tools listed.
 */
export function buildToolCatalog(
  loader: ResourceLoader,
  sessionTools: ToolInfo[],
  activeToolNames: string[],
  disabledExtensions: Set<string>,
  packages: Map<string, PackageResources>,
  knownTools: Map<string, ToolInfoDTO[]>,
  effectiveTools: readonly EffectiveCatalogTool[] = []
): ToolCatalogDTO {
  const extensions = loader.getExtensions().extensions.filter((extension) => !extension.hidden)
  const active = new Set(activeToolNames)

  const infos = new Map<string, ExtensionInfoDTO>()
  const labels = new Map<string, string>()
  for (const extension of extensions) {
    const id = extensionId(extension)
    const source = extension.sourceInfo.source
    const pkg = packages.get(source)
    // Auto-discovered baseDir is the configuration root (agent or .pi), not
    // the extension's directory. Only package sources inherit package metadata.
    const fallback = !pkg?.packageName && extension.sourceInfo.origin === 'package'
      ? findPackageMeta(extension.sourceInfo.baseDir)
      : undefined
    const name = pkg?.packageName ?? fallback?.name ?? resourceName(id, 'extension')
    labels.set(id, name)
    infos.set(id, {
      id,
      name,
      version: pkg?.version ?? fallback?.version,
      configuredVersion: pkg?.configuredVersion,
      source,
      scope: extension.sourceInfo.scope,
      origin: extension.sourceInfo.origin,
      path: id,
      toolNames: [],
      enabled: !disabledExtensions.has(id),
      packageName: pkg?.packageName,
      installedPath: pkg?.installedPath,
      resources: pkg?.resources ?? [],
      manageable: packages.has(source)
    })
  }

  const perExtension = new Map<string, Map<string, ToolInfoDTO>>()
  // One row per tool NAME, because a name is one callable tool. Two extensions
  // can override the same built-in (pi-fff's `grep`/`find` against a
  // pretty-printer that also registers them), and the session's own registry
  // keeps only the definition that won. The live pass below writes last, so the
  // surviving row is always the definition the model actually calls.
  const byName = new Map<string, ToolInfoDTO>()

  // Tools registered at load time (static `extension.tools` map).
  for (const extension of extensions) {
    const id = extensionId(extension)
    const enabled = !disabledExtensions.has(id)
    const label = labels.get(id) ?? id
    for (const [name, registered] of extension.tools) {
      if (APP_TOOL_NAMES.some((appName) => appName === name)) continue
      const dto = toolDTO(
        name,
        registered.definition,
        { kind: 'extension', extensionId: id, label },
        enabled && active.has(name),
        !enabled
      )
      setTool(perExtension, id, dto)
      byName.set(dto.name, dto)
    }
  }

  // Tools registered at runtime — attributed back to their extension via the
  // source info the runner stamped on them (this is how pi-fff shows up).
  const extensionByPath = new Map<string, Extension>()
  for (const extension of extensions) {
    extensionByPath.set(extension.path, extension)
    if (extension.resolvedPath) extensionByPath.set(extension.resolvedPath, extension)
  }
  for (const tool of sessionTools) {
    if (tool.sourceInfo.source === 'builtin' || (tool.sourceInfo.source === 'sdk' && APP_TOOL_NAMES.some((name) => name === tool.name))) continue
    const extension = extensionByPath.get(tool.sourceInfo.path)
    const nativeLabel = NATIVE_INLINE_TOOL_SOURCES.get(tool.sourceInfo.path)
    const id = extension ? extensionId(extension) : nativeLabel ? tool.sourceInfo.path : tool.sourceInfo.source
    const label = labels.get(id) ?? nativeLabel ?? tool.sourceInfo.source
    const enabled = !disabledExtensions.has(id)
    const dto = toolDTO(
      tool.name,
      tool,
      { kind: 'extension', extensionId: id, label },
      enabled && active.has(tool.name),
      !enabled
    )
    setTool(perExtension, id, dto)
    // Live definitions win over a stale static claim for the same name.
    byName.set(dto.name, dto)
  }

  // A disabled lazily-registering extension has no live tools left; reuse the
  // snapshot captured when it was switched off so they still show (inactive).
  for (const [id, snapshot] of knownTools) {
    if (!disabledExtensions.has(id) || perExtension.get(id)?.size) continue
    for (const dto of snapshot) {
      const disabled = { ...dto, active: false, disabledByExtension: true }
      setTool(perExtension, id, disabled)
      // A snapshot is the last resort: never let a switched-off extension's
      // memory of a tool take a name a live tool already answers to.
      if (!byName.has(dto.name)) byName.set(dto.name, disabled)
    }
  }

  const tools: ToolInfoDTO[] = [...byName.values()]

  const present = new Set(byName.keys())
  const builtinSeen = new Set<string>()
  for (const tool of sessionTools) {
    if ((tool.sourceInfo.source !== 'builtin' && !(tool.sourceInfo.source === 'sdk' && APP_TOOL_NAMES.some((name) => name === tool.name))) || present.has(tool.name)) continue
    if (builtinSeen.has(tool.name)) continue
    builtinSeen.add(tool.name)
    tools.push(
      toolDTO(tool.name, tool, { kind: 'builtin', label: 'builtin' }, active.has(tool.name), false)
    )
  }

  for (const info of infos.values()) {
    info.toolNames = [...(perExtension.get(info.id)?.keys() ?? [])]
  }

  // The effective view is the last word for ACTIVE rows: a Plan safe-read
  // replacement is not the extension/builtin definition that shares its name.
  const effective = new Map(effectiveTools.map((tool) => [tool.name, tool]))
  for (const dto of tools) {
    if (!dto.active) continue
    const view = effective.get(dto.name)
    if (!view) continue
    dto.description = view.description ?? dto.description
    dto.parameters = plain(view.parameters)
    dto.promptGuidelines = view.promptGuidelines ? [...view.promptGuidelines] : undefined
    if (view.provenance === 'safe-read') {
      dto.source = { kind: 'builtin', label: 'plan-safe-read' }
    }
  }

  const skillsResult = loader.getSkills()
  const skills: SkillInfoDTO[] = skillsResult.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    source: skill.sourceInfo.source,
    scope: skill.sourceInfo.scope,
    origin: skill.sourceInfo.origin,
    packageName: packages.get(skill.sourceInfo.source)?.packageName,
    disableModelInvocation: skill.disableModelInvocation
  }))
  const skillDiagnostics: SkillDiagnosticDTO[] = skillsResult.diagnostics.map((diagnostic) => ({
    type: diagnostic.type,
    message: diagnostic.message
  }))

  return { tools, extensions: [...infos.values()], skills, skillDiagnostics }
}
