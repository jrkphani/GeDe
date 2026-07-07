import { useStatusStore } from '../store/status'
import { Button } from '../components/ui/button'

declare const __APP_VERSION__: string

export function StatusBar() {
  const message = useStatusStore((s) => s.message)
  const action = useStatusStore((s) => s.action)
  const clear = useStatusStore((s) => s.clear)

  return (
    <footer className="status-bar">
      <div className="status-bar__narration" role="status" aria-live="polite">
        {message !== null && (
          <>
            <span>{message}</span>
            {action !== null && (
              <Button
                variant="rowAction"
                onClick={() => {
                  void action.run()
                  clear()
                }}
              >
                {action.label}
              </Button>
            )}
          </>
        )}
      </div>
      <div className="status-bar__ambient">
        <span className="status-bar__version">v{__APP_VERSION__}</span>
      </div>
    </footer>
  )
}
