import { realpath } from 'node:fs/promises'
import { relative, sep } from 'node:path'
import type { GitChange } from '../../shared/git'
import { GitFailure } from './errors'
import { parseStatus } from './parse'
import { MAX_FILES, trimLine } from './repository'
import type { GitRunner } from './runner'
import type { GitStatistics } from './statistics'

/** File-tree paths are relative to the chosen folder, even below a Git root. */
export async function readTreeStatus(runner: GitRunner, statistics: GitStatistics, cwd: string): Promise<GitChange[]> {
  const top = await runner.run(cwd, ['rev-parse', '--show-toplevel'], { accept: [128] })
  if (top.code !== 0) throw new GitFailure('not-repository')
  const root = await realpath(trimLine(top.stdout))
  const folder = relative(root, cwd).split(sep).join('/')
  const prefix = folder ? `${folder}/` : ''
  const paths = folder ? [folder] : []
  // This read starts on opening the tree. Override repository-configured
  // clean filters and fsmonitor so inspecting it does not run their helpers.
  const filterKeys = await runner.run(root, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$'], { accept: [1], strictUtf8: true })
  const config = ['-c', 'core.fsmonitor=false', '-c', 'diff.autoRefreshIndex=false', '-c', 'diff.ignoreSubmodules=dirty']
  for (const key of new Set(filterKeys.stdout.split('\0').filter(Boolean))) {
    config.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`)
  }
  const status = await runner.run(root, [...config, 'status', '--porcelain=v2', '--untracked-files=all', '--no-renames', '--ignore-submodules=dirty', '-z', '--', ...paths], { strictUtf8: true })
  const { files } = parseStatus(status.stdout)
  if (files.length > MAX_FILES) throw new GitFailure('output-limit')
  const visible = files.filter(file => file.path.startsWith(prefix) && !file.path.slice(prefix.length).split('/').some(name => name === '.git' || name === '.DS_Store'))
  if (!visible.length) return []
  // Counts are optional. A changing checkout or an oversized numstat result
  // can still report the status from the completed porcelain read.
  const counted = await statistics.files({ root, files: visible }, { config, paths }).catch(() => visible)
  return counted.map(file => ({ ...file, path: file.path.slice(prefix.length) }))
}
