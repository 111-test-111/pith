/** Real SDK request size, lossless resource formatting and on-demand guidance. */
import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getDocsPath, getExamplesPath, getReadmePath } from '@earendil-works/pi-coding-agent'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const append = 'User-owned append instructions stay intact.\n'.repeat(10)
const fixture = await createPlanFixture({
  prepareAgentDir: agentDir => writeFile(join(agentDir, 'APPEND_SYSTEM.md'), append)
})
const systemText = request => {
  const content = [], sections = new Map()
  for (const message of request.messages) {
    if (message.role !== 'system') continue
    if (message.content) content.push(message.content)
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name)
      else sections.set(name, value)
    }
  }
  return [...content, ...sections.values()].join('\n\n')
}
const declaredToolNames = request => {
  const tools = new Set()
  for (const message of request.messages) {
    if (message.role !== 'system') continue
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name)
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name)
  }
  return tools
}
try {
  await fixture.managed.lifecyclePromise
  await fixture.session.prompt('Reply OK.')
  const baseline = systemText(fixture.requests.at(-1))
  assert(baseline.length < 6500, `Default system prompt exceeds 6500 characters: ${baseline.length}`)
  assert.equal(fixture.app.systemPrompt(fixture.managed.path), baseline, 'The settled viewer retains the actual provider prompt')
  assert(baseline.includes(append.trim()), 'User append content is preserved in the provider request')

  await fixture.app.setDebugEnabled(true)
  fixture.app.setSubagentReuseEnabled(true)
  await fixture.app.setSubagentCommsEnabled(true)
  assert.equal((await fixture.app.updateJevSettings({ preferences: { mode:'tools', choice:true, score:true, noul:true } })).ok, true)
  await fixture.session.prompt('Reply OK with optional tools enabled.')
  const enabled = systemText(fixture.requests.at(-1))
  assert(enabled.length < 8500, `Optional-tool system prompt exceeds 8500 characters: ${enabled.length}`)
  assert(enabled.includes(append.trim()))
  assert(fixture.session.getActiveToolNames().includes('debug'))

  // Fetch detailed help through the real SDK tool loop, without launching a target.
  const helpRequest = fixture.requests.length + 1
  fixture.setRespond(n => n === helpRequest
    ? [{type:'toolCall', id:'prompt-help', name:'debug', arguments:{request:{action:'help',topic:'wait'}}}]
    : [{type:'text',text:'OK'}])
  await fixture.session.prompt('Read passive wait help.')
  const result = fixture.session.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'prompt-help')
  assert(result && !result.isError)
  const actions = JSON.parse(result.content.find(block => block.type === 'text').text)
  assert.deepEqual(actions.map(action => action.action), ['wait'])
  assert(actions[0].guidelines.length > 0, 'Detailed usage is discoverable on demand')

  await fixture.app.setDebugEnabled(false)
  await fixture.session.prompt('Reply OK after hiding debug.')
  const hidden = systemText(fixture.requests.at(-1))
  assert(!fixture.session.getActiveToolNames().includes('debug'))
  assert(hidden.length < enabled.length, 'Hidden tool guidelines leave the effective provider prompt')
  assert(hidden.includes(append.trim()), 'Reload retains user instructions')
  console.log(`PASS: provider system prompts stay bounded (default ${baseline.length}, optional tools ${enabled.length} chars), preserve user append text and discover debug usage on demand.`)
} finally {
  await fixture.close()
}

