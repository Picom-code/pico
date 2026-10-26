import type { Effort, HelperEffort } from './api';

export const ACCENTS: { id: string; name: string; hex: string }[] = [
  { id: 'hotpink', name: 'Hot pink', hex: '#FF2E99' },
  { id: 'mint', name: 'Mint', hex: '#33FF99' },
  { id: 'cyan', name: 'Cyan', hex: '#00D1FF' },
  { id: 'lavender', name: 'Lavender', hex: '#9E66FF' },
  { id: 'amber', name: 'Amber', hex: '#FFA800' },
  { id: 'white', name: 'White', hex: '#F2F2F2' },
];
const LEGACY: Record<string, string> = { pink: 'hotpink', violet: 'lavender', orange: 'amber' };

export const EFFORTS: Effort[] = ['low', 'medium', 'high'];
export const HELPER_EFFORTS: HelperEffort[] = ['off', 'low', 'medium', 'high'];
/** medium follows the accent; the rest are fixed signal colors. */
export const EFFORT_COLORS: Record<string, string> = {
  off: '#6b6b70',
  low: '#00d1ff',
  medium: 'var(--accent)',
  high: '#ffa800',
  max: '#ff4d5e',
};
export const EFFORT_SHORT: Record<string, string> = { off: 'off', low: 'low', medium: 'med', high: 'high', max: 'max' };
export const EFFORT_HINT: Record<string, string> = {
  off: 'Answers right away',
  low: 'Thinks a little',
  medium: 'Thinks it through',
  high: 'Thinks hard — slower, best for tricky stuff',
  max: 'Everything it has — slowest',
};

const hexToRgb = (hex: string) => {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
};

/** Known accent id for an id / legacy id / hex, else null. */
export function accentId(v: string | null | undefined): string | null {
  if (!v) return null;
  const id = LEGACY[v] || v;
  const a = ACCENTS.find((x) => x.id === id || x.hex.toLowerCase() === v.toLowerCase());
  return a ? a.id : null;
}
export function accentHex(id: string | null | undefined): string {
  return ACCENTS.find((a) => a.id === accentId(id))?.hex ?? ACCENTS[0].hex;
}

export function applyAccent(id: string) {
  const known = accentId(id) || 'hotpink';
  const hex = accentHex(known);
  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  root.setProperty('--accent-rgb', hexToRgb(hex));
  root.setProperty('--on-accent', known === 'hotpink' || known === 'lavender' ? '#fff' : '#0b0b0c');
  localStorage.setItem('pico.accent', known);
}

export function applyMotion(on: boolean) {
  document.documentElement.classList.toggle('no-motion', !on);
  localStorage.setItem('pico.motion', on ? 'on' : 'off');
}
export const motionOn = () => localStorage.getItem('pico.motion') !== 'off';

/** UI-only display prefs (kept in localStorage; the engine has no fields for them). */
export type ReasoningShown = 'hidden' | 'timer' | 'preview' | 'full';
export type ToolDetail = 'quiet' | 'normal' | 'full';
export const getPref = <T extends string>(k: string, d: T): T => (localStorage.getItem(`pico.${k}`) as T) || d;
export const setPref = (k: string, v: string) => { localStorage.setItem(`pico.${k}`, v); dispatchEvent(new Event('pico-prefs')); };

export function initTheme() {
  applyAccent(localStorage.getItem('pico.accent') || 'hotpink');
  applyMotion(motionOn());
}

export const currentAccent = () => accentId(localStorage.getItem('pico.accent')) || 'hotpink';
