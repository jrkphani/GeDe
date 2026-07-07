// Issue 044 test-first plan #3 — a CI assertion, run as a plain vitest unit
// test (no YAML parser dependency; the repo has none declared, only
// transitive ones through eslint/stylelint/vite, so this greps the raw file
// text instead — matching the issue's own suggestion: "grep/lint the
// workflow"). Asserts .github/workflows/deploy.yml threads the Auth stack's
// Cognito ids into the frontend build via CloudFormation, not a hardcoded id,
// and does so before `vite build` runs.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const workflowPath = fileURLToPath(new URL('../../.github/workflows/deploy.yml', import.meta.url))
const workflow = readFileSync(workflowPath, 'utf8')

// The live ids from docs/issues/044 — verified ground truth, never expected
// to appear literally in the workflow (that would mean someone hardcoded
// them instead of sourcing them from CloudFormation).
const LIVE_USER_POOL_ID = 'us-east-1_d0qKGDQmC'
const LIVE_CLIENT_ID = '5qbs9mgmms9mcf0u7r26npi3g2'

describe('.github/workflows/deploy.yml — Cognito config wiring (issue 044)', () => {
  it('exports all three VITE_COGNITO_* vars into the build env', () => {
    expect(workflow).toContain('VITE_COGNITO_USER_POOL_ID')
    expect(workflow).toContain('VITE_COGNITO_CLIENT_ID')
    expect(workflow).toContain('VITE_COGNITO_REGION')
  })

  it('sources the ids from the Gede-Test-Auth CloudFormation stack outputs, not a hardcoded id', () => {
    expect(workflow).toContain('describe-stacks')
    expect(workflow).toContain('Gede-Test-Auth')
    expect(workflow).not.toContain(LIVE_USER_POOL_ID)
    expect(workflow).not.toContain(LIVE_CLIENT_ID)
  })

  it('configures AWS credentials before reading the stack outputs, and reads them before `npm run build` runs', () => {
    const credsIndex = workflow.indexOf('Configure AWS credentials (OIDC)')
    const cognitoConfigIndex = workflow.indexOf('VITE_COGNITO_USER_POOL_ID')
    // The actual build STEP invocation, not a prose mention of "npm run
    // build" in a comment (this file's own header comments say exactly
    // that, earlier in the file).
    const buildIndex = workflow.indexOf('run: npm run build')

    expect(credsIndex).toBeGreaterThan(-1)
    expect(cognitoConfigIndex).toBeGreaterThan(-1)
    expect(buildIndex).toBeGreaterThan(-1)
    expect(credsIndex).toBeLessThan(cognitoConfigIndex)
    expect(cognitoConfigIndex).toBeLessThan(buildIndex)
  })
})
