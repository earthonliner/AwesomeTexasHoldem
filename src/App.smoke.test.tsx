// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import App from './App';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('App smoke', () => {
  it('renders the start screen without crashing', () => {
    render(<App />);
    expect(screen.getByText('德州扑克练习')).toBeTruthy();
    expect(screen.getByText('开始游戏')).toBeTruthy();
  });

  it('starts a table and renders the felt + action area', () => {
    vi.useFakeTimers();
    render(<App />);
    act(() => {
      fireEvent.click(screen.getByText('开始游戏'));
    });
    // Header for an in-progress table should appear.
    expect(screen.getByText('换桌')).toBeTruthy();
    expect(screen.getAllByText(/底池/).length).toBeGreaterThan(0);
    // Let any scheduled AI timers run; the loop must not throw.
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    vi.useRealTimers();
  });
});
