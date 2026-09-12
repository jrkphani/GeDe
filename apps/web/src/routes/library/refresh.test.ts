import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIBRARY_REFRESH_MS, useLibraryRefresh } from './refresh.js';

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

describe('useLibraryRefresh (LIB-D11)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('LIB-D11 re-reads on the cadence while visible, at once when the tab becomes visible or the window regains focus, and never while hidden', () => {
    const refresh = vi.fn();
    renderHook(() => {
      useLibraryRefresh(refresh, { intervalMs: 1000 });
    });
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(refresh).toHaveBeenCalledTimes(3);

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(5000);
    expect(refresh).toHaveBeenCalledTimes(3);

    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(refresh).toHaveBeenCalledTimes(4);
    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(5);
  });

  it('LIB-D11 uses the latest callback without restarting the timer, and stops when disabled or unmounted', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ cb, enabled }: { cb: () => void; enabled: boolean }) => {
        useLibraryRefresh(cb, { intervalMs: 1000, enabled });
      },
      { initialProps: { cb: first, enabled: true } },
    );
    vi.advanceTimersByTime(600);
    rerender({ cb: second, enabled: true });
    vi.advanceTimersByTime(400);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    rerender({ cb: second, enabled: false });
    vi.advanceTimersByTime(3000);
    expect(second).toHaveBeenCalledTimes(1);
    rerender({ cb: second, enabled: true });
    unmount();
    vi.advanceTimersByTime(3000);
    window.dispatchEvent(new Event('focus'));
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('LIB-D11 the default cadence stays inside the per-user request budget', () => {
    // 300 requests a minute per user (services/sync RATE_LIMIT_PER_MINUTE): one
    // tab at this cadence spends four of them.
    expect(60_000 / LIBRARY_REFRESH_MS).toBeLessThanOrEqual(4);
  });
});
