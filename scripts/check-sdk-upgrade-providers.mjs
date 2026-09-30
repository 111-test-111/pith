/** Offline SDK 0.99 provider catalog and OpenAI ChatGPT login bridge check. */
import assert from 'node:assert/strict'
import { createPlanFixture } from './lib/plan-fixture.mjs'

const f = await createPlanFixture()
try {
  await f.managed.lifecyclePromise
  const runtime = await f.app.runtime()
  const openai = runtime.getProvider('openai')
  const legacy = runtime.getProvider('openai-codex')
  assert(openai, 'the current OpenAI provider is registered')
  assert(legacy, 'existing OpenAI Codex sessions remain selectable')
  assert.equal(openai.auth?.oauth?.loginLabel, 'Sign in with ChatGPT')
  assert(openai.getModels().some(model => model.id === 'gpt-6.1-sol'))
  assert(legacy.getModels().some(model => model.id === 'gpt-6.1-sol'))

  runtime.checkAuth = async () => undefined // isolated fixture: never consult real credentials
  const providerRows = await f.app.providers()
  const openaiRow = providerRows.find(row => row.id === 'openai')
  assert(openaiRow?.authTypes.includes('oauth') && openaiRow.canLogin, 'Settings exposes OpenAI OAuth')
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
  console.log('PASS: SDK model catalog, OpenAI ChatGPT auth metadata, app model list and login IPC bridge')
} finally {
  await f.close()
}
