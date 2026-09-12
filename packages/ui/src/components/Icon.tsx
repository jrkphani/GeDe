import type { SVGAttributes } from 'react';
import clsx from 'clsx';

/**
 * GeDe icon set — one family, one construction: 18 × 18 grid, 1 px keyline
 * inset, 1.3 px stroke, round caps and joins, `currentColor`, no fills except
 * nodes. Paths are the sprite; the component inlines them so an icon renders
 * with nothing else mounted.
 */
export const ICON_NAMES = [
  // structure
  'table',
  'add-row',
  'add-column',
  'graph',
  'sheet',
  'shaped-table',
  // data
  'sort',
  'filter',
  'group',
  'formula',
  'reference',
  'derive',
  // view
  'gridlines',
  'zoom-in',
  'zoom-out',
  'fit',
  'pin',
  'collapse-rail',
  'edges',
  // document
  'share',
  'people',
  'link',
  'download',
  'delete',
  'recover',
  'more',
  // state
  'complete',
  'draft',
  'warning',
  'error',
  'locked',
  'loading',
  // identity
  'passkey',
  'apple',
  // find (FIND-01, FIND-02)
  'search',
  'settings',
  'chevron-left',
  'chevron-right',
  // sort, filter, group (SORT-01): the header's ▼ and its ↑ ↓ state glyphs
  'chevron-down',
  'check',
  'arrow-up',
  'arrow-down',
] as const;

export type IconName = (typeof ICON_NAMES)[number];
export type IconSize = 13 | 15 | 18;

interface Glyph {
  /** Stroked path data on the 18 × 18 grid. */
  d: string;
  /** Extra stroked elements (dashed strokes, filled nodes). */
  extra?: readonly GlyphExtra[];
}
type GlyphExtra =
  | { kind: 'node'; cx: number; cy: number; r: number }
  | { kind: 'dashed'; d: string }
  | { kind: 'fill'; d: string; viewBox: string };

const FRAME =
  'M3 3h12a1.6 1.6 0 0 1 1.6 1.6v8.8a1.6 1.6 0 0 1-1.6 1.6H3a1.6 1.6 0 0 1-1.6-1.6V4.6A1.6 1.6 0 0 1 3 3z';

