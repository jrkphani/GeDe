import { Button } from './ui/button'

/*
 * `/welcome` — the v2 on-ramp (issue 033, ADR-0009, SITEMAP §1). Product
 * framing + a `command`-style sign-in CTA (issue 026); "Use locally" routes
 * straight to the account-free local app. Auth is an on-ramp, not a gate
 * (design brief) — nothing here blocks or delays the local app's own boot;
 * this route only ever renders when the user (or a link) sends them here.
 */
export function Hero({ onSignIn, onUseLocally }: { onSignIn: () => void; onUseLocally: () => void }) {
  return (
    <main className="hero">
      <section className="panel hero__panel">
        <p className="hero__eyebrow">GeDe</p>
        <h1 className="hero__title">Design generative systems, together.</h1>
        <p className="hero__body">
          Signing in syncs a project across devices and collaborators. No account is required — the
          full local app works offline, on this device, either way.
        </p>
        <div className="hero__actions">
          <Button variant="command" onClick={onSignIn}>
            Sign in
          </Button>
          <Button variant="bare" className="hero__use-locally" onClick={onUseLocally}>
            Use locally
          </Button>
        </div>
      </section>
    </main>
  )
}
