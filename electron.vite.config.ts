import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'session-search-worker': resolve('src/main/pi/session-search-worker.ts'),
          'usage-worker': resolve('src/main/pi/usage-worker.ts'),
          'rewind-worker': resolve('src/main/rewind/worker.ts'),
          'terminal-host': resolve('src/main/terminal/host.ts')
        },
        // Rollup 4's inter-procedural tree-shaking proves functions whose leaves are
        // electron/parameter calls "pure" and deletes their call statements from
        // function bodies — measured on the browser wiring: installBrowserWiring
        // (and, after the service init lands, its whole body) was folded out of
        // index.mjs. The main process graph is full of exactly such electron-only
        // installers, so cross-module folding stays off here.
        treeshake: false,
        output: { format: 'es', entryFileNames: '[name].mjs' }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'es', entryFileNames: '[name].mjs' }
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    worker: { format: 'es' },
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    }
  }
})