const GLYPHS: Record<IconName, Glyph> = {
  table: { d: `${FRAME}M1.4 7h15.2M7 3v12M12 3v12` },
  'add-row': { d: 'M2 3h14M2 7h14M2 11h8M13 11v6M10 14h6' },
  'add-column': { d: 'M3 2v14M7 2v14M11 2v8M11 13h6M14 10v6' },
  graph: {
    d: 'M9 4.2v3.6M6.2 12.6l2-3.1M11.8 12.6l-2-3.1',
    extra: [
      { kind: 'node', cx: 9, cy: 3, r: 1.6 },
      { kind: 'node', cx: 4.5, cy: 14, r: 1.6 },
      { kind: 'node', cx: 13.5, cy: 14, r: 1.6 },
    ],
  },
  sheet: { d: 'M4 1.6h7l3.4 3.4V16.4H4zM11 1.6V5h3.4M6.5 9h5M6.5 12h5' },
  'shaped-table': { d: 'M2 3h14v4H2zM2 7v8h6V7M8 15h8v-4H8' },
  sort: { d: 'M5 2.5v13M2.5 12.5l2.5 3 2.5-3M13 15.5v-13M10.5 5.5l2.5-3 2.5 3' },
  filter: { d: 'M2 3h14l-5.4 6.2v5.3l-3.2-1.7V9.2z' },
  group: { d: 'M2.5 2.5h13v4h-13zM2.5 11.5h13v4h-13zM5.5 6.5v5M12.5 6.5v5' },
  formula: { d: 'M13 2.8c-2.6-.7-3.9.6-4.3 3.2L7.2 15c-.3 1.6-1.5 2.1-3.2 1.4M5 8.6h7' },
  reference: { d: 'M4 4h5M4 4v5M4 4l5.5 5.5M9 14h5M14 14V9M14 14 8.5 8.5' },
  derive: { d: 'M2.5 4.5h6a3 3 0 0 1 3 3v6M8.5 10.5l3 3 3-3M2.5 9h4M2.5 13.5h4' },
  gridlines: { d: 'M2 2h14v14H2zM2 6.7h14M2 11.3h14M6.7 2v14M11.3 2v14' },
  'zoom-in': {
    d: 'M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM12 12l3.8 3.8M8 5.6v4.8M5.6 8h4.8',
  },
  'zoom-out': { d: 'M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM12 12l3.8 3.8M5.6 8h4.8' },
  fit: { d: 'M2 6.5V2h4.5M11.5 2H16v4.5M16 11.5V16h-4.5M6.5 16H2v-4.5M6 6h6v6H6z' },
  pin: { d: 'M6.5 2.5h5l-.8 4.3 2.8 2.7v1.5H4.5V9.5l2.8-2.7zM9 11v5' },
  'collapse-rail': { d: 'M2 3h14v12H2zM11 3v12M8 6.5 5.5 9 8 11.5' },
  edges: {
    d: 'M5 5.5l8 7',
    extra: [
      { kind: 'node', cx: 4, cy: 4.5, r: 1.8 },
      { kind: 'node', cx: 14, cy: 13.5, r: 1.8 },
    ],
  },
  share: {
    d: 'M9 11V2.5M5.5 6 9 2.5 12.5 6M3.5 9.5v5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-5',
  },
  people: {
    d: 'M7 8.5a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6zM1.8 15.5c.5-3 2.6-4.4 5.2-4.4s4.7 1.4 5.2 4.4M12.2 3.4a2.6 2.6 0 0 1 0 4.8M13.6 11.6c1.5.6 2.4 1.9 2.7 3.9',
  },
  link: {
    d: 'M7.5 10.5 10.5 7.5M6 12l-1.5 1.5a2.5 2.5 0 0 1-3.5-3.5L4 7M12 6l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L14 11',
  },
  download: {
    d: 'M9 2.5v9M5.5 8 9 11.5 12.5 8M3 13.5v1a1.5 1.5 0 0 0 1.5 1.5h9a1.5 1.5 0 0 0 1.5-1.5v-1',
  },
  delete: {
    d: 'M3 4.5h12M7 4.5V3h4v1.5M4.5 4.5l.8 10a1.5 1.5 0 0 0 1.5 1.4h4.4a1.5 1.5 0 0 0 1.5-1.4l.8-10M7.3 8v5M10.7 8v5',
  },
  recover: { d: 'M3.2 8.3A6 6 0 1 1 5 13.4M3 4.5v4h4' },
  more: {
    d: '',
    extra: [
      { kind: 'node', cx: 4, cy: 9, r: 1.4 },
      { kind: 'node', cx: 9, cy: 9, r: 1.4 },
      { kind: 'node', cx: 14, cy: 9, r: 1.4 },
    ],
  },
  complete: { d: 'M9 1.8a7.2 7.2 0 1 1 0 14.4A7.2 7.2 0 0 1 9 1.8zM5.8 9.2l2.2 2.2 4.2-4.6' },
  draft: {
    d: '',
    extra: [{ kind: 'dashed', d: 'M9 1.8a7.2 7.2 0 1 1 0 14.4A7.2 7.2 0 0 1 9 1.8z' }],
  },
  warning: { d: 'M9 2.2 16.4 15H1.6zM9 7v3.6', extra: [{ kind: 'node', cx: 9, cy: 12.8, r: 0.8 }] },
  error: { d: 'M9 1.8a7.2 7.2 0 1 1 0 14.4A7.2 7.2 0 0 1 9 1.8zM6.5 6.5l5 5M11.5 6.5l-5 5' },
  locked: {
    d: 'M4.5 8V6a4.5 4.5 0 0 1 9 0v2M3.5 8h11v7.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z',
    extra: [{ kind: 'node', cx: 9, cy: 12, r: 1 }],
  },
  loading: { d: '', extra: [{ kind: 'dashed', d: 'M9 1.8a7.2 7.2 0 1 1-6.9 5' }] },
  passkey: {
    d: 'M6.5 8.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM1.5 15.5c.4-3 2.5-4.5 5-4.5 1 0 1.9.2 2.6.6M11.5 10.5l4.5 4.5M13.5 12.5l1.5-1.5',
    extra: [{ kind: 'node', cx: 13.4, cy: 8.4, r: 1.9 }],
  },
  search: { d: 'M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM12 12l3.8 3.8' },
  settings: {
    d: 'M9 2.2l1.4 1.5 2-.4.9 1.9 1.9.9-.4 2L16.3 9l-1.5 1.4.4 2-1.9.9-.9 1.9-2-.4L9 15.8l-1.4-1.5-2 .4-.9-1.9-1.9-.9.4-2L1.7 9l1.5-1.4-.4-2 1.9-.9.9-1.9 2 .4z',
    extra: [{ kind: 'node', cx: 9, cy: 9, r: 2.2 }],
  },
  'chevron-left': { d: 'M11 3.5 5.5 9l5.5 5.5' },
  'chevron-right': { d: 'M7 3.5 12.5 9 7 14.5' },
  'chevron-down': { d: 'M3.5 7 9 12.5 14.5 7' },
  check: { d: 'M3.5 9.5l3.5 3.5 7.5-8' },
  'arrow-up': { d: 'M9 15.5v-13M4.5 7.5 9 2.5l4.5 5' },
  'arrow-down': { d: 'M9 2.5v13M4.5 10.5 9 15.5l4.5-5' },
  apple: {
    d: '',
    extra: [
      {
        kind: 'fill',
        viewBox: '0 0 24 24',
        // Apple logo — the widely published Simple Icons path (CC0), never a substitute character.
        d: 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701',
      },
    ],
  },
};

export interface IconProps extends Omit<SVGAttributes<SVGSVGElement>, 'name' | 'width' | 'height'> {
  name: IconName;
  size?: IconSize | undefined;
  /** Accessible name. Omit when the icon is decorative next to a text label. */
  label?: string | undefined;
}

export function Icon({ name, size = 15, label, className, ...rest }: IconProps) {
  const glyph = GLYPHS[name];
  const fill = glyph.extra?.find((e) => e.kind === 'fill');
  const a11y =
    label === undefined ? { 'aria-hidden': true as const } : { role: 'img', 'aria-label': label };
  return (
    <svg
      className={clsx('gd-icon', `gd-icon--${name}`, className)}
      width={size}
      height={size}
      viewBox={fill?.viewBox ?? '0 0 18 18'}
      fill="none"
      stroke="currentColor"
      strokeWidth={fill ? 0 : 1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      data-name={name}
      {...a11y}
      {...rest}
    >
      {glyph.d !== '' && <path d={glyph.d} />}
      {glyph.extra?.map((e, i) => {
        switch (e.kind) {
          case 'node':
            return <circle key={i} cx={e.cx} cy={e.cy} r={e.r} fill="currentColor" stroke="none" />;
          case 'dashed':
            return <path key={i} d={e.d} strokeDasharray="2.2 2.2" />;
          case 'fill':
            return <path key={i} d={e.d} fill="currentColor" stroke="none" />;
        }
      })}
    </svg>
  );
}
