/**
 * vitest's jsdom environment, plus the Node-native `AbortController` and
 * `AbortSignal` kept aside under `globalThis.__node` so tests can hand Node's
 * `Request`/`fetch` a signal they accept (see storage.ts).
 */
import { builtinEnvironments, type Environment } from 'vitest/environments';

export interface NodeNatives {
  AbortController: typeof AbortController;
  AbortSignal: typeof AbortSignal;
}

const jsdom = builtinEnvironments.jsdom;

const environment: Environment = {
  name: 'jsdom-with-node-natives',
  transformMode: 'web',
  async setup(global: Record<string, unknown>, options) {
    const natives: NodeNatives = {
      AbortController: global.AbortController as typeof AbortController,
      AbortSignal: global.AbortSignal as typeof AbortSignal,
    };
    const env = await jsdom.setup(global, options);
    global.__node = natives;
    return env;
  },
};

export default environment;
