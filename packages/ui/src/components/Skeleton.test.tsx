import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Skeleton } from './Skeleton.js';

describe('Skeleton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('LOAD-01 shows nothing before the 200 ms delay, then a content-shaped skeleton', () => {
    const { container } = render(<Skeleton active rows={3} />);
    expect(container.querySelector('.gd-skeleton')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(container.querySelector('.gd-skeleton')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const sk = container.querySelector('.gd-skeleton');
    expect(sk).toHaveAttribute('aria-busy', 'true');
    expect(sk?.querySelector('.gd-skeleton__bars')).toHaveAttribute('aria-hidden', 'true');
    expect(sk?.querySelectorAll('.gd-skeleton__bar')).toHaveLength(3);
  });

  it('LOAD-03 keeps the 22 px lattice row when rows are given', () => {
    const { container } = render(<Skeleton active rows={2} />);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const sk = container.querySelector<HTMLElement>('.gd-skeleton');
    expect(sk).toHaveClass('gd-skeleton--lattice');
    expect(sk?.style.getPropertyValue('--gd-skeleton-row')).toBe('22px');
  });

  it('LOAD-02 holds for 400 ms once shown', () => {
    const { container, rerender } = render(<Skeleton active>{'ready'}</Skeleton>);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender(<Skeleton active={false}>{'ready'}</Skeleton>);
    expect(container.querySelector('.gd-skeleton')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(container.querySelector('.gd-skeleton')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector('.gd-skeleton')).toBeNull();
    expect(container).toHaveTextContent('ready');
  });

  it('never appears for a fast load', () => {
    const { container, rerender } = render(<Skeleton active>{'ready'}</Skeleton>);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender(<Skeleton active={false}>{'ready'}</Skeleton>);
    expect(container.querySelector('.gd-skeleton')).toBeNull();
    expect(container).toHaveTextContent('ready');
  });

  it('LOAD-01 tier 3 names the object in a polite status line after one second', () => {
    render(<Skeleton active statusLabel="Loading 1Cloudhub - Workscape" />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Loading 1Cloudhub - Workscape');
  });

  it('LOAD-07 under prefers-reduced-motion the bars are a flat tint with no shimmer', () => {
    const css = readFileSync(resolve(__dirname, 'Skeleton.css'), 'utf8');
    const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1];
    expect(reduced).toBeDefined();
    expect(reduced).toMatch(/\.gd-skeleton__bar\s*\{[^}]*background:\s*var\(--skeleton-base\)/);
    expect(reduced).not.toMatch(/animation/);
    // The shimmer itself runs on the token, not a literal duration.
    expect(css).toMatch(/animation:\s*gd-shimmer var\(--skeleton-speed\)/);
  });
});
