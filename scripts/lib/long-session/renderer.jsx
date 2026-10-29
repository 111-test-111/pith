import React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { ChatView } from '../../../src/renderer/src/components/app/ChatView'
import { TrajectoryPane } from '../../../src/renderer/src/components/app/TrajectoryPane'
import { ImagePreviewProvider } from '../../../src/renderer/src/components/app/ImagePreview'
import { FileNavigationProvider } from '../../../src/renderer/src/lib/file-navigation'
import { I18nProvider } from '../../../src/renderer/src/i18n'
import { PiStore } from '../../../src/renderer/src/state/pi-store'
import '../../../src/renderer/src/styles.css'

// Product components + production Vite/React build. No replacement transcript,
// UI framework or synthetic DOM tree. Only the external services are fixtures.
localStorage.setItem('pi-app:locale', 'en')
localStorage.setItem('pi-app:tool-grouping', 'on')
localStorage.setItem('pi-app:show-reasoning', 'off')
const root = createRoot(document.getElementById('root'))
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
let store
window.benchmark = {
  async mount(snapshot) {
    store = new PiStore()
    const start = performance.now()
    store.applySnapshot(snapshot)
    flushSync(() => root.render(
      <I18nProvider>
        <ImagePreviewProvider>
          <FileNavigationProvider cwd="/benchmark" openFile={() => {}}>
            <div className="flex h-screen min-h-0 bg-background text-foreground">
              <div id="benchmark-chat" className="min-w-0 flex-1"><ChatView store={store} /></div>
              <div id="benchmark-trajectory" className="w-[400px] shrink-0 border-l border-border"><TrajectoryPane store={store} /></div>
            </div>
          </FileNavigationProvider>
        </ImagePreviewProvider>
      </I18nProvider>
    ))
    await frames()
    return { firstScreenMs: performance.now() - start,
      assistantRows: document.querySelectorAll('[data-assistant-group]').length,
      chatElements: document.getElementById('benchmark-chat').querySelectorAll('*').length }
  },
  async settle() { await frames() },
  metrics() {
    return { domElements: document.querySelectorAll('*').length,
      chatElements: document.getElementById('benchmark-chat').querySelectorAll('*').length,
      trajectoryElements: document.getElementById('benchmark-trajectory').querySelectorAll('*').length,
      trajectoryRows: document.querySelectorAll('[data-trajectory-record]').length,
      trajectoryFields: document.querySelectorAll('[data-trajectory-fields] button').length,
      heap: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize,
        totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit } : null }
  },
  async liveDelta() {
    const timestamp = store.getState().messages.at(-1).timestamp + 100
    const message = { role: 'assistant', timestamp, api: 'openai-completions', provider: 'benchmark',
      model: 'offline-fixture', content: [{ type: 'text', text: 'Live delta · 中文😀' }], stopReason: 'stop' }
    const start = performance.now()
    flushSync(() => {
      store.dispatch({ type: 'agent_start', sessionPath: store.getShell().sessionPath })
      store.dispatch({ type: 'message_update', message, sessionPath: store.getShell().sessionPath })
    })
    await frames()
    return { liveDeltaFrameMs: performance.now() - start }
  },
  unmount() { flushSync(() => root.unmount()) }
}
