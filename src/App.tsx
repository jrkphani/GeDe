import { useEffect, useState } from 'react'
import { getDatabase } from './db/client'

export default function App() {
  const [dbReady, setDbReady] = useState(false)
  const [dbError, setDbError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getDatabase().then(
      () => {
        if (!cancelled) setDbReady(true)
      },
      (err: unknown) => {
        // TECH_STACK §6.2: a failed boot migration must surface, never fail silently.
        console.error('database boot failed', err)
        if (!cancelled) setDbError(err instanceof Error ? err.message : String(err))
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div data-db-ready={dbReady} data-db-error={dbError ?? undefined}>
      <h1 className="wordmark">GeDe</h1>
      {dbError !== null && <p role="alert">Database failed to open: {dbError}</p>}
    </div>
  )
}
