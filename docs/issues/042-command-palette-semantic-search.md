# 042: Command palette — semantic search (client-side embeddings)

- **Status**: OPEN
- **Milestone**: M6 (UX) / M2 (palette)
- **Blocked by**: 017 (the command palette + ranking seam — shipped)

## Slice

As a user, ⌘K finds commands and contexts **by meaning, not just by matching letters** — typing "hide the unconnected" surfaces the adjacency-emphasis toggle, "money" surfaces a context named "budget" — while the current fast lexical ranking still wins for exact/prefix matches. All of it runs **in the browser**: no server call, no data leaves the device, works offline, **zero AWS run cost**.

## Motivation

The palette (017) ranks purely lexically — `src/domain/paletteRanking.ts` scores symbol → name → justification, recents float. That's great for "I know the name" but misses "I know what I mean." Semantic search closes that gap. Doing it **client-side with embeddings** keeps it consistent with the whole local-first bet (ADR-0003: PGlite in the browser, data on-device): it costs **nothing** to run on AWS, needs no network, and never sends the user's domain content anywhere — the opposite of a hosted embeddings API. The only real cost is a one-time model download, cached per device.

## Scope

- **In-browser embeddings** via `transformers.js` (a small sentence-embedding model, e.g. quantized MiniLM ~20MB). Loaded **lazily** (first palette open, or an idle prefetch) and cached by the service worker so it's offline-capable and downloaded once.
- **Item corpus**: the palette's searchable set — commands from `useCommandRegistryStore` (`collect()`), plus live contexts (name + justification) already exposed to the palette (017's `coreCommands`). Embed each item's text once; **cache vectors in IndexedDB keyed by a content hash** so re-embedding only happens when an item's text changes.
- **Query path**: on keystroke (debounced), embed the query, cosine-similarity against the cached item vectors, and **blend the semantic score into `paletteRanking.ts`** (a weighted combination with the existing lexical/recency signal) — one pure, tested ranking function, not a parallel search.
- **Graceful degradation**: until the model is loaded (or if it fails / the device can't), the palette works **exactly as today** (pure lexical). Semantic is strictly additive — it never blocks input or the first result.

Out of scope: server-side/hosted embeddings (explicitly rejected on cost + privacy — see Design brief); semantic search *outside* the palette (a separate future issue if wanted); RAG/generation of any kind.

## Design brief

- **Local-first, $0 to run** (ADR-0003, TECH_STACK §5): embeddings run on-device like PGlite does; no Bedrock/OpenAI/pgvector, no per-query cost, no data egress. This is the whole reason to do it client-side.
- **Fast path stays fast**: exact/prefix lexical matches must not regress — semantic is a *blend*, tuned so a perfect name match still ranks first; the query embed is debounced and never gates the visible results.
- **Progressive, never a wall**: the palette is fully usable before/without the model. Model load is invisible (lazy + SW-cached), and a failure degrades silently to lexical.
- **Honest about the one cost**: a ~20MB model download per device (cached, offline after). Load it on demand, not in the initial bundle — the app's first paint and PGlite boot must not pay for it.

**References**: issue **017** (command palette, `commandRegistry`, `paletteRanking.ts`, `CommandPalette.tsx`) · **ADR-0003** (Postgres/PGlite local-first, the on-device precedent) · ADR-0005 (determinism — cache vectors, don't recompute nondeterministically) · TECH_STACK §5 (zero-friction PWA), §6.2 (SW caching — the model is a cacheable asset) · STYLE_GUIDE §10 (palette keyboard/focus) · SITEMAP (⌘K).

## Test-first plan

1. **Pure blend ranking**: a unit test of the extended `paletteRanking` — given lexical scores + semantic similarities, a perfect name match still ranks first, and a semantically-close/lexically-far item outranks an unrelated one. No model needed (feed synthetic vectors).
2. **Graceful fallback**: with the embedding model absent/unloaded, the palette returns the exact current lexical results (a golden test that semantic is additive-only).
3. **Vector cache invalidation**: changing an item's text re-embeds it; unchanged items reuse the cached vector (content-hash keyed) — asserted without a real model via a stubbed embedder.
4. **No network / no cost**: a test/guard that the embedding path makes **no fetch to any AWS/remote endpoint** (the model loads from the SW cache/bundled asset only).

## Acceptance criteria

- [ ] ⌘K surfaces semantically-relevant commands/contexts (meaning, not just letters), blended with — not replacing — the lexical/recency ranking; exact matches still rank first.
- [ ] Fully functional (lexical) before the model loads and if it fails; model is lazy-loaded and SW-cached (offline after first load), **not** in the initial bundle.
- [ ] Vectors cached in IndexedDB, re-embedded only on content change.
- [ ] **Zero AWS run cost and zero data egress** — everything is on-device; no remote embedding calls.
- [ ] `npm run verify` green; bundle-size impact of the model is out-of-initial-chunk (measured).

## Implementation notes

- **Model**: quantized `all-MiniLM-L6-v2` (~23MB) is the safe default; a smaller model (e.g. a `bge-micro`/6-layer variant) trades a little quality for a smaller download — pick during implementation against the item-count/latency budget. Command/context corpora are small (dozens–hundreds), so query latency is dominated by the single query-embed, not the similarity scan.
- **Loading**: `transformers.js` with the model served as a same-origin cached asset (SW `registerType: 'prompt'`, §6.2) so it's downloaded once and available offline; lazy-import so it's a separate chunk (Vite `optimizeDeps`/dynamic import — watch the PGlite exclude precedent).
- **Blend weighting**: start with lexical-dominant (perfect-match wins), semantic as a tiebreaker/recall booster; expose the weight as a constant and property-test the "exact match never loses" invariant.
- **Determinism**: embeddings are deterministic for a given model+input; cache by content hash and never recompute in a way that reorders results within a session (ADR-0005 spirit).
- **Scope creep guard**: this is palette-only. If semantic search over the whole corpus (coverage matrix, register) is wanted later, it's a separate issue that can reuse this embedder + vector cache.
