import type { Embedder } from './vectorCache'

// Issue 042 — the real, on-device embedder. `@huggingface/transformers` (the
// actively-maintained successor to `@xenova/transformers`; same model
// namespace/format, fixed onnxruntime-web/protobufjs advisories the older
// package still carries — see the issue's Shipped notes) runs entirely in
// the browser via WASM/onnxruntime-web: model weights are fetched once from
// the Hugging Face CDN (the one acknowledged one-time cost in the issue's
// design brief) and then served from the browser's Cache Storage
// (`env.useBrowserCache`, on by default) — offline after first load, even
// without this app registering its own service worker. No user content
// (queries, command/context text) ever leaves the device: the model call is
// a local WASM tensor computation, not a network request.
//
// Dynamically imported ONLY inside `embed()` (never at module load), so this
// ~megabytes-plus dependency is never in `CommandPalette`'s or the shell's
// static import graph — Vite gives it its own chunk automatically, loaded
// lazily on first use (the store layer calls this only after the palette
// has been opened once). Mirrors the PGlite `optimizeDeps.exclude`
// precedent (HANDOFF): keep it out of pre-bundling too.
const MODEL_ID = 'onnx-community/all-MiniLM-L6-v2-ONNX'

export function createTransformersEmbedder(modelId = MODEL_ID): Embedder {
  // Cached across calls on this embedder instance so repeated `embed()`
  // calls (one per query keystroke) reuse the same loaded pipeline instead
  // of re-downloading/re-initializing the model every time.
  let pipelinePromise: ReturnType<
    typeof import('@huggingface/transformers').pipeline<'feature-extraction'>
  > | null = null

  return {
    async embed(text: string) {
      pipelinePromise ??= import('@huggingface/transformers').then(({ pipeline, env }) => {
        // Browser cache stays on (the offline-after-first-load contract);
        // no local filesystem model path exists in a browser, and remote
        // fetch is the one sanctioned network call (model weights only,
        // never carrying palette/query content).
        env.useBrowserCache = true
        return pipeline('feature-extraction', modelId, { dtype: 'q8' })
      })
      const extractor = await pipelinePromise
      const output = await extractor(text, { pooling: 'mean', normalize: true })
      return Array.from(output.data as ArrayLike<number>)
    },
  }
}
