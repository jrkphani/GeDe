import type { CSSProperties } from 'react';
import { initials, type PresenceState } from '@gede/core';
import { Icon } from '@gede/ui';

export interface SharedIndicatorProps {
  /** The record says the workscape is shared (someone else holds a share, or it was shared with me). */
  sharedFlag: boolean;
  /** Other participants currently in the room, from awareness (SHARE-04 colours). */
  participants: readonly PresenceState[];
}

/** Most avatars stacked before the count takes over. */
export const MAX_STACKED = 4;

/**
 * SHARE-05: "While any participant exists the title row shows Shared with
 * stacked avatars." The pill reads Shared; each present collaborator is one
 * avatar in their presence colour (never the brand colour) with their
 * initials, a fifth and beyond collapse to +n. Nothing renders when the
 * workscape is private and nobody else is here.
 */
export function SharedIndicator({ sharedFlag, participants }: SharedIndicatorProps) {
  const others = uniqueByUser(participants);
  const shared = sharedFlag || others.length > 0;
  if (!shared) return null;
  const label = sharedTitle(others);
  return (
    <span className="gd-doc__badge" title={label} data-testid="shared-indicator">
      <Icon name="people" size={13} /> Shared
      {others.length > 0 && (
        <span className="gd-doc__avatars" aria-label={label}>
          {others.slice(0, MAX_STACKED).map((p) => (
            <span
              key={p.userId}
              className="gd-doc__avatar"
              style={{ '--gd-presence': `var(--presence-${String(p.colour)})` } as CSSProperties}
              title={p.name}
            >
              {initials(p.name)}
            </span>
          ))}
          {others.length > MAX_STACKED && (
            <span className="gd-doc__avatar gd-doc__avatar--more">
              +{others.length - MAX_STACKED}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export function uniqueByUser(list: readonly PresenceState[]): PresenceState[] {
  const seen = new Map<string, PresenceState>();
  for (const p of list) if (!seen.has(p.userId)) seen.set(p.userId, p);
  return Array.from(seen.values());
}

export function sharedTitle(others: readonly PresenceState[]): string {
  if (others.length === 0) return 'Shared';
  return `Shared · ${others.map((p) => p.name).join(', ')} ${others.length === 1 ? 'is' : 'are'} here`;
}
