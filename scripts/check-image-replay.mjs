/** Offline real-SDK persistence and exact, private UI image replays. */
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rename, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { Resvg } from '@resvg/resvg-js'
import { SessionManager, buildSessionContext } from '@earendil-works/pi-coding-agent'
import { createPlanFixture, planRepoRoot } from './lib/plan-fixture.mjs'

const temporary = await mkdtemp(join(tmpdir(), 'pith-image-replay-check-'))
let fixture, cold
try {
  const module = join(temporary, 'check.mjs')
  await build({ stdin: { contents: `export * from './src/shared/image-replay';
export {parsePresentResult} from './src/shared/present';
export {capturePresentedImage,hydrateImagePresentations,imagePresentationDetails,presentedGeneration,imageReplayRecords} from './src/main/pi/image-replay';
export {uncoveredWrites} from './src/main/rewind/coverage';
export {collectImageReplay} from './src/main/library/extract';`, resolveDir: planRepoRoot },
    outfile: module, bundle: true, platform: 'node', format: 'esm' })
  const api = await import(pathToFileURL(module).href)
  fixture = await createPlanFixture()
  await fixture.managed.lifecyclePromise
  const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="blue"/></svg>').render().asPng()
  await writeFile(join(fixture.project, 'reference.png'), png)
  const runtime = await fixture.app.runtime()
  const modelOfType = runtime.getModelOfType.bind(runtime)
  runtime.getAuth = async () => undefined
  runtime.getModelOfType = (type, provider, id) => type === 'image'
    ? { type, provider, id, api: 'openrouter-native-images' } : modelOfType(type, provider, id)
  const billed = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.014 } }
  const requests = []
  let mode = 'success', releaseProvider
  runtime.generateImages = async (model, context, options) => {
    requests.push({ model: structuredClone(model), input: structuredClone(context.input), parameters: structuredClone(options.metadata.openrouterImage) })
    if (mode === 'hold') await new Promise(resolve => { releaseProvider = resolve })
    return { ...model, output: mode === 'failure' ? [] : Array.from({ length: options.metadata.openrouterImage.n ?? 1 }, () => ({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' })),
      stopReason: mode === 'failure' ? 'error' : 'stop', ...(mode === 'failure' ? { errorMessage: 'Fixture generation failure' } : {}),
      usage: billed, timestamp: Date.now() }
  }
  const original = { action: 'edit', prompt: 'Blue sailboats\nPreserve the reference colors exactly.', model: 'fixture/image', protocol: 'native',
    input_images: ['reference.png'], n: 2, resolution: '2K', aspect_ratio: '4:3', size: '2048x1536', quality: 'high',
    output_format: 'png', background: 'opaque', output_compression: 80, seed: 35, allow_fallbacks: false,
    require_parameters: true, data_collection: 'deny', only: ['fixture-provider'], order: ['fixture-provider'], ignore: ['other'], output_path: 'images/' }
  fixture.setRespond(index => index === 1
    ? [{ type: 'toolCall', id: 'original-image', name: 'image', arguments: original }]
    : index === 2 ? [{ type: 'toolCall', id: 'deliver-images', name: 'present', arguments: { files: fixture.session.messages
      .find(message => message.role === 'toolResult' && message.toolCallId === 'original-image').details.files.map(file => ({ path: file.path }))
      .concat({ path: 'reference.png', description: 'Ordinary source image' }) } }]
      : [{ type: 'text', text: 'Delivered.' }])
  await fixture.session.prompt('Generate and present two images.')
  const generated = fixture.session.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'original-image')
  assert(!generated.isError)
  const recorded = fixture.manager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === api.IMAGE_GENERATION_ENTRY)
    .map(entry => api.parseImageGenerationRecord(entry.data)).find(record => record.id === 'original-image')
  assert.equal(recorded.fileHashes[generated.details.files[0].path], createHash('sha256').update(png).digest('hex'), 'committed image identity is saved privately at generation time')
  assert(!JSON.stringify(generated.details).includes('fileHashes'), 'file fingerprints never enter public tool results')
  const delivered = fixture.session.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'deliver-images')
  const files = api.parsePresentResult(delivered.details).files
  assert.equal(files.length, 3)
  assert.equal(files.filter(file => file.generation).length, 2, 'only files with actual image receipts receive the generated display')
  assert(!files[2].generation, 'a regular PNG input keeps the ordinary presentation')
  assert(files.slice(0, 2).every(file => !/fixture|\d{4}-\d{2}-\d{2}/.test(basename(file.path))), 'batch filenames are short prompt names without model/date suffixes')
  const request = { sessionPath: fixture.managed.path, generationId: files[0].generation.id, path: files[0].path }
  const beforeContext = JSON.stringify(buildSessionContext(fixture.manager.getBranch()).messages)
  assert(!beforeContext.includes(api.IMAGE_GENERATION_ENTRY))
  assert(!JSON.stringify(delivered.content).includes('generationId'), 'presentation prose contains no replay metadata')
  assert(!fixture.requests.at(-1).messages.some(message => message.role === 'toolResult' && message.details?.files?.some(file => file.generation)), 'generated presentation metadata never enters model requests')
  assert.deepEqual(api.presentedGeneration(fixture.manager, request.generationId, request.path).arguments, original)
  const historyCount = fixture.session.messages.length, llmCount = fixture.requests.length
  mode = 'hold'
  const retry = fixture.app.retryPresentedImage(request)
  for (let attempt = 0; attempt < 100 && !releaseProvider; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert(releaseProvider, 'a paid request begins through the app image transport')
  assert.equal(fixture.app.imageReplays(request.sessionPath).items.at(-1).status, 'generating')
  await assert.rejects(fixture.app.retryPresentedImage(request), /busy/)
  await assert.rejects(fixture.app.reloadSession(request.sessionPath), /running/)
  assert.throws(() => fixture.app.setSessionSandboxMode(request.sessionPath, 'read-only'), /busy/, 'file permissions cannot change under a paid retry')
  assert(!(await fixture.app.setSessionMode({ sessionPath: request.sessionPath, mode: 'plan' })).ok, 'mode transitions cannot race the UI file effect')
  assert.equal(requests.length, 2, 'a duplicate click does not send a duplicate provider request')
  assert.deepEqual(requests[1].parameters, { ...requests[0].parameters, n: 1 }, 'every generation/routing parameter remains identical except n=1')
  assert.deepEqual(requests[1].input, requests[0].input, 'prompt text and edit reference bytes remain identical')
  releaseProvider(); await retry
  const completed = fixture.app.imageReplays(request.sessionPath).items.at(-1)
  assert.equal(fixture.app.imageReplays(request.sessionPath).items.length, 1, 'queued/generating/complete updates form one attempt')
  assert.equal(completed.status, 'complete')
  assert.equal(completed.result.files.length, 1)
  assert.notEqual(completed.result.files[0].path, request.path, 'the new variant never replaces the delivered original')
  assert.deepEqual(await readFile(completed.result.files[0].path), png)
  assert.equal(fixture.session.messages.length, historyCount, 'no user, assistant or tool message is inserted for a UI retry')
  assert.equal(fixture.requests.length, llmCount, 'a UI retry never asks an LLM to rewrite the request')
  assert.equal(JSON.stringify(buildSessionContext(fixture.manager.getBranch()).messages), beforeContext, 'all replay arguments/results/status stay outside model context')
  assert.equal(fixture.session.getSessionStats().cost, billed.cost.total * 2, 'billing is retained exactly once through standalone SDK usage')
  const disk = SessionManager.open(request.sessionPath)
  const privateResult = disk.getBranch().filter(entry => entry.type === 'custom' && entry.customType === api.IMAGE_REPLAY_ENTRY).at(-1)
  assert.equal(api.parseImageReplayRecord(privateResult.data).result.files[0].path, completed.result.files[0].path)
  const library = api.collectImageReplay({ id: fixture.session.sessionId, path: request.sessionPath, cwd: fixture.project, title: '' }, privateResult.id, privateResult.data)
  assert(library.some(item => item.originalPath === completed.result.files[0].path), 'history collection retains the retry as a generated image')
  const uncovered = await api.uncoveredWrites(disk.getBranch(), fixture.project, fixture.project, null, [{ path: 'images', reason: 'ignored' }])
  assert(uncovered.some(item => item.path === completed.result.files[0].path), 'private committed writes remain explicit Rewind coverage evidence')

  // A new manager restores presentation and replay from disk, not a renderer cache.
  await fixture.app.dispose()
  cold = new fixture.app.constructor(() => {}, error => { throw new Error(error) })
  cold.runtime = async () => runtime
  await cold.openSession(request.sessionPath, fixture.project)
  const managed = cold.sessions.get(request.sessionPath)
  await managed.lifecyclePromise
  assert.equal(cold.imageReplays(request.sessionPath).items.at(-1).result.files[0].path, completed.result.files[0].path)
  assert(api.parsePresentResult(managed.session.sessionManager.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === 'deliver-images').message.details).files[0].generation)
  mode = 'success'
  await cold.retryPresentedImage(request)
  assert.equal(requests.length, 3)
  assert.deepEqual(requests[2], requests[1], 'cold replay preserves exact parameters and inputs')
  const successes = cold.imageReplays(request.sessionPath).items
  assert.equal(successes.length, 2, 'every repeated retry has its own history record')
  assert.equal(successes[0].id, completed.id, 'an older retry is never replaced by the newest one')
  assert.notEqual(successes[1].result.files[0].path, successes[0].result.files[0].path)
  assert.deepEqual(await readFile(request.path), png, 'the original remains available after multiple retries')
  assert.deepEqual(api.imageReplayRecords(SessionManager.open(request.sessionPath)), successes, 'all completed attempts survive a cold history read')
  await assert.rejects(cold.retryPresentedImage({ ...request, restoreId: 'unknown-attempt' }), /unavailable/)
  const coldContext = JSON.stringify(buildSessionContext(managed.session.sessionManager.getBranch()).messages)
  assert.equal(coldContext, beforeContext, 'cold replay remains invisible to the model')
  const requestCount = requests.length
  await assert.rejects(cold.retryPresentedImage({ ...request, path: files[2].path }), /unavailable/)
  await cold.setSessionSandboxMode(request.sessionPath, 'read-only')
  await cold.retryPresentedImage(request)
  assert.equal(requests.length, requestCount, 'file policy rejects before sending another provider request')
  await cold.setSessionSandboxMode(request.sessionPath, 'workspace-write')
  assert((await cold.setSessionMode({ sessionPath: request.sessionPath, mode: 'plan' })).ok)
  await assert.rejects(cold.retryPresentedImage(request), /plan-mode/)
  assert.equal(requests.length, requestCount)
  assert((await cold.setSessionMode({ sessionPath: request.sessionPath, mode: 'normal' })).ok)
  mode = 'failure'
  await cold.retryPresentedImage(request)
  const failed = cold.imageReplays(request.sessionPath).items.at(-1)
  assert.equal(failed.status, 'error')
  assert.equal(failed.result.files.length, 0)
  assert(!failed.cancelled, 'a provider failure is not a manual stop')
  assert(failed.error.includes('Fixture generation failure'))
  const restoredFailure = api.imageReplayRecords(SessionManager.open(request.sessionPath)).at(-1)
  assert.equal(restoredFailure.error, failed.error, 'failed attempt diagnostics survive disk restoration')
  assert(!restoredFailure.cancelled)
  mode = 'hold'; releaseProvider = undefined
  const cancelled = cold.retryPresentedImage(request)
  for (let attempt = 0; attempt < 100 && !releaseProvider; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert(releaseProvider)
  cold.cancelImageReplay(request.sessionPath, cold.imageReplays(request.sessionPath).items.at(-1).id)
  releaseProvider(); await cancelled
  assert.equal(cold.imageReplays(request.sessionPath).items.at(-1).status, 'error')
  assert.equal(cold.imageReplays(request.sessionPath).items.at(-1).result.files.length, 0, 'a provider ignoring cancellation cannot save late bytes')
  assert(cold.imageReplays(request.sessionPath).items.at(-1).cancelled, 'manual stop is an explicit receipt fact')
  assert(cold.imageReplays(request.sessionPath).items.at(-1).previousResult.files.length, 'manual stop can restore the last successful receipt even after an earlier failure')
  const restoredCancellation = api.imageReplayRecords(SessionManager.open(request.sessionPath)).at(-1)
  assert(restoredCancellation.cancelled, 'cancellation remains distinct from failure after restart')
  assert.equal(restoredCancellation.previousResult.files[0].path, cold.imageReplays(request.sessionPath).items.at(-1).previousResult.files[0].path)
  const attemptCount = cold.imageReplays(request.sessionPath).items.length
  mode = 'hold'; releaseProvider = undefined
  const stoppedFromOriginal = cold.retryPresentedImage({ ...request, restoreId: null })
  for (let attempt = 0; attempt < 100 && !releaseProvider; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert(releaseProvider)
  cold.cancelImageReplay(request.sessionPath, cold.imageReplays(request.sessionPath).items.at(-1).id)
  releaseProvider(); await stoppedFromOriginal
  const stopOriginalRecord = api.imageReplayRecords(SessionManager.open(request.sessionPath)).at(-1)
  assert(stopOriginalRecord.cancelled && stopOriginalRecord.restoreId === null)
  assert(!stopOriginalRecord.previousResult, 'stopping a retry of the selected original restores the original instead of the newest variant')
  assert.equal(cold.imageReplays(request.sessionPath).items.length, attemptCount + 1, 'cancelled attempts also remain in history')
  mode = 'hold'; releaseProvider = undefined
  const stoppedFromOlder = cold.retryPresentedImage({ ...request, restoreId: completed.id })
  for (let attempt = 0; attempt < 100 && !releaseProvider; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert(releaseProvider)
  cold.cancelImageReplay(request.sessionPath, cold.imageReplays(request.sessionPath).items.at(-1).id)
  releaseProvider(); await stoppedFromOlder
  const stopOlderRecord = api.imageReplayRecords(SessionManager.open(request.sessionPath)).at(-1)
  assert.equal(stopOlderRecord.previousResult.files[0].path, completed.result.files[0].path, 'stopping restores the selected older version')
  assert.equal(cold.imageReplays(request.sessionPath).items.length, attemptCount + 2)
  assert.equal(JSON.stringify(buildSessionContext(managed.session.sessionManager.getBranch()).messages), beforeContext)
  await managed.session.prompt('Describe the delivered image.')
  const nextRequest = JSON.stringify(fixture.requests.at(-1))
  assert(!nextRequest.includes(completed.result.files[0].path) && !nextRequest.includes(completed.id), 'future model turns never learn private retry files or identity')
  assert(!fixture.requests.at(-1).messages.some(message => message.role === 'toolResult' && message.details?.files?.some(file => file.generation)), 'cold continuation omits presentation metadata while disk receipts retain it')
  const leaf = managed.session.sessionManager.getLeafId()
  const opening = managed.session.sessionManager.getBranch().find(entry => entry.type === 'message' && entry.message.role === 'user')
  managed.session.sessionManager.branch(opening.id)
  await assert.rejects(cold.retryPresentedImage(request), /unavailable/, 'an abandoned presentation cannot authorize a retry')
  managed.session.sessionManager.branch(leaf)
  const pending = { ...cold.imageReplays(request.sessionPath).items.at(-1), id: 'interrupted-retry', status: 'generating', endedAt: undefined, error: undefined, result: undefined, cancelled: undefined }
  managed.session.sessionManager.appendCustomEntry(api.IMAGE_REPLAY_ENTRY, pending)
  assert(cold.imageReplays(request.sessionPath).items.at(-1).interrupted, 'a stale running entry is interrupted without automatically replaying a paid request')

  // A pre-feature session generated a batch, moved each output, then delivered
  // ordinary file receipts. Restore from exact bytes without changing messages.
  const green = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="green"/></svg>').render().asPng()
  const oldPaths = ['legacy-blue.png', 'legacy-green.png'].map(name => join(fixture.project, name))
  const newPaths = ['blue-poster.png', 'green-poster.png'].map(name => join(fixture.project, name))
  await writeFile(oldPaths[0], png); await writeFile(oldPaths[1], green)
  const legacy = SessionManager.create(fixture.project, join(temporary, 'legacy'))
  legacy.appendMessage({ role: 'user', content: 'Generate two posters.', timestamp: 1 })
  const assistant = (id, name, args, timestamp) => ({ ...fixture.session.messages.find(message => message.role === 'assistant'),
    content: [{ type: 'toolCall', id, name, arguments: args }], timestamp, stopReason: 'toolUse' })
  legacy.appendMessage(assistant('legacy-image', 'image', original, 2))
  legacy.appendMessage({ ...generated, toolCallId: 'legacy-image', timestamp: 3,
    content: [{ type: 'text', text: 'Generated two posters.' }, ...[png, green].map(bytes => ({ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }))],
    details: { ...generated.details, files: oldPaths.map((path, index) => ({ ...generated.details.files[index], path, size: [png, green][index].length })) } })
  await rename(oldPaths[0], newPaths[0]); await rename(oldPaths[1], newPaths[1])
  const ordinaryPath = join(fixture.project, 'same-size.png'), differentBytes = Buffer.from(png)
  differentBytes[differentBytes.length - 1] ^= 1
  await writeFile(ordinaryPath, differentBytes)
  assert.equal(await api.capturePresentedImage(legacy, ordinaryPath, png.length), undefined, 'equal size and extension cannot impersonate a generated image')
  const legacyFiles = newPaths.map((path, index) => ({ path, size: [png, green][index].length })).concat({ path: ordinaryPath, size: png.length })
  legacy.appendMessage(assistant('legacy-present', 'present', { files: legacyFiles.map(file => ({ path: file.path })) }, 4))
  const legacyEntry = legacy.appendMessage({ role: 'toolResult', toolCallId: 'legacy-present', toolName: 'present', content: [{ type: 'text', text: 'Presented posters.' }],
    details: { kind: 'pith-present-v1', files: legacyFiles }, isError: false, timestamp: 5 })
  const legacyContext = JSON.stringify(buildSessionContext(legacy.getBranch()).messages)
  const restoredView = await cold.openSession(legacy.getSessionFile(), fixture.project)
  const legacyManaged = cold.sessions.get(legacy.getSessionFile())
  await legacyManaged.lifecyclePromise
  const restoredFiles = api.parsePresentResult(restoredView.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'legacy-present').details).files
  assert.equal(restoredFiles.filter(file => file.generation).length, 2, 'cold opening backfills both renamed images in the display transcript')
  assert(!restoredFiles[2].generation, 'historical backfill keeps unmatched ordinary images as file cards')
  assert(restoredFiles.slice(0, 2).every(file => file.generation.result.files.some(image => image.path === file.path)), 'each batch delivery retains its own verified renamed path')
  let legacyDisk = SessionManager.open(legacy.getSessionFile())
  assert(!legacyDisk.getBranch().find(entry => entry.id === legacyEntry).message.details.files.some(file => file.generation), 'backfill never edits the original SDK result')
  assert.equal(JSON.stringify(buildSessionContext(legacyDisk.getBranch()).messages), legacyContext, 'historical repair remains invisible to model context')
  const repairedCount = legacyDisk.getBranch().filter(entry => entry.type === 'custom' && entry.customType === api.IMAGE_PRESENTATION_ENTRY).length
  await cold.reloadSession(legacy.getSessionFile())
  legacyDisk = SessionManager.open(legacy.getSessionFile())
  assert.equal(legacyDisk.getBranch().filter(entry => entry.type === 'custom' && entry.customType === api.IMAGE_PRESENTATION_ENTRY).length, repairedCount, 'reloading a recovered presentation is idempotent')
  assert.equal(api.imagePresentationDetails(legacyDisk).get(legacyEntry).files.filter(file => file.generation).length, 2, 'recovery survives a fresh disk read')
  assert.deepEqual(api.presentedGeneration(legacyDisk, 'legacy-image', newPaths[0]).arguments, original, 'renaming never changes frozen replay parameters')
  mode = 'success'
  await cold.retryPresentedImage({ sessionPath: legacy.getSessionFile(), generationId: 'legacy-image', path: newPaths[0] })
  assert.deepEqual(requests.at(-1), requests[1], 'a renamed legacy delivery replays the exact original request with n=1')
  assert.deepEqual(await readFile(newPaths[0]), png, 'replaying a recovered image retains its renamed original')
  assert.equal(JSON.stringify(buildSessionContext(legacyManaged.session.sessionManager.getBranch()).messages), legacyContext)

  // New generations need no inline pixels to recover a rename: their private
  // fingerprint already proves byte identity, including SVG original bytes.
  const newPath = join(fixture.project, 'blue-sailboats.png')
  await rename(generated.details.files[0].path, newPath)
  const renamedGeneration = await api.capturePresentedImage(managed.session.sessionManager, newPath, png.length)
  assert.equal(renamedGeneration.id, 'original-image')
  assert(renamedGeneration.result.files.some(file => file.path === newPath))
  assert.deepEqual(api.parseImageGenerationRecord(managed.session.sessionManager.getBranch().findLast(entry => entry.type === 'custom' && entry.customType === api.IMAGE_GENERATION_ENTRY).data).arguments, original)
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="blue"/></svg>')
  const oldVector = join(fixture.project, 'old-vector.svg'), newVector = join(fixture.project, 'blue-rectangle.svg')
  await writeFile(newVector, svg)
  const vectors = SessionManager.inMemory(fixture.project)
  vectors.appendCustomEntry(api.IMAGE_GENERATION_ENTRY, { version: 1, id: 'vector-image', arguments: original,
    result: { ...generated.details, files: [{ path: oldVector, mimeType: 'image/svg+xml', size: svg.length, width: 4, height: 3 }] },
    fileHashes: { [oldVector]: createHash('sha256').update(svg).digest('hex') } })
  assert.equal((await api.capturePresentedImage(vectors, newVector, svg.length)).result.files[0].path, newVector, 'private original-byte fingerprints also recover SVG without raster previews')
  console.log('PASS: generated/ordinary provenance, verified renames, private historical backfill, exact n=1 replay, billing, cancellation, admission, library and Rewind receipts')
} finally {
  await cold?.dispose()
  await fixture?.close()
  await rm(temporary, { recursive: true, force: true })
}
