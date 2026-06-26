import type { PersistedState, Settings, Stats } from './types';
import { DEFAULT_SETTINGS, DEFAULT_STATS } from './types';
import { emptyHeroProfile } from '../ai/profile';

const KEY = 'texas-poker-trainer:v1';
const MAX_HISTORY = 200;

export function loadPersisted(): PersistedState {
  const fallback: PersistedState = {
    settings: { ...DEFAULT_SETTINGS },
    stats: { ...DEFAULT_STATS, profitCurve: [] },
    heroProfile: emptyHeroProfile(),
    history: [],
  };

  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings as Settings) },
      stats: { ...DEFAULT_STATS, ...(parsed.stats as Stats) },
      heroProfile: parsed.heroProfile ?? emptyHeroProfile(),
      history: (parsed.history ?? []).slice(-MAX_HISTORY),
    };
  } catch {
    return fallback;
  }
}

export function savePersisted(state: PersistedState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const trimmed: PersistedState = {
      ...state,
      history: state.history.slice(-MAX_HISTORY),
    };
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore quota / serialization errors; persistence is best-effort.
  }
}

export function clearPersisted(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
