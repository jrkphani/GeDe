/**
 * Formula evaluation off the main thread (apps/web/CLAUDE.md: "the main thread
 * never evaluates a formula"). One `FormulaEngine` per Worker; each message is
 * a structured-clone `EngineRequest` from `doc/engine.ts` and is answered with
 * an `EngineResponse`. Nothing here touches the DOM.
 */
import { FormulaEngine, type EngineRequest, type EngineResponse } from '@gede/core';

const engine = new FormulaEngine();

self.onmessage = (event: MessageEvent<EngineRequest>) => {
  const response: EngineResponse = engine.handle(event.data);
  self.postMessage(response);
};
