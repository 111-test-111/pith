/** Offline bundled-skill updates, real SDK discovery/reads and callable examples. */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { Check } from 'typebox/value'
import { Resvg } from '@resvg/resvg-js'
import { formatSkillsForPrompt, getAgentDir, loadSkillsFromDir } from '@earendil-works/pi-coding-agent'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'pith-image-skill-'))
let fixture
try {
  const module = join(temporary, 'skill.mjs')
  await build({
    stdin: { contents: `export { installImageSkill } from './src/main/pi/image-skill';
export { createImageTool } from './src/main/pi/image';
export { setDisableModelInvocation } from './src/main/pi/skill-frontmatter';`, resolveDir: repo },
    outfile: module, bundle: true, platform: 'node', format: 'esm',
    plugins: [{ name: 'dependencies', setup(builder) {
      builder.onResolve({ filter: /^@earendil-works\/pi-coding-agent$|^@resvg\/resvg-js$/ }, args => ({ path: fileURLToPath(import.meta.resolve(args.path)), external: true }))
    } }]
  })
  const { installImageSkill, createImageTool, setDisableModelInvocation } = await import(pathToFileURL(module).href)
  const bundled = join(repo, 'resources/skills/openrouter-image')
  const source = join(temporary, 'upstream')
  await cp(bundled, source, { recursive: true })
  const directory = join(temporary, 'profile skills', 'openrouter-image')
  const path = installImageSkill(source, directory)
  const files = ['SKILL.md', 'references/models.md', 'references/parameters.md']
  const original = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(join(source, file), 'utf8')])))
  for (const file of files) assert.equal(await readFile(join(directory, file), 'utf8'), original[file])
  const loaded = loadSkillsFromDir({ dir: dirname(directory), source: 'user' })
  assert.deepEqual(loaded.diagnostics, [])
  assert.equal(loaded.skills.length, 1, 'references and installation metadata are not extra skills')
  assert.equal(loaded.skills[0].filePath, path)
  assert.equal(loaded.skills[0].disableModelInvocation, false)

  // Shipped updates retain an actual Settings toggle and user-owned file edits.
  await writeFile(path, setDisableModelInvocation(original['SKILL.md'], true))
  const updated = `${original['SKILL.md']}\nUpstream revision for fixture.\n`
  await writeFile(join(source, 'SKILL.md'), updated)
  const localReference = `${original['references/models.md']}\nLocal reference note.\n`
  await writeFile(join(directory, 'references/models.md'), localReference)
  await writeFile(join(source, 'references/models.md'), `${original['references/models.md']}\nUpstream model change.\n`)
  const updatedParameters = `${original['references/parameters.md']}\nUpstream parameter change.\n`
  await writeFile(join(source, 'references/parameters.md'), updatedParameters)
  installImageSkill(source, directory)
  assert.equal(await readFile(path, 'utf8'), setDisableModelInvocation(updated, true))
  assert.equal(await readFile(join(directory, 'references/models.md'), 'utf8'), localReference)
  assert.equal(await readFile(join(directory, 'references/parameters.md'), 'utf8'), updatedParameters)
  const localSkill = `${await readFile(path, 'utf8')}\nLocal skill note.\n`
  await writeFile(path, localSkill)
  await writeFile(join(source, 'SKILL.md'), `${updated}\nAnother upstream revision.\n`)
  installImageSkill(source, directory)
  installImageSkill(source, directory)
  assert.equal(await readFile(path, 'utf8'), localSkill, 'updates/restarts preserve edited skill bodies')
  await writeFile(join(directory, '.bundled-hashes.json'), 'invalid baseline')
  installImageSkill(source, directory)
  assert.equal(await readFile(path, 'utf8'), localSkill, 'a lost baseline cannot replace local instructions')
  assert.equal(await readFile(join(directory, 'references/models.md'), 'utf8'), localReference)

  // Global discovery and the app's explicit path must resolve to one skill.
  let sdkDirectory
  let sdkPath
  fixture = await createPlanFixture({
    loadSkills: true,
    prepareAgentDir(agentDir) {
      sdkDirectory = join(agentDir, 'skills', 'openrouter-image')
      sdkPath = installImageSkill(bundled, sdkDirectory)
    },
    imageSkillPath: () => sdkPath
  })
  await fixture.managed.lifecyclePromise
  const catalog = await fixture.app.catalog()
  assert.equal(catalog.skills.length, 1, 'global discovery and explicit registration do not duplicate the skill')
  assert.equal(catalog.skills[0].filePath, sdkPath)
  assert.equal(fixture.app.readSkill(sdkPath).text, original['SKILL.md'])
  const image = fixture.session.getAllTools().find(tool => tool.name === 'image')
  assert(image, 'the skill accompanies the real app image tool')
  const declaredPath = JSON.parse(image.description.match(/ at ("(?:\\.|[^"\\])*")/)[1])
  assert.equal(declaredPath, sdkPath, 'the live tool points to its actual installed guidance')

  const reading = [sdkPath, join(sdkDirectory, 'references/models.md'), join(sdkDirectory, 'references/parameters.md')]
  fixture.setRespond(n => n <= reading.length
    ? [{ type: 'toolCall', id: `image-skill-read-${n}`, name: 'read', arguments: { path: reading[n - 1] } }]
    : [{ type: 'text', text: 'Guidance loaded.' }])
  await fixture.session.prompt('Read the image guidance and its references.')
  for (let n = 1; n <= reading.length; n++) {
    const result = fixture.session.messages.find(message => message.role === 'toolResult' && message.toolCallId === `image-skill-read-${n}`)
    assert(result && !result.isError)
    assert(result.content.some(block => block.type === 'text' && block.text.includes(original[files[n - 1]].trim())))
  }
  assert(fixture.requests.at(-1).messages.some(message => message.role === 'system' && JSON.stringify(message).includes(sdkPath)), 'actual provider prompt discovers the installed skill')
  await fixture.app.reloadSession(fixture.managed.path)
  assert.equal((await fixture.app.catalog()).skills[0].filePath, sdkPath)
  await fixture.app.setSkillModelInvocation(sdkPath, true)
  let skills = fixture.managed.resourceLoader.getSkills().skills
  assert(skills[0].disableModelInvocation)
  assert(!formatSkillsForPrompt(skills).includes(sdkPath))
  assert(fixture.session.getAllTools().find(tool => tool.name === 'image').description.includes(JSON.stringify(sdkPath)), 'mandatory direct read survives automatic-discovery opt-out')
  installImageSkill(bundled, sdkDirectory)
  await fixture.app.reloadSession(fixture.managed.path)
  assert((await fixture.app.catalog()).skills[0].disableModelInvocation, 'restart does not re-enable the preference')
  await fixture.app.setSkillModelInvocation(sdkPath, false)
  skills = fixture.managed.resourceLoader.getSkills().skills
  assert(formatSkillsForPrompt(skills).includes(sdkPath))

  // Complete documented calls validate with the live schema and reach the
  // transport with their controls intact. No real image/provider request occurs.
  const examples = [...original['references/parameters.md'].matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]))
  assert(examples.length > 0)
  const { validateToolArguments } = await import(new URL('../node_modules/@earendil-works/pi-ai/dist/index.js', import.meta.resolve('@earendil-works/pi-coding-agent')))
  const requests = []
  const runtime = {
    getAuth: async () => undefined,
    getModelOfType: (_type, provider, id) => ({ type: 'image', provider, id, api: 'openrouter-native-images' }),
    generateImages: async (model, context, options) => {
      requests.push({ model, context, options })
      return { ...model, output: [], stopReason: 'error', errorMessage: 'fixture stopped before generation', timestamp: Date.now() }
    }
  }
  const cwd = join(temporary, 'example workspace')
  await mkdir(join(cwd, 'images'), { recursive: true })
  // A valid fixed reference, independent of the provider failure fixture.
  const reference = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="red"/></svg>').render().asPng()
  await writeFile(join(cwd, 'images/robot-source.png'), reference)
  const tool = createImageTool({ cwd, runtime, canStart: () => true, getMode: () => 'workspace-write' })
  assert(tool.description.includes(JSON.stringify(join(getAgentDir(), 'skills', 'openrouter-image', 'SKILL.md'))), 'standalone tools also guide models to the global Pi skill')
  for (const example of examples) {
    assert(Check(tool.parameters, example), 'documented calls match the TypeBox schema')
    assert.deepEqual(validateToolArguments(tool, { id: 'example', name: 'image', arguments: example }), example)
    const before = requests.length
    const result = await tool.execute('example', { ...example, protocol: 'native' })
    assert(result.isError)
    assert.equal(requests.length, before + 1, 'the valid example reaches the intended transport once')
    const request = requests.at(-1)
    assert.equal(request.model.id, example.model)
    assert.equal(request.context.input[0].text, example.prompt)
    const params = request.options.metadata.openrouterImage
    for (const [argument, field] of Object.entries({ resolution: 'resolution', aspect_ratio: 'aspectRatio', size: 'size', quality: 'quality', output_format: 'outputFormat', background: 'background', n: 'n' })) {
      assert.equal(params[field], example[argument])
    }
    assert.equal(params.routing?.requireParameters, example.require_parameters)
    assert.deepEqual(params.routing?.only, example.only)
    assert.equal(request.context.input.filter(block => block.type === 'image').length, example.input_images?.length ?? 0)
  }
  console.log('PASS: global skill installation, preserved edits/preferences, deduplicated SDK discovery/read/reload and documented native calls')
} finally {
  await fixture?.close()
  await rm(temporary, { recursive: true, force: true })
}
