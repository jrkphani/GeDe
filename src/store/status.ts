import { create } from 'zustand'

// SITEMAP §2: the status bar is the app's single feedback channel — quiet
// narration with an optional inline action, plus ambient counts. Nothing in
// the app toasts; everything announces here.

interface StatusState {
  message: string | null
  action: { label: string; run: () => void | Promise<void> } | null
  announce: (message: string, action?: StatusState['action']) => void
  clear: () => void
}

export const useStatusStore = create<StatusState>()((set) => ({
  message: null,
  action: null,
  announce(message, action) {
    set({ message, action: action ?? null })
  },
  clear() {
    set({ message: null, action: null })
  },
}))
