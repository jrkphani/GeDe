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

// Ranks and caps the palette's results. Ties break by recency (recent-first),
// then by original order for stability. An empty query lists everything
// recent-first (max 8) so the palette opens showing recent destinations.
export function rankCommands(
  items: readonly CommandItem[],
  query: string,
  recentIds: readonly string[],
  limit = 8,
): CommandItem[] {
  const q = query.trim().toLowerCase()
  const recencyRank = (id: string): number => {
    const i = recentIds.indexOf(id)
    return i === -1 ? Number.POSITIVE_INFINITY : i
  }

  const scored: { item: CommandItem; index: number; score: number }[] = []
  items.forEach((item, index) => {
    const score = q === '' ? 0 : matchScore(item, q)
    if (score !== null) scored.push({ item, index, score })
  })

  scored.sort(
    (a, b) =>
      a.score - b.score ||
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
