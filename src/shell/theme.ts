// STYLE_GUIDE §2: light is canonical; dark is a first-class derived theme.
// The toggle stamps data-theme on the root and persists (SITEMAP §2 app bar).

const STORAGE_KEY = 'gede-theme'

export type Theme = 'light' | 'dark'

export function initTheme(): void {
  document.documentElement.dataset.theme = getTheme()
}

export function getTheme(): Theme {
  return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light'
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark'
  localStorage.setItem(STORAGE_KEY, next)
  document.documentElement.dataset.theme = next
  return next
}
