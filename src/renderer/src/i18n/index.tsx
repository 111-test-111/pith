import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import en, { type MessageKey } from './locales/en'
import zhCN from './locales/zh-CN'

export const LOCALE_STORAGE_KEY = 'pi-app:locale'

export type Locale = 'en' | 'zh-CN'

const dictionaries: Record<Locale, typeof en> = { en, 'zh-CN': zhCN }

/** Language names shown in their own language, never translated. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文'
}

function detectLocale(): Locale {
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
  if (stored === 'en' || stored === 'zh-CN') return stored
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

interface I18nContextValue {
  locale: Locale
  /** Switches immediately and persists the choice. */
  setLocale: (locale: Locale) => void
  /** Translate a key; `{placeholder}` segments are replaced from params. */
  t: (key: MessageKey, params?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale)

  const setLocale = useCallback((next: Locale) => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next)
    setLocaleState(next)
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const t = useCallback(
    (key: MessageKey, params?: Record<string, string | number>) => {
      let text: string = dictionaries[locale][key] ?? en[key] ?? key
      if (params) {
        for (const [name, value] of Object.entries(params)) {
          text = text.split(`{${name}}`).join(String(value))
        }
      }
      return text
    },
    [locale]
  )

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext)
  if (!context) throw new Error('useI18n must be used within <I18nProvider>')
  return context
}