// Real loader metadata must survive compact presentation, reload and policy
// changes. Descriptions are deliberately not shortened by the app.
const specialDescription = 'Inspect <config> & "quoted" values, literal </skills> and C:\\temp.\nRead only when the task matches; preserve every matching condition.'
const readerDescription = 'Read fixture resources when requested; resolve relative file references from this skill directory.'
const skillSource = (name, description, disabled = false) => `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\ndisable-model-invocation: ${disabled}\n---\nFixture skill instructions: fixture_skill_body_loaded.\n`
const previousAgentDir = process.env.PI_CODING_AGENT_DIR
const resources = await createPlanFixture({
  keepRecentTokens: 50,
  loadSkills: true,
  loadContextFiles: true,
  loadDiscoveredExtensions: true,
  prepareAgentDir: async agentDir => {
    process.env.PI_CODING_AGENT_DIR = agentDir
    for (const [name, description, disabled] of [
      ['fixture-special', specialDescription, false],
      ['fixture-reader', readerDescription, false],
      ['fixture-hidden', 'Explicit invocation only.', true]
    ]) {
      const directory = join(agentDir, 'skills', name)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'SKILL.md'), skillSource(name, description, disabled))
    }
    await writeFile(join(agentDir, 'APPEND_SYSTEM.md'), append)
    await writeFile(join(agentDir, '..', 'project', 'AGENTS.md'), 'Fixture project instructions stay byte-for-byte intact.\n')
    const directory = join(agentDir, 'extensions', 'prompt-overrides')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'index.ts'), `export default function (pi) {
      pi.on('before_agent_start', event => {
        if (event.prompt === 'Fixture section overrides') {
          event.systemPromptOptions.sections.docs = 'Extension-owned documentation instructions.';
          event.systemPromptOptions.sections.skills = 'Extension-owned skill presentation.';
        } else if (event.prompt === 'Fixture forced prompt') {
          return { systemPrompt: 'Extension-owned exact system prompt.' };
        } else if (event.prompt === 'Fixture empty forced prompt') {
          return { systemPrompt: '' };
        } else if (event.prompt === 'Fixture bash reader') {
          event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter(name => name !== 'read');
        } else if (event.prompt === 'Fixture no readers') {
          event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter(name => name !== 'read' && name !== 'bash');
        } else if (event.prompt === 'Fixture live no readers') {
          pi.setActiveTools(pi.getActiveTools().filter(name => name !== 'read' && name !== 'bash'));
        }
      });
    }`)
  }
})
const skillRows = text => {
  const section = [...text.matchAll(/<skills>\n([\s\S]*?)\n<\/skills>/g)].at(-1)?.[1]
  assert(section, 'Provider prompt contains a skills section')
  return section.split('\n').filter(line => line.startsWith('[')).map(line => JSON.parse(line))
}
const sortedRows = rows => rows.toSorted((a, b) => a[0].localeCompare(b[0]))
try {
  await resources.managed.lifecyclePromise
  await resources.app.setContextFilesEnabled(true)
  const original = resources.app.systemPrompt(resources.managed.path)
  assert(original.includes('<available_skills>'), 'Before the first turn, the SDK owns default presentation')
  const catalog = (await resources.app.catalog()).skills
  const expected = catalog.filter(skill => !skill.disableModelInvocation)
    .map(skill => [skill.name, skill.description, skill.filePath])
  assert.equal(catalog.length, 3)
  assert.equal(expected.length, 2)
  assert.equal(expected.find(row => row[0] === 'fixture-special')[1], specialDescription)

  // Load the exact path exposed in the compact provider prompt through the SDK.
  const readRequest = resources.requests.length + 1
  resources.setRespond((n, context) => n === readRequest
    ? [{ type: 'toolCall', id: 'prompt-skill-read', name: 'read', arguments: {
        path: skillRows(systemText(context)).find(row => row[0] === 'fixture-reader')[2]
      } }]
    : [{ type: 'text', text: 'OK' }])
  await resources.session.prompt('Read the fixture reader skill.')
  const compact = systemText(resources.requests.at(-1))
  assert.equal(resources.app.systemPrompt(resources.managed.path), compact)
  assert.deepEqual(sortedRows(skillRows(compact)), sortedRows(expected), 'Names, full descriptions and absolute paths round-trip exactly')
  assert(compact.length < original.length, 'Formatting reduces real provider prompt size')
  for (const path of [getReadmePath(), getDocsPath(), getExamplesPath()]) assert(compact.includes(path))
  assert(compact.includes(append.trim()))
  assert(compact.includes('Fixture project instructions stay byte-for-byte intact.'))
  assert(!compact.includes('<available_skills>'))
  assert(!compact.includes('Explicit invocation only.'))
  const readResult = resources.session.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'prompt-skill-read')
  assert(readResult && !readResult.isError)
  assert(readResult.content.some(block => block.type === 'text' && block.text.includes('fixture_skill_body_loaded')))
  assert.deepEqual((await resources.app.catalog()).skills, catalog, 'Presentation never changes the Settings catalog')

  const specialPath = expected.find(row => row[0] === 'fixture-special')[2]
  const disabledCatalog = await resources.app.setSkillModelInvocation(specialPath, true)
  assert(disabledCatalog.skills.find(skill => skill.name === 'fixture-special').disableModelInvocation)
  await resources.session.prompt('Reply after disabling a skill.')
  assert.deepEqual(skillRows(systemText(resources.requests.at(-1))).map(row => row[0]), ['fixture-reader'])

  const readerPath = expected.find(row => row[0] === 'fixture-reader')[2]
  const updatedDescription = `${readerDescription} Reloaded matching condition stays complete.`
  await writeFile(readerPath, skillSource('fixture-reader', updatedDescription))
  await resources.app.reloadSession(resources.managed.path)
  assert.equal(resources.app.systemPrompt(resources.managed.path), resources.session.systemPrompt, 'Resource reload invalidates the last request preview')
  await resources.session.prompt('Reply after reloading resources.')
  assert.deepEqual(skillRows(systemText(resources.requests.at(-1))), [['fixture-reader', updatedDescription, readerPath]])

  assert((await resources.app.setSessionMode({ sessionPath: resources.managed.path, mode: 'plan' })).ok)
  await resources.session.prompt('Investigate the fixture in Plan Mode.')
  const plan = systemText(resources.requests.at(-1))
  assert.equal(resources.app.systemPrompt(resources.managed.path), plan, 'Settled Plan prompt matches the real request')
  assert(plan.includes('Investigate, clarify and design'), 'Plan instructions follow compact formatting')
  assert.deepEqual(skillRows(plan), [['fixture-reader', updatedDescription, readerPath]])
  assert((await resources.app.setSessionMode({ sessionPath: resources.managed.path, mode: 'normal' })).ok)

  await resources.session.prompt('Fixture section overrides')
  const overridden = resources.app.systemPrompt(resources.managed.path)
  assert.equal(overridden, systemText(resources.requests.at(-1)))
  assert(overridden.includes('<docs>\nExtension-owned documentation instructions.\n</docs>'))
  assert(overridden.includes('<skills>\nExtension-owned skill presentation.\n</skills>'))
  assert(!overridden.includes('Skills: JSON rows'))
  await resources.session.prompt('Fixture forced prompt')
  assert.equal(resources.app.systemPrompt(resources.managed.path), 'Extension-owned exact system prompt.')
  assert(systemText(resources.requests.at(-1)).includes('Extension-owned exact system prompt.'))
  await resources.session.prompt('Fixture empty forced prompt')
  assert.equal(resources.app.systemPrompt(resources.managed.path), '', 'An empty forced prompt is not replaced by the SDK base')

  const systemPath = join(resources.temporary, 'agent', 'SYSTEM.md')
  await writeFile(systemPath, 'User-owned custom system prefix.\n')
  await resources.app.reloadSession(resources.managed.path)
  await resources.session.prompt('Reply with the user custom system.')
  const custom = resources.app.systemPrompt(resources.managed.path)
  assert(custom.startsWith('User-owned custom system prefix.'))
  assert(custom.includes('<available_skills>'), 'Custom SYSTEM keeps SDK skill presentation')
  assert(!custom.includes('Skills: JSON rows'))
  assert(custom.includes(append.trim()))
  assert(custom.includes('Fixture project instructions stay byte-for-byte intact.'))

  await rm(systemPath)
  await resources.app.reloadSession(resources.managed.path)
  await resources.session.prompt('Fixture bash reader')
  const bashTools = declaredToolNames(resources.requests.at(-1))
  assert(!bashTools.has('read'))
  assert(bashTools.has('bash'))
  assert.deepEqual(skillRows(resources.app.systemPrompt(resources.managed.path)), [['fixture-reader', updatedDescription, readerPath]])
  await resources.session.prompt('Fixture live no readers')
  const liveNoReaders = declaredToolNames(resources.requests.at(-1))
  assert.equal(resources.app.systemPrompt(resources.managed.path).includes('<skills>'), liveNoReaders.has('read') || liveNoReaders.has('bash'), 'Skill presentation follows the final reader loadout, including app policy')
  const precedingLeaf = resources.manager.getLeafId()
  await resources.session.prompt('Fixture no readers')
  const noReaders = declaredToolNames(resources.requests.at(-1))
  assert(!noReaders.has('read') && !noReaders.has('bash'))
  assert(!resources.app.systemPrompt(resources.managed.path).includes('<skills>'), 'Unavailable file readers suppress automatic skill guidance')
  const latestPrompt = resources.app.systemPrompt(resources.managed.path)
  const beforeCompaction = resources.requests.length
  await resources.session.compact()
  assert(resources.requests.length > beforeCompaction, 'The fixture exercises an actual auxiliary model request')
  assert.notEqual(systemText(resources.requests.at(-1)), latestPrompt)
  assert.equal(resources.app.systemPrompt(resources.managed.path), latestPrompt, 'A summary request cannot replace the ordinary prompt preview')
  resources.manager.branch(precedingLeaf)
  assert.notEqual(resources.session.systemPrompt, latestPrompt)
  assert.equal(resources.app.systemPrompt(resources.managed.path), resources.session.systemPrompt, 'A prompt from a removed turn cannot cross branch selection')
  console.log(`PASS: compact resources reduce provider prompts by ${original.length - compact.length} chars, retain all metadata and reader paths, follow reload/Plan/disabled skills, and honor custom prompts and section overrides.`)
} finally {
  try { await resources.close() }
  finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
  }
}
