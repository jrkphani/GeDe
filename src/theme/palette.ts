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
