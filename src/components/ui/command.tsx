/*
 * Command primitive (issue 019) — the single import point for cmdk, so no
 * component imports `cmdk` directly (Phase 3 lint enforces this). Re-exported
 * as-is today; this is the seam for shared command-menu styling later.
 */
export { Command, CommandInput, CommandList, CommandEmpty, CommandItem } from 'cmdk'
