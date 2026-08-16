import { useEffect, useState } from 'react'

export type DesignOnboardingMode = 'activation' | 'progress' | null

const DISMISSED_PREFIX = 'gede-design-binding-onboarding-dismissed:'

export function designOnboardingStorageKey(projectId: string, canvasScope: string): string {
  return `${DISMISSED_PREFIX}${projectId}:${canvasScope}`
}

export function designOnboardingMode({
  canCompose,
  hasCompletedContext,
  isComposing,
  dismissed,
}: {
  canCompose: boolean
  hasCompletedContext: boolean
  isComposing: boolean
  dismissed: boolean
}): DesignOnboardingMode {
  if (!canCompose || hasCompletedContext) return null
  if (isComposing) return 'progress'
  return dismissed ? null : 'activation'
}

// One canvas gets one chance to introduce the operator to Design's proof of
// value: bind a context across its available dimensions. Dismissal is local to
// that canvas; completing any context retires the cue permanently for it.
export function useDesignOnboarding({
  projectId,
  canvasScope,
  canCompose,
  hasCompletedContext,
  isComposing,
}: {
  projectId: string
  canvasScope: string
  canCompose: boolean
  hasCompletedContext: boolean
  isComposing: boolean
}): { mode: DesignOnboardingMode; dismiss: () => void } {
  const storageKey = designOnboardingStorageKey(projectId, canvasScope)
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(storageKey) === 'true')

  useEffect(() => {
    setDismissed(localStorage.getItem(storageKey) === 'true')
  }, [storageKey])

  useEffect(() => {
    if (!hasCompletedContext) return
    localStorage.setItem(storageKey, 'true')
    setDismissed(true)
  }, [hasCompletedContext, storageKey])

  return {
    mode: designOnboardingMode({ canCompose, hasCompletedContext, isComposing, dismissed }),
    dismiss: () => {
      localStorage.setItem(storageKey, 'true')
      setDismissed(true)
    },
  }
}
