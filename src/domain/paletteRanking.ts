// Issue 017 — the command palette's pure ranking + empty-state copy. No React,
// no store: the palette component and the shell's command sources share these
// so the "legible ranking" contract (SITEMAP §3) is testable in isolation.

export type CommandKind = 'tier' | 'canvas' | 'context' | 'action'

// The one shape every palette result takes, whatever contributes it. `symbol`
// is the mono token (α2) that drives exact-match ranking; `keywords` carries
// synonyms and justification text so a verb like "Export project…" is found by
// "download" and a context by words in its justification.
export interface CommandItem {
  id: string
  kind: CommandKind
  title: string
  symbol?: string
  keywords?: readonly string[]
  run: () => void
}

// Match tiers (lower = better), per the issue's ranking brief: exact symbol
// first, then name (title), then justification/synonym text. `null` = no match.
function matchScore(item: CommandItem, q: string): number | null {
  const symbol = item.symbol?.toLowerCase()
  if (symbol) {
    if (symbol === q) return 0
    if (symbol.startsWith(q)) return 1
  }
  const title = item.title.toLowerCase()
  if (title.startsWith(q)) return 2
  if (title.includes(q)) return 3
  if (item.keywords?.some((k) => k.toLowerCase().includes(q))) return 4
  return null
}

// Issue 042 — semantic search blend. `semanticScores` is a plain cosine
// similarity per item id (typically in [0,1] for normalized sentence
// embeddings); absent/empty is the exact issue-017 behavior (graceful
// degradation — no model, no scores, no change). An item with no lexical
// match at all is only surfaced via a *strong* semantic hit (SEMANTIC_TIER),
// which always sorts below every lexical tier (0-4) — a perfect/prefix/
// substring/keyword match can never lose to a semantic-only result. Within a
// shared tier, semantic similarity is a secondary sort key (a small recall/
// tiebreak boost per the issue's "lexical-dominant" blend weighting), ahead of
// recency, which still decides ties when neither ranking model has an opinion.
export type SemanticScores = ReadonlyMap<string, number>

const SEMANTIC_TIER = 5
const SEMANTIC_INCLUDE_THRESHOLD = 0.35

function semanticScoreOf(scores: SemanticScores | undefined, id: string): number {
  return scores?.get(id) ?? 0
}

// Cosine similarity of two equal-length embedding vectors, in [-1, 1] (in
// practice ~[0, 1] for the normalized sentence embeddings this blend expects).
// Pure arithmetic — no model, so it's directly unit-testable with hand-written
// vectors (issue 042's test-first plan #1).
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let magA = 0
  let magB = 0
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    dot += ai * bi
    magA += ai * ai
    magB += bi * bi
  }
  if (magA === 0 || magB === 0) return 0
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

// Builds the per-item score map `rankCommands` expects, from a query vector
// and a per-item vector map — the embedder/vector-cache layer's only contract
// with this pure module.
export function semanticScoresFromVectors(
  queryVector: readonly number[],
  itemVectors: ReadonlyMap<string, readonly number[]>,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const [id, vector] of itemVectors) out.set(id, cosineSimilarity(queryVector, vector))
  return out
}

export interface RankCommandsOptions {
  limit?: number
  semanticScores?: SemanticScores | undefined
}

// Ranks and caps the palette's results. Ties break by semantic similarity
// (issue 042, no-op when `semanticScores` is absent), then recency
// (recent-first), then by original order for stability. An empty query lists
// everything recent-first (max 8) so the palette opens showing recent
// destinations — semantic scoring never applies to an empty query (there is
// no query text to embed).
export function rankCommands(
  items: readonly CommandItem[],
  query: string,
  recentIds: readonly string[],
  options: RankCommandsOptions = {},
): CommandItem[] {
  const { limit = 8, semanticScores } = options
  const q = query.trim().toLowerCase()
  const recencyRank = (id: string): number => {
    const i = recentIds.indexOf(id)
    return i === -1 ? Number.POSITIVE_INFINITY : i
  }

  const scored: { item: CommandItem; index: number; tier: number; semantic: number }[] = []
  items.forEach((item, index) => {
    if (q === '') {
      scored.push({ item, index, tier: 0, semantic: 0 })
      return
    }
    const lexical = matchScore(item, q)
    const semantic = semanticScoreOf(semanticScores, item.id)
    if (lexical !== null) {
      scored.push({ item, index, tier: lexical, semantic })
      return
    }
    if (semantic >= SEMANTIC_INCLUDE_THRESHOLD) {
      scored.push({ item, index, tier: SEMANTIC_TIER, semantic })
    }
  })

  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.semantic - a.semantic ||
      recencyRank(a.item.id) - recencyRank(b.item.id) ||
      a.index - b.index,
  )

  return scored.slice(0, limit).map((s) => s.item)
}

const MAX_NAME_LENGTH = 40

// SITEMAP §3 empty state: "Enter creates a context named '…'" only when the
// query is a plausible symbol/name — a non-empty, single-line, short token.
export function couldBeContextName(query: string): boolean {
  const q = query.trim()
  return q.length > 0 && q.length <= MAX_NAME_LENGTH && !q.includes('\n')
}

export function emptyStateMessage(query: string): string {
  return couldBeContextName(query)
    ? `No matches — Enter creates a context named “${query.trim()}”`
    : 'No matches'
}
