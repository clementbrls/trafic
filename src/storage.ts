import type { Lang } from './i18n';
import type { MapId } from './game/maps';

export type ThemePref = 'auto' | 'light' | 'dark';

export interface Settings {
  sound: boolean;
  music: boolean;
  volume: number;
  theme: ThemePref;
  lang: Lang | null;
  tutorialDone: boolean;
  lastMap: MapId;
}

const KEY = 'trafic.v1';

interface Saved {
  settings: Settings;
  best: Partial<Record<MapId, { score: number; week: number; date: number }>>;
  games: number;
}

function defaults(): Saved {
  return {
    settings: { sound: true, music: true, volume: 0.8, theme: 'auto', lang: null, tutorialDone: false, lastMap: 'plaine' },
    best: {},
    games: 0,
  };
}

let cache: Saved | null = null;

function load(): Saved {
  if (cache) return cache;
  const d = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Saved>;
      cache = {
        settings: { ...d.settings, ...(parsed.settings ?? {}) },
        best: parsed.best ?? {},
        games: parsed.games ?? 0,
      };
      return cache;
    }
  } catch {
    // storage unavailable (private mode…): fall back to memory
  }
  cache = d;
  return cache;
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(load()));
  } catch {
    // ignore
  }
}

export const storage = {
  get settings(): Settings {
    return load().settings;
  },
  updateSettings(patch: Partial<Settings>): void {
    Object.assign(load().settings, patch);
    save();
  },
  best(map: MapId): { score: number; week: number } | null {
    return load().best[map] ?? null;
  },
  /** returns true if it is a new record */
  submit(map: MapId, score: number, week: number): boolean {
    const s = load();
    s.games++;
    const prev = s.best[map];
    const rec = !prev || score > prev.score;
    if (rec) s.best[map] = { score, week, date: Date.now() };
    save();
    return rec && score > 0;
  },
  resetBest(): void {
    load().best = {};
    save();
  },
  get games(): number {
    return load().games;
  },
};
