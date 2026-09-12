/**
 * Presence colour (SHARE-04): assigned on join from the six presence tokens,
 * never the brand colour. "On join" means once the room has told us who is
 * already there — after the first sync, or the first remote awareness state —
 * so two clients joining together do not both pick colour 1. If they still
 * collide (they picked at the same instant), the client with the higher
 * clientID yields and re-picks; the lower one keeps its colour, so exactly
 * one side moves.
 */
import { useEffect, useState } from 'react';
import type { Awareness } from 'y-protocols/awareness';
import { assignPresenceColour, toPresenceState, type PresenceColour } from '@gede/core';

import { useAwarenessVersion } from './use-y.js';

export interface RemoteColour {
  readonly clientId: number;
  readonly colour: PresenceColour;
}

/** Pure: the colour this client should carry given what the room shows. */
export function resolvePresenceColour(
  current: PresenceColour | null,
  myClientId: number,
  remote: readonly RemoteColour[],
): PresenceColour {
  const taken = remote.map((r) => r.colour);
  if (current === null) return assignPresenceColour(taken);
  const collides = remote.some((r) => r.colour === current && r.clientId < myClientId);
  return collides ? assignPresenceColour(taken) : current;
}

export function remoteColours(awareness: Awareness): RemoteColour[] {
  const out: RemoteColour[] = [];
  awareness.getStates().forEach((state, clientId) => {
    if (clientId === awareness.clientID) return;
    const p = toPresenceState(state);
    if (p !== null) out.push({ clientId, colour: p.colour });
  });
  return out;
}

/**
 * The local client's presence colour. `null` until the room has answered
 * (`ready`: first sync) or a remote state has arrived, whichever comes first.
 */
export function usePresenceColour(awareness: Awareness, ready: boolean): PresenceColour | null {
  const version = useAwarenessVersion(awareness);
  // A colour already announced (a remount) is the starting point, so it is kept unless it collides.
  const [colour, setColour] = useState<PresenceColour | null>(
    () => toPresenceState(awareness.getLocalState())?.colour ?? null,
  );
  useEffect(() => {
    const remote = remoteColours(awareness);
    if (!ready && remote.length === 0) return;
    const next = resolvePresenceColour(colour, awareness.clientID, remote);
    if (next !== colour) setColour(next);
  }, [awareness, ready, version, colour]);
  return colour;
}
