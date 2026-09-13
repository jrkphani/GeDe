import { act, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TourTarget } from './steps.js';
import { measureTarget, paintedRect, targetSelectors, useSpotlight } from './use-spotlight.js';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function boxed(el: HTMLElement, box: Box): void {
  el.getBoundingClientRect = () => ({
    ...box,
    right: box.left + box.width,
    bottom: box.top + box.height,
    x: box.left,
    y: box.top,
    toJSON: () => box,
  });
}

/** A `data-tour` anchor whose box the test controls. */
function anchor(
  box: Box,
  target: TourTarget = 'graph',
  parent: HTMLElement = document.body,
  attributes: Record<string, string> = {},
): HTMLElement {
  const el = document.createElement('button');
  el.setAttribute('data-tour', target);
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
  boxed(el, box);
  parent.appendChild(el);
  return el;
}

function Probe({ target, pairId = null }: { target: TourTarget | null; pairId?: string | null }) {
  const rect = useSpotlight(targetSelectors(target, pairId));
  return (
    <output data-testid="rect">
      {rect === null
        ? 'none'
        : `${String(rect.x)},${String(rect.y)},${String(rect.width)},${String(rect.height)}`}
    </output>
  );
}

/** Run every pending animation frame. */
async function frame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('useSpotlight', () => {
  it('ONB-04 measures the anchor by bounding box and re-measures on scroll, resize, zoom, layout change and a settled transition — never on a timer', async () => {
    const el = anchor({ left: 10.4, top: 20, width: 100, height: 30 });
    render(<Probe target="graph" />);
    expect(screen.getByTestId('rect')).toHaveTextContent('10,20,100,30');

    // Scroll: the box moved.
    el.getBoundingClientRect = () => ({
      left: 10,
      top: 5,
      width: 100,
      height: 30,
      right: 110,
      bottom: 35,
      x: 10,
      y: 5,
      toJSON: () => ({}),
    });
    window.dispatchEvent(new Event('scroll'));
    await frame();
    expect(screen.getByTestId('rect')).toHaveTextContent('10,5,100,30');

    // Resize: the box grew.
    el.getBoundingClientRect = () => ({
      left: 10,
      top: 5,
      width: 140,
      height: 30,
      right: 150,
      bottom: 35,
      x: 10,
      y: 5,
      toJSON: () => ({}),
    });
    window.dispatchEvent(new Event('resize'));
    await frame();
    expect(screen.getByTestId('rect')).toHaveTextContent('10,5,140,30');

    // Layout change: a mutation anywhere in the document re-measures.
    el.getBoundingClientRect = () => ({
      left: 10,
      top: 60,
      width: 140,
      height: 30,
      right: 150,
      bottom: 90,
      x: 10,
      y: 60,
      toJSON: () => ({}),
    });
    document.body.appendChild(document.createElement('p'));
    await frame();
    await frame();
    expect(screen.getByTestId('rect')).toHaveTextContent('10,60,140,30');

    // A CSS transition or animation on an ancestor moved it: re-measured when it ends.
    el.getBoundingClientRect = () => ({
      left: 40,
      top: 60,
      width: 140,
      height: 30,
      right: 180,
      bottom: 90,
      x: 40,
      y: 60,
      toJSON: () => ({}),
    });
    document.body.dispatchEvent(new Event('transitionend'));
    await frame();
    expect(screen.getByTestId('rect')).toHaveTextContent('40,60,140,30');
    el.getBoundingClientRect = () => ({
      left: 50,
      top: 60,
      width: 140,
      height: 30,
      right: 190,
      bottom: 90,
      x: 50,
      y: 60,
      toJSON: () => ({}),
    });
    document.body.dispatchEvent(new Event('animationend'));
    await frame();
    expect(screen.getByTestId('rect')).toHaveTextContent('50,60,140,30');

    // The prototype polled every 350 ms; the build never does (ONB-04).
    const source = readFileSync(join(__dirname, 'use-spotlight.ts'), 'utf8');
    expect(source).not.toMatch(/setInterval|setTimeout/);
  });

  it('ONB-04 an anchor that mounts later is found on its mutation; one that unmounts drops the spotlight', async () => {
    render(<Probe target="graph" />);
    expect(screen.getByTestId('rect')).toHaveTextContent('none');
    const el = anchor({ left: 1, top: 2, width: 3, height: 4 });
    await frame();
    await frame();
    expect(screen.getByTestId('rect')).toHaveTextContent('1,2,3,4');
    el.remove();
    await frame();
    await frame();
    expect(screen.getByTestId('rect')).toHaveTextContent('none');
  });

  it('ONB-06 a step without a target has no spotlight, and a collapsed anchor counts as absent', () => {
    render(<Probe target={null} />);
    expect(screen.getByTestId('rect')).toHaveTextContent('none');
    anchor({ left: 0, top: 0, width: 0, height: 0 });
    expect(measureTarget('graph')).toBeNull();
    expect(measureTarget('find')).toBeNull();
  });

  it('ONB-04 GRAPH-03 the `point` card spotlights every pointing target at once: the box is their union, and a target that unmounts shrinks it', async () => {
    const deliverables = anchor({ left: 100, top: 200, width: 400, height: 150 }, 'pointing');
    anchor({ left: 700, top: 210, width: 200, height: 90 }, 'pointing');
    render(<Probe target="pointing" />);
    expect(screen.getByTestId('rect')).toHaveTextContent('100,200,800,150');
    deliverables.remove();
    await frame();
    await frame();
    expect(screen.getByTestId('rect')).toHaveTextContent('700,210,200,90');
  });

  it("ONB-04 GRAPH-05 the `dimensions` card spotlights the checklist, and falls back to the ring of the pair the person made while the checklist is not on screen — or to the collapsed rail's Expand control while that ring is selected (RESP-03)", async () => {
    const ring = document.createElement('section');
    ring.setAttribute('data-pair-id', 'pair-1');
    ring.setAttribute('data-graph-kind', 'ring');
    boxed(ring, { left: 40, top: 300, width: 320, height: 200 });
    document.body.appendChild(ring);
    const expand = anchor({ left: 1400, top: 60, width: 44, height: 44 }, 'inspector-expand');
    // A ring of another pair never stands in.
    const other = document.createElement('section');
    other.setAttribute('data-pair-id', 'pair-0');
    other.setAttribute('data-graph-kind', 'ring');
    boxed(other, { left: 500, top: 300, width: 320, height: 200 });
    document.body.appendChild(other);
    render(<Probe target="dimensions" pairId="pair-1" />);
    expect(screen.getByTestId('rect')).toHaveTextContent('40,300,320,200');
    const checklist = anchor({ left: 900, top: 120, width: 280, height: 160 }, 'dimensions');
    await frame();
    await frame();
    expect(screen.getByTestId('rect')).toHaveTextContent('900,120,280,160');
    checklist.remove();
    await frame();
    await frame();
    expect(screen.getByTestId('rect')).toHaveTextContent('40,300,320,200');
    // The ring is selected and the checklist is still gone: the rail is collapsed, so the
    // Expand control is what brings the checklist back.
    ring.setAttribute('data-selected', 'true');
    await frame();
    await frame();
    expect(screen.getByTestId('rect')).toHaveTextContent('1400,60,44,44');
    // With the rail open (no Expand control) and the graph selected but no checklist yet, the ring.
    expand.remove();
    await frame();
    await frame();
    expect(screen.getByTestId('rect')).toHaveTextContent('40,300,320,200');
    // Without a pair there is nothing to fall back to.
    expect(measureTarget(targetSelectors('dimensions', null))).toBeNull();
  });

  it('ONB-04 INSP-02 a checklist inside the scrolling inspector rail is spotlit only where it shows, and re-measures when the rail scrolls', async () => {
    const rail = document.createElement('aside');
    rail.style.overflowY = 'auto';
    boxed(rail, { left: 800, top: 100, width: 300, height: 400 });
    document.body.appendChild(rail);
    // The checklist starts 60 px above the rail's top and runs below its bottom.
    const checklist = anchor({ left: 820, top: 40, width: 260, height: 700 }, 'dimensions', rail);
    expect(paintedRect(checklist)).toEqual({ x: 820, y: 100, width: 260, height: 400 });
    render(<Probe target="dimensions" pairId="pair-1" />);
    expect(screen.getByTestId('rect')).toHaveTextContent('820,100,260,400');
    // Scrolling the rail (not the window) moves the checklist: the capturing listener sees it.
    boxed(checklist, { left: 820, top: 300, width: 260, height: 700 });
    rail.dispatchEvent(new Event('scroll'));
    await frame();
    expect(screen.getByTestId('rect')).toHaveTextContent('820,300,260,200');
    // Scrolled clean out of the rail, it paints nothing and counts as absent.
    boxed(checklist, { left: 820, top: 600, width: 260, height: 700 });
    rail.dispatchEvent(new Event('scroll'));
    await frame();
    expect(screen.getByTestId('rect')).toHaveTextContent('none');
  });
});
