// STYLE_GUIDE §3 — the *method* writes rank/degree notation in JetBrains Mono:
// `1°`, `2°`… Pure so the tier-1 rank cell (issue 013) and any later degree
// readout share one formatter instead of scattering the glyph.
export function formatDegree(rank: number): string {
  return `${rank}°`
}
