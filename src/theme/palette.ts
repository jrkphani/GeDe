// STYLE_GUIDE §2.3 — dimension data palette seeds (no green slots; green is
// chrome). Assigned to dimensions in creation order, user-overridable.
export const DIMENSION_PALETTE = [
  '#6F5BD6', // violet
  '#0E8A93', // teal
  '#D9542B', // orange
  '#C0448F', // magenta
  '#A87F1A', // ochre
  '#3D6BD6', // blue
  '#C75D73', // rose
  '#647E93', // slate
] as const

export function paletteColor(index: number): string {
  return DIMENSION_PALETTE[index % DIMENSION_PALETTE.length] as string
}

// Issue 038 (presence) — a small, deliberately separate palette for
// collaborator identity chrome. Design brief: "a collaborator's cue uses a
// per-user chrome colour distinct from the *data* palette ... so presence
// never reads as a dimension" (STYLE_GUIDE §2 principle 3: color is data,
// dimensions only). No hex value here is shared with DIMENSION_PALETTE above,
// and — like every other chrome hue in this app — never green (§2.2: green is
// the one reserved chrome accent). Presence also renders these through a
// different shape vocabulary than dimension swatches (an identity dot beside
// a row, a chip in the app bar — never an arc or a combobox option fill), so
// the disjoint hue set is belt-and-braces, not the only thing doing the work.
export const PRESENCE_PALETTE = [
  '#7C4DBD', // orchid-violet
  '#1B7F8E', // deep teal
  '#BD5B27', // burnt orange
  '#9C3F73', // magenta-plum
  '#3E5C99', // indigo-blue
  '#8A6D1E', // dark gold
] as const

export function presenceColor(index: number): string {
  return PRESENCE_PALETTE[index % PRESENCE_PALETTE.length] as string
}
