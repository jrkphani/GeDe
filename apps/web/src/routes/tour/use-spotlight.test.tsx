import { act, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { measureTarget, useSpotlight } from './use-spotlight.js';

/** A `data-tour` anchor whose box the test controls. */
function anchor(box: { left: number; top: number; width: number; height: number }): HTMLElement {
  const el = document.createElement('button');
  el.setAttribute('data-tour', 'graph');
  el.getBoundingClientRect = () => ({
    ...box,
    right: box.left + box.width,
    bottom: box.top + box.height,
    x: box.left,
    y: box.top,
    toJSON: () => box,
  });
  document.body.appendChild(el);
  return el;
}

function Probe({ target }: { target: 'graph' | null }) {
  const rect = useSpotlight(target);
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
});
