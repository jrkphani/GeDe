/**
 * Node 22+ ships native `localStorage` / `sessionStorage` globals that are
 * `undefined` unless `--localstorage-file` is given, and vitest's jsdom
 * environment will not overwrite an existing global. Reach into the jsdom
 * instance vitest exposes as `globalThis.jsdom` and use its real `Storage`.
 */
import type { NodeNatives } from './environment.js';

interface JsdomHandle {
  window: { localStorage: Storage; sessionStorage: Storage };
}

export function installWebStorage(): void {
  const handle = (globalThis as { jsdom?: JsdomHandle }).jsdom;
  if (!handle) throw new Error('installWebStorage() expects the vitest jsdom environment');
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    if (globalThis[name] as Storage | undefined) continue;
    Object.defineProperty(globalThis, name, {
      value: handle.window[name],
      configurable: true,
      writable: true,
    });
  }
}

/**
 * vitest replaces `AbortController`/`AbortSignal` with jsdom's, but `Request`
 * stays Node's (undici), which rejects a foreign signal. React Router builds a
 * `Request` for every navigation, so convert signals at the boundary using the
 * natives kept aside by `environment.ts`, and keep abort linked.
 */
export function installRequestSignalBridge(): void {
  const natives = (globalThis as { __node?: NodeNatives }).__node;
  if (!natives)
    throw new Error('installRequestSignalBridge() expects the environment in ./environment.ts');
  const { AbortController: NodeAbortController, AbortSignal: NodeAbortSignal } = natives;
  // Deliberately not a type predicate: both classes share the `AbortSignal` type.
  const isNodeSignal = (s: AbortSignal): boolean => s instanceof NodeAbortSignal;
  const NodeRequest = globalThis.Request;
  class BridgedRequest extends NodeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      const foreign = init?.signal;
      if (foreign && !isNodeSignal(foreign)) {
        const controller = new NodeAbortController();
        if (foreign.aborted) controller.abort(foreign.reason);
        else
          foreign.addEventListener('abort', () => {
            controller.abort(foreign.reason);
          });
        init = { ...init, signal: controller.signal };
      }
      super(input, init);
    }
  }
  Object.defineProperty(globalThis, 'Request', {
    value: BridgedRequest,
    configurable: true,
    writable: true,
  });
}
