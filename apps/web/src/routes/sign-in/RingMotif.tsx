/**
 * The ring motif from option 1c: outer ring r=200, inner ring r=130, three
 * nodes with spokes from the centre — an orbit/ring-graph preview of what the
 * product does. Decorative; inherits `currentColor`.
 */
export function RingMotif({ className }: { className?: string | undefined }) {
  const nodes = [
    { angle: -90, r: 200 },
    { angle: 30, r: 130 },
    { angle: 150, r: 200 },
  ];
  const toXY = (angle: number, r: number) => {
    const rad = (angle * Math.PI) / 180;
    return { x: 250 + r * Math.cos(rad), y: 250 + r * Math.sin(rad) };
  };
  return (
    <svg
      className={className}
      viewBox="0 0 500 500"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="250" cy="250" r="200" strokeWidth="1.5" opacity="0.55" />
      <circle cx="250" cy="250" r="130" strokeWidth="1.5" opacity="0.35" />
      {nodes.map((n) => {
        const p = toXY(n.angle, n.r);
        return (
          <g key={n.angle}>
            <line x1="250" y1="250" x2={p.x} y2={p.y} strokeWidth="1.2" opacity="0.5" />
            <circle cx={p.x} cy={p.y} r="9" fill="currentColor" stroke="none" />
          </g>
        );
      })}
      <circle cx="250" cy="250" r="6" fill="currentColor" stroke="none" />
    </svg>
  );
}
