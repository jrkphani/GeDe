import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { PresenceColour } from '@gede/core';
import { FakeRoom, until } from '../test/fake-websocket.js';
import { resolvePresenceColour, usePresenceColour } from './presence.js';
import { SyncClient } from './sync-client.js';

const DOC_ID = '6f1b2c3d-0000-4000-8000-0000000000c0';

describe('resolvePresenceColour', () => {
  it('SHARE-04 picks the least-used colour on join and keeps it unless a lower client holds the same', () => {
    expect(resolvePresenceColour(null, 7, [])).toBe(1);
    expect(resolvePresenceColour(null, 7, [{ clientId: 3, colour: 1 }])).toBe(2);
    // No collision: keep.
    expect(resolvePresenceColour(2, 7, [{ clientId: 3, colour: 1 }])).toBe(2);
    // Collision with a lower clientID: this side yields and re-picks a free colour.
    expect(resolvePresenceColour(1, 7, [{ clientId: 3, colour: 1 }])).toBe(2);
    // Collision with a higher clientID: the other side yields; this one keeps.
    expect(resolvePresenceColour(1, 3, [{ clientId: 7, colour: 1 }])).toBe(1);
  });
});

function Probe({ client, ready }: { client: SyncClient; ready: boolean }) {
  const colour = usePresenceColour(client.awareness, ready);
  return (
    <span data-testid={`colour-${String(client.awareness.clientID)}`}>{colour ?? 'none'}</span>
  );
}

function makeClient(room: FakeRoom): SyncClient {
  return new SyncClient({
    docId: DOC_ID,
    doc: new Y.Doc(),
    wsUrl: 'wss://ws.test/ws',
    getToken: () => Promise.resolve('tok'),
    WebSocketImpl: room.WebSocket,
    random: () => 0,
  });
}

describe('usePresenceColour', () => {
  const clients: SyncClient[] = [];
  afterEach(() => {
    for (const c of clients.splice(0)) c.destroy();
  });

  it('SHARE-04 two clients joining one room end up with different colours, assigned only once the room has answered', async () => {
    const room = new FakeRoom();
    const a = makeClient(room);
    const b = makeClient(room);
    clients.push(a, b);
    const { rerender } = render(
      <>
        <Probe client={a} ready={false} />
        <Probe client={b} ready={false} />
      </>,
    );
    // Nothing is assigned before the room has answered.
    expect(screen.getByTestId(`colour-${String(a.awareness.clientID)}`)).toHaveTextContent('none');
    a.connect();
    await until(() => a.getSnapshot().status === 'synced');
    rerender(
      <>
        <Probe client={a} ready />
        <Probe client={b} ready={false} />
      </>,
    );
    await waitFor(() => {
      expect(screen.getByTestId(`colour-${String(a.awareness.clientID)}`)).toHaveTextContent('1');
    });
    a.awareness.setLocalState({ userId: 'ua', name: 'A', colour: 1, sheetId: null });
    b.connect();
    await until(() => b.getSnapshot().status === 'synced');
    rerender(
      <>
        <Probe client={a} ready />
        <Probe client={b} ready />
      </>,
    );
    // B sees A's state before it picks, so it takes the next colour.
    await waitFor(() => {
      expect(screen.getByTestId(`colour-${String(b.awareness.clientID)}`)).toHaveTextContent('2');
    });
  });

  it('SHARE-04 on a collision the client with the higher clientID re-picks; the lower keeps its colour', async () => {
    const room = new FakeRoom();
    const a = makeClient(room);
    const b = makeClient(room);
    clients.push(a, b);
    a.connect();
    b.connect();
    await until(() => a.getSnapshot().status === 'synced' && b.getSnapshot().status === 'synced');
    // Both picked colour 1 at the same instant.
    const same: PresenceColour = 1;
    a.awareness.setLocalState({ userId: 'ua', name: 'A', colour: same, sheetId: null });
    b.awareness.setLocalState({ userId: 'ub', name: 'B', colour: same, sheetId: null });
    await until(() => a.awareness.getStates().size === 2 && b.awareness.getStates().size === 2);
    const [low, high] = a.awareness.clientID < b.awareness.clientID ? [a, b] : [b, a];
    render(
      <>
        <Probe client={low} ready />
        <Probe client={high} ready />
      </>,
    );
    await waitFor(() => {
      expect(screen.getByTestId(`colour-${String(high.awareness.clientID)}`)).toHaveTextContent(
        '2',
      );
    });
    expect(screen.getByTestId(`colour-${String(low.awareness.clientID)}`)).toHaveTextContent('1');
  });
});
