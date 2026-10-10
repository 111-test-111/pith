/** Offline SDK 1.0 provider catalog and complete OAuth login bridge check. */
import assert from 'node:assert/strict'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const f = await createPlanFixture()
try {
  await f.managed.lifecyclePromise
  const runtime = await f.app.runtime()
  const openai = runtime.getProvider('openai')
  const legacy = runtime.getProvider('openai-codex')
  const radius = runtime.getProvider('radius')
  assert(openai, 'the current OpenAI provider is registered')
  assert(legacy, 'existing OpenAI Codex sessions remain selectable')
  assert(radius?.auth?.oauth, 'Radius exposes the SDK account sign-in')
  assert.equal(openai.auth?.oauth?.loginLabel, 'Sign in with ChatGPT')
  assert(openai.getModels().some(model => model.id === 'gpt-6.1-sol'))
  assert(legacy.getModels().some(model => model.id === 'gpt-6.1-sol'))

  runtime.checkAuth = async () => undefined // isolated fixture: never consult real credentials
  const providerRows = await f.app.providers()
  const openaiRow = providerRows.find(row => row.id === 'openai')
  const radiusRow = providerRows.find(row => row.id === 'radius')
  assert(openaiRow?.authTypes.includes('oauth') && openaiRow.canLogin, 'Settings exposes OpenAI OAuth')
  assert(radiusRow?.authTypes.includes('oauth') && radiusRow.canLogin && radiusRow.builtin, 'Settings exposes Radius account sign-in as a built-in provider')
  const currentModel = openai.getModels().find(model => model.id === 'gpt-6.1-sol')
  runtime.getAvailable = async () => [currentModel]
  const modelRows = await f.app.models()
  assert(modelRows.some(row => row.providerId === 'openai' && row.id === 'gpt-6.1-sol' && row.available), 'the app model picker receives the SDK model')

  const authEvents = []
  f.app.emit = (channel, value) => { authEvents.push({ channel, value }) }
  runtime.login = async (providerId, kind, interaction) => {
    assert.equal(providerId, 'openai')
    assert.equal(kind, 'oauth')
    interaction.notify({ type: 'auth_url', url: 'https://auth.openai.com/fixture' })
    const answer = await interaction.prompt({ type: 'manual_code', message: 'Paste the redirect URL', placeholder: 'http://localhost/callback' })
    assert.equal(answer, 'http://localhost/callback?code=fixture')
    interaction.notify({ type: 'progress', message: 'Completing sign-in' })
  }
  const login = f.app.login('openai', 'oauth')
  for (let i = 0; i < 100 && !authEvents.some(item => item.channel === 'pi:auth-prompt'); i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert(authEvents.some(item => item.channel === 'pi:auth-notify' && item.value.kind === 'auth_url'))
  const prompt = authEvents.find(item => item.channel === 'pi:auth-prompt')?.value
  assert.equal(prompt?.kind, 'manual_code')
  f.app.resolveAuthPrompt({ requestId: prompt.requestId, value: 'http://localhost/callback?code=fixture' })
  await login
  assert(authEvents.some(item => item.channel === 'pi:auth-notify' && item.value.kind === 'progress'))
  assert(authEvents.some(item => item.channel === 'pi:auth-dismiss'), 'the dialog closes when login settles')

  // Anthropic 1.0 asks for browser/copy-code selection before the code prompt.
  const loginMethods = [{ id: 'browser', label: 'Browser login (default)' }, { id: 'copy_code', label: 'Copy code login (headless)' }]
  const offset = authEvents.length
  runtime.login = async (providerId, kind, interaction) => {
    assert.equal(providerId, 'anthropic')
    assert.equal(kind, 'oauth')
    const method = await interaction.prompt({ type: 'select', message: 'Select Anthropic login method:', options: loginMethods })
    assert.equal(method, 'copy_code')
    interaction.notify({ type: 'auth_url', url: 'https://claude.ai/oauth/fixture', instructions: 'Copy the returned authorization code' })
    const code = await interaction.prompt({ type: 'manual_code', message: 'Paste authorization code', placeholder: 'code#state' })
    assert.equal(code, 'fixture-code#fixture-state')
  }
  const waitPrompt = async kind => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const prompt = authEvents.slice(offset).find(item => item.channel === 'pi:auth-prompt' && item.value.kind === kind)?.value
      if (prompt) return prompt
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail(`No Anthropic ${kind} prompt`)
  }
  const anthropicLogin = f.app.login('anthropic', 'oauth')
  const choice = await waitPrompt('select')
  assert.deepEqual(choice.options, loginMethods, 'SDK option identities reach the UI intact')
  f.app.resolveAuthPrompt({ requestId: choice.requestId, value: 'copy_code' })
  const codePrompt = await waitPrompt('manual_code')
  assert.equal(codePrompt.placeholder, 'code#state')
  f.app.resolveAuthPrompt({ requestId: codePrompt.requestId, value: 'fixture-code#fixture-state' })
  await anthropicLogin
  assert(authEvents.slice(offset).some(item => item.channel === 'pi:auth-notify' && item.value.instructions === 'Copy the returned authorization code'))
  console.log('PASS: SDK 1.0 catalog, OpenAI ChatGPT auth, Anthropic browser/copy-code selection and complete login IPC callbacks')
} finally {
  await f.close()
}
