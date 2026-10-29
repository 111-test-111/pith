import { getDocsPath, getExamplesPath, getReadmePath, type InlineExtension, type NormalizedBuildSystemPromptOptions } from '@earendil-works/pi-coding-agent'

/** Change only default presentation through the SDK's structured prompt API.
 * User/extension replacements remain authoritative; resource metadata stays intact. */
export function compactPromptOptions(options: NormalizedBuildSystemPromptOptions, activeTools: readonly string[] = options.selectedTools): void {
  if (options.customPrompt || options.forceSystemPrompt !== undefined) return
  if (!Object.hasOwn(options.sections, 'docs')) {
    options.sections.docs = [
      'Pi docs (only when asked about Pi, SDK, extensions, themes, skills, prompt templates, TUI, keybindings, models/providers, MCP, packages, environment or configuration):',
      `README: ${getReadmePath()}`,
      `Docs: ${getDocsPath()}`,
      `Examples: ${getExamplesPath()}`,
      'Read relevant Markdown and examples before implementing; read files completely and follow cross-references. Resolve docs/... and examples/... under these directories, not cwd.'
    ].join('\n')
  }
  // Earlier extensions may change the live loadout without editing options.
  // Let the SDK's default skill gate handle mismatched reader selections.
  if (Object.hasOwn(options.sections, 'skills') || !options.selectedTools.some(name => (name === 'read' || name === 'bash') && activeTools.includes(name))) return
  const skills = options.skills.filter(skill => !skill.disableModelInvocation)
  if (skills.length === 0) return
  options.sections.skills = [
    'Skills: JSON rows [name, description, absolute SKILL.md path]. Read skills whose descriptions match the task with read (or bash if unavailable) before use. Resolve relative references against the skill directory; use absolute paths in tool commands.',
    // Keep each row on one line and prevent metadata from closing XML sections.
    ...skills.map(skill => JSON.stringify([skill.name, skill.description, skill.filePath])
      .replace(/[<>&]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`))
  ].join('\n')
}

export function createPromptFormatExtension(): InlineExtension {
  return { name: 'pi-app-prompt-format', hidden: true, factory: pi => {
    pi.on('before_agent_start', event => compactPromptOptions(event.systemPromptOptions, pi.getActiveTools()))
  } }
}
