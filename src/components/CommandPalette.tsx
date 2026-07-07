import { useEffect, useRef, useState } from 'react'
import { CommandDialog, CommandInput, CommandItem, CommandList } from './ui/command'
import { useCommandRegistryStore } from '../store/commandRegistry'
import { emptyStateMessage, rankCommands, type CommandKind } from '../domain/paletteRanking'
import { useSemanticSearchStore } from '../store/semanticSearch'

// Issue 017 — the ⌘K command palette. Feature-agnostic by construction: it
// reads only the command registry (SITEMAP §3) and the pure ranking module,
// never a feature module. The shell registers the navigation/verb sources.
//
// Composed from ui/command's CommandDialog (Radix Dialog under the hood), so it
// inherits the focus trap and Esc-to-close. cmdk's dialog renders no Radix
// trigger, so it can't restore focus itself — the palette instead tells its
// caller *why* it closed (`navigated`): a dismissal (Esc/backdrop) restores
// focus to the origin element, a navigation moves it to the new surface. The
// caller (AppShell) owns that focus move because it captured the origin.
//
// Issue 042 — semantic search reads/writes `useSemanticSearchStore` (debounced
// query embed -> blended into `rankCommands`), but never *triggers* the
// model load itself (`ensureModel`) — that stays a shell-owned side effect
// (AppShell, mirroring how it owns registering command sources), so this
// component stays feature-agnostic and this file's own tests never touch the
// model or the network: with the store left in its default `idle` state,
// `scoreQuery` below is a guaranteed no-op and results are pure-lexical,
// which is exactly issue 042's graceful-degradation contract.

const KIND_LABEL: Record<CommandKind, string> = {
  tier: 'tier',
  canvas: 'canvas',
  context: 'context',
  action: 'action',
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean
  onClose: (navigated: boolean) => void
}) {
  // Subscribe so a late registration (or a new recent) re-ranks while open.
  const providers = useCommandRegistryStore((s) => s.providers)
  const recentIds = useCommandRegistryStore((s) => s.recentIds)
  const collect = useCommandRegistryStore((s) => s.collect)
  const markUsed = useCommandRegistryStore((s) => s.markUsed)
  const [query, setQuery] = useState('')

  // Issue 042 — the semantic layer's read side. `scoredQuery`/`scores` are
  // only trusted when `scoredQuery` matches the *current* (trimmed) query —
  // a debounced embed for an older keystroke, or the store's untouched
  // `idle`-state defaults, both fall through to `undefined`, which
  // `rankCommands` treats as "no semantic scores at all" (pure lexical).
  const scoredQuery = useSemanticSearchStore((s) => s.query)
  const scores = useSemanticSearchStore((s) => s.scores)
  const scoreQuery = useSemanticSearchStore((s) => s.scoreQuery)

  // Each open starts empty (recent-first list); providers is a dep so this also
  // settles once the shell's sources are registered.
  useEffect(() => {
    if (open) setQuery('')
  }, [open])
  void providers // read for subscription; results are re-collected below

  const items = open ? collect() : []

  // Latest items are read from a ref inside the debounced timer below so the
  // effect only needs to key on the query itself, never on `items`'
  // per-render identity (it's a fresh array every render).
  const itemsRef = useRef(items)
  itemsRef.current = items

  // Debounced (issue 042 design brief: "the query embed is debounced and
  // never gates the visible results") — the lexical `ranked` below is
  // computed synchronously every render regardless of this effect's state.
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed === '') return
    const timer = setTimeout(() => {
      void scoreQuery(trimmed, itemsRef.current)
    }, 150)
    return () => clearTimeout(timer)
  }, [open, query, scoreQuery])

  const semanticScores = scoredQuery === query.trim() ? scores : undefined
  const ranked = rankCommands(items, query, recentIds, { semanticScores })

  function execute(id: string) {
    const item = ranked.find((r) => r.id === id)
    if (!item) return
    markUsed(item.id)
    onClose(true)
    item.run()
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose(false)
      }}
      label="Command palette"
      shouldFilter={false}
      overlayClassName="command-palette__overlay"
      contentClassName="command-palette"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Jump to a tier, canvas, context — or run a command…"
      />
      <CommandList className="command-palette__list">
        {ranked.length === 0 ? (
          <div className="command-palette__empty" role="status">
            {emptyStateMessage(query)}
          </div>
        ) : (
          ranked.map((item) => (
            <CommandItem
              key={item.id}
              value={item.id}
              onSelect={execute}
              className="command-palette__row"
            >
              {item.symbol ? <span className="command-palette__symbol">{item.symbol}</span> : null}
              {/* Skip the title when it only repeats the symbol (an unnamed
                  context) — the mono chip already carries it. */}
              {item.title !== item.symbol ? (
                <span className="command-palette__title">{item.title}</span>
              ) : null}
              <span className="command-palette__kind">{KIND_LABEL[item.kind]}</span>
            </CommandItem>
          ))
        )}
      </CommandList>
    </CommandDialog>
  )
}
