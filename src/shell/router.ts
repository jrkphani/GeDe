import { useSyncExternalStore } from 'react'
import { parseRoute, serializeRoute, type AppRoute } from './routes'

// Minimal history binding over the pure route module. No router library:
// the map has no nested layouts or loaders, and parse/serialize stay testable.

const listeners = new Set<() => void>()

function notify() {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) window.addEventListener('popstate', notify)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('popstate', notify)
  }
}

function currentUrl(): string {
  return window.location.pathname + window.location.search
}

export function currentRoute(): AppRoute {
  return parseRoute(window.location.pathname, window.location.search)
}

export function navigate(route: AppRoute, opts: { replace?: boolean } = {}): void {
  const url = serializeRoute(route)
  if (url === currentUrl()) return
  if (opts.replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
  notify()
}

export function useRoute(): AppRoute {
  const url = useSyncExternalStore(subscribe, currentUrl)
  void url // the snapshot is the URL string; parse derives the route
  return currentRoute()
}
