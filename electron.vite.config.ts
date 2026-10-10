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
          'resources-worker': resolve('src/main/resources/worker.ts'),
          'library-worker': resolve('src/main/library/worker.ts'),
          'file-preview-worker': resolve('src/main/file-preview/worker.ts'),
          'session-search-worker': resolve('src/main/pi/session-search-worker.ts'),
          'trajectory-worker': resolve('src/main/pi/trajectory-worker.ts'),
          'usage-worker': resolve('src/main/pi/usage-worker.ts'),
          'rewind-worker': resolve('src/main/rewind/worker.ts'),
          'terminal-host': resolve('src/main/terminal/host.ts')
        },
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
