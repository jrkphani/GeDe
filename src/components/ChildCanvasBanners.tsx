import type { StaleRebindEvent } from '../db/mutations'
import { Button } from './ui/button'

// Issue 011 — the stale parent-rebind banner. When a parent context re-binds a
// dimension after its child canvas already exists, the child dimension follows
// the new parameter and its now-invalid sub-bindings are retired. This is
// informational + Undo (not a decision dialog — design brief): a hairline
// warning band naming the change and offering to restore. Warning color, not
// danger — nothing was lost destructively (the Undo re-inserts everything).
export function ChildCanvasBanners({
  events,
  onUndo,
}: {
  events: readonly StaleRebindEvent[]
  onUndo: (event: StaleRebindEvent) => void
}) {
  if (events.length === 0) return null
  return (
    <div className="child-canvas-banners">
      {events.map((event) => {
        const retired = event.retiredBindings.length
        return (
          <div key={event.childDimensionId} className="stale-banner" role="status">
            <span className="stale-banner__copy">
              Re-bound <span className="font-mono">{event.fromName}</span> →{' '}
              <span className="font-mono">{event.toName}</span>. This canvas now refines{' '}
              <span className="font-mono">{event.toName}</span>
              {retired > 0 ? (
                <>
                  {' '}
                  — {retired} sub-{retired === 1 ? 'binding was' : 'bindings were'} retired
                </>
              ) : null}
              .
            </span>
            <Button variant="bare" className="stale-banner__undo" onClick={() => onUndo(event)}>
              Undo
            </Button>
          </div>
        )
      })}
    </div>
  )
}
