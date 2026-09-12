// GeDe theme object. Generated from tokens.css — keep in sync.
// prettier-ignore
export const theme = {
  color: {
    brand:    { subtle: '#f0f7f3', base: '#14532d', strong: '#0a2d18' },
    live:     { subtle: '#fdf6ec', base: '#b45309', strong: '#7c3a05' },
    surface:  { base: '#ffffff', sunken: '#f7f9f8', border: '#e3e8e5' },
    ink:      { base: '#14201a', muted: '#5b6b63', onBrand: '#ffffff' },
    status:   { success: '#166534', warning: '#b45309', danger: '#b42318', info: '#155e75' },
    presence: ['#14201a', '#155e75', '#6d28d9', '#b45309', '#0f766e', '#9d174d'],
  },
  space: [0, 4, 8, 12, 16, 24, 32, 48, 64],
  radius: { none: 0, sm: 3, md: 6, lg: 10, pill: 999 },
  font: {
    ui: "'Helvetica Neue', Helvetica, Arial, 'Noto Sans Tamil', 'Noto Sans Devanagari', 'Noto Sans Telugu', sans-serif",
    mono: "'IBM Plex Mono', monospace",
  },
  text: {
    display: { size: '2.5rem',     weight: 600, lh: 1.05, ls: '-0.04em' },
    h1:      { size: '1.75rem',    weight: 600, lh: 1.15, ls: '-0.03em' },
    h2:      { size: '1.25rem',    weight: 600, lh: 1.25, ls: '-0.02em' },
    h3:      { size: '1rem',       weight: 600, lh: 1.35, ls: '-0.01em' },
    body:    { size: '0.9375rem',  weight: 400, lh: 1.6,  ls: '0' },
    bodySm:  { size: '0.8125rem',  weight: 400, lh: 1.55, ls: '0' },
    cell:    { size: '0.71875rem', weight: 400, lh: 1.35, ls: '0' },
    monoCell:{ size: '0.625rem',   weight: 400, lh: 1.3,  ls: '0.01em' },
    label:   { size: '0.5625rem',  weight: 500, lh: 1.2,  ls: '0.08em' },
  },
  motion: {
    fast:     { duration: 120, easing: 'cubic-bezier(0,0,0.2,1)' },
    base:     { duration: 180, easing: 'cubic-bezier(0.2,0,0,1)' },
    emphasis: { duration: 240, easing: 'cubic-bezier(0.2,0.8,0.2,1)' },
    enter:    { duration: 300, easing: 'cubic-bezier(0,0,0.15,1)' },
  },
  loading: { delay: 200, minHold: 400, shimmer: 1400 },
  breakpoint: { xs: 0, sm: 480, md: 768, lg: 1024, xl: 1440 },
  lattice: { col: 160, row: 22 },
} as const;

export type Theme = typeof theme;
