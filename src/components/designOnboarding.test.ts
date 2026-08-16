import { describe, expect, it } from 'vitest'
import { designOnboardingMode, designOnboardingStorageKey } from './designOnboarding'

describe('design onboarding', () => {
  it('invites the first binding only when a canvas can compose and has no completed context', () => {
    expect(
      designOnboardingMode({ canCompose: true, hasCompletedContext: false, isComposing: false, dismissed: false }),
    ).toBe('activation')
  })

  it('switches from activation to contextual progress once composing begins', () => {
    expect(
      designOnboardingMode({ canCompose: true, hasCompletedContext: false, isComposing: true, dismissed: false }),
    ).toBe('progress')
  })

  it.each([
    { canCompose: false, hasCompletedContext: false, isComposing: false, dismissed: false },
    { canCompose: true, hasCompletedContext: false, isComposing: false, dismissed: true },
    { canCompose: true, hasCompletedContext: true, isComposing: false, dismissed: false },
  ])('stays hidden when the cue is ineligible', (state) => {
    expect(designOnboardingMode(state)).toBeNull()
  })

  it('scopes dismissal to the project and canvas', () => {
    expect(designOnboardingStorageKey('project-a', 'canvas-a')).toBe(
      'gede-design-binding-onboarding-dismissed:project-a:canvas-a',
    )
  })
})
