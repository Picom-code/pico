import { C, type Color, fg } from './ansi';

/**
 * Effort levels the CLI offers: low → med → high (→ max only when the engine advertises it in
 * config.efforts). 'off' is gone from the CLI; a saved/engine 'off' maps to 'low' (see normalizeEffort).
 */
export type Effort = 'low' | 'medium' | 'high' | 'max';
export const ALL_EFFORTS: Effort[] = ['low', 'medium', 'high', 'max'];
export const EFFORTS: Effort[] = ['low', 'medium', 'high'];

/** low=cyan, medium=accent (live), high=amber, max=red. */
export const EFFORT_COLOR: Record<Effort, Color> = {
  low: 80,
  get medium() {
    return C.accent;
  },
  high: 214,
  max: 203,
};

/** Short label for the rule / status line: off · low · med · high · max */
export const effortLabel = (e: Effort) => (e === 'medium' ? 'med' : e);

export function nextEffort(e: Effort, dir = 1, list: Effort[] = EFFORTS): Effort {
  const i = list.indexOf(e);
  const n = list.length;
  return list[(((i < 0 ? 0 : i) + dir) % n + n) % n];
}

export function effortPaint(e: Effort) {
  return fg(EFFORT_COLOR[e]);
}

export function isEffort(s: unknown): s is Effort {
  return typeof s === 'string' && (ALL_EFFORTS as string[]).includes(s);
}

/** Accepts 'med', 'medium', 'off' (-> low), any case; null when unknown. */
export function normalizeEffort(s: unknown): Effort | null {
  if (typeof s !== 'string') return null;
  const v = s.trim().toLowerCase();
  if (v === 'off' || v === 'none' || v === 'minimal') return 'low';
  if (v === 'med') return 'medium';
  return isEffort(v) ? v : null;
}

/** The engine's advertised list without 'off' (keeps 'max' if present); defaults when unusable. */
export function effortList(adv: unknown): Effort[] {
  if (!Array.isArray(adv)) return EFFORTS;
  const l = ALL_EFFORTS.filter((e) => adv.includes(e));
  return l.length > 1 ? l : EFFORTS;
}
