import { bundledLanguages, bundledLanguagesAlias } from 'shiki'
import type { AgentCodeLanguage } from '@/components/agents/agent-code'

const extensions: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  md: 'markdown', mdown: 'markdown', mkd: 'markdown', mdx: 'mdx', py: 'python', rb: 'ruby', rs: 'rust',
  sh: 'bash', zsh: 'bash', yml: 'yaml', h: 'c', hpp: 'cpp', cc: 'cpp', cxx: 'cpp', cs: 'csharp', kt: 'kotlin',
  gql: 'graphql', txt: 'text', lock: 'text', env: 'dotenv', conf: 'ini', jsonl: 'json', ndjson: 'json'
}
export function codeLanguage(language?: string): AgentCodeLanguage {
  const value = (language ?? '').toLowerCase().split(/[\s:,]/)[0]
  const lang = extensions[value] ?? ({ shell: 'bash', console: 'bash', plain: 'text', plaintext: 'text' } as Record<string, string>)[value] ?? value
  return lang in bundledLanguages || lang in bundledLanguagesAlias ? lang as AgentCodeLanguage : 'text'
}
export function fileLanguage(path: string): AgentCodeLanguage {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? ''
  if (/^dockerfile(?:\.|$)/.test(name)) return 'dockerfile'
  if (/^(makefile|gnumakefile)$/.test(name)) return 'makefile'
  if (/^\.env(?:\.|$)/.test(name)) return 'dotenv'
  if (['.gitignore', '.dockerignore', '.ignore'].includes(name)) return 'ini'
  return codeLanguage(name.split('.').at(-1))
}
