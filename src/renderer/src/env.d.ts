/// <reference types="vite/client" />

import type { PiApi } from '../../preload/index'

declare global {
  interface Window {
    pi: PiApi
  }
}
