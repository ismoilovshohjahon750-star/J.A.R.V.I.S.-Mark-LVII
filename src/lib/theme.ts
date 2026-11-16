export interface HudPalette {
  BG: string;
  PANEL: string;
  PANEL2: string;
  BORDER: string;
  BORDER_B: string;
  BORDER_A: string;
  PRI: string;
  PRI_DIM: string;
  PRI_GHO: string;
  TEXT: string;
  TEXT_DIM: string;
  TEXT_MED: string;
  WHITE: string;
  BAR_BG: string;
  ACC: string;
  ACC2: string;
  GREEN: string;
  GREEN_D: string;
  RED: string;
  MUTED_C: string;
}

export const PALETTE_DEFAULTS: HudPalette = {
  BG: '#00060a',
  PANEL: '#010d14',
  PANEL2: '#010f18',
  BORDER: '#0d3347',
  BORDER_B: '#1a5c7a',
  BORDER_A: '#0f4060',
  PRI: '#00d4ff',
  PRI_DIM: '#007a99',
  PRI_GHO: '#001f2e',
  TEXT: '#8ffcff',
  TEXT_DIM: '#3a8a9a',
  TEXT_MED: '#5ab8cc',
  WHITE: '#d8f8ff',
  BAR_BG: '#011520',
  ACC: '#ff6b00',
  ACC2: '#ffcc00',
  GREEN: '#00ff88',
  GREEN_D: '#00aa55',
  RED: '#ff3355',
  MUTED_C: '#ff3366',
};

const HUE_LINKED: (keyof HudPalette)[] = [
  'BG',
  'PANEL',
  'PANEL2',
  'BORDER',
  'BORDER_B',
  'BORDER_A',
  'PRI',
  'PRI_DIM',
  'PRI_GHO',
  'TEXT',
  'TEXT_DIM',
  'TEXT_MED',
  'WHITE',
  'BAR_BG',
];

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  return [
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255,
  ];
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (max !== min) {
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return [h, s, v];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0,
    g = 0,
    b = 0;
  switch (i % 6) {
    case 0:
      r = v;
      g = t;
      b = p;
      break;
    case 1:
      r = q;
      g = v;
      b = p;
      break;
    case 2:
      r = p;
      g = v;
      b = t;
      break;
    case 3:
      r = p;
      g = q;
      b = v;
      break;
    case 4:
      r = t;
      g = p;
      b = v;
      break;
    case 5:
      r = v;
      g = p;
      b = q;
      break;
  }
  return [r, g, b];
}

function toHex(r: number, g: number, b: number): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n * 255)))
      .toString(16)
      .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function derivePalette(accentHex: string): HudPalette {
  const normalized = (accentHex || '').trim().toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(normalized)) {
    return { ...PALETTE_DEFAULTS };
  }

  const baseH = rgbToHsv(...hexToRgb(PALETTE_DEFAULTS.PRI))[0];
  const [accH, accS] = rgbToHsv(...hexToRgb(normalized));
  const dh = accH - baseH;
  const grey = accS < 0.08;

  const next: HudPalette = { ...PALETTE_DEFAULTS };
  for (const key of HUE_LINKED) {
    const [h, s0, v] = rgbToHsv(...hexToRgb(PALETTE_DEFAULTS[key]));
    const s = grey ? s0 * 0.15 : s0;
    const shiftedH = ((h + dh) % 1 + 1) % 1;
    const [r, g, b] = hsvToRgb(shiftedH, s, v);
    next[key] = toHex(r, g, b);
  }
  return next;
}

export function applyPaletteToDocument(palette: HudPalette): void {
  const root = document.documentElement;
  root.style.setProperty('--hud-bg', palette.BG);
  root.style.setProperty('--hud-panel', palette.PANEL);
  root.style.setProperty('--hud-panel2', palette.PANEL2);
  root.style.setProperty('--hud-border', palette.BORDER);
  root.style.setProperty('--hud-border-a', palette.BORDER_A);
  root.style.setProperty('--hud-border-b', palette.BORDER_B);
  root.style.setProperty('--hud-pri', palette.PRI);
  root.style.setProperty('--hud-pri-dim', palette.PRI_DIM);
  root.style.setProperty('--hud-pri-gho', palette.PRI_GHO);
  root.style.setProperty('--hud-text', palette.TEXT);
  root.style.setProperty('--hud-text-dim', palette.TEXT_DIM);
  root.style.setProperty('--hud-text-med', palette.TEXT_MED);
  root.style.setProperty('--hud-white', palette.WHITE);
  root.style.setProperty('--hud-bar-bg', palette.BAR_BG);
}

export const ACCENT_PRESETS = [
  { label: 'JARVIS CYAN', hex: '#00d4ff' },
  { label: 'ARC INDIGO', hex: '#6366f1' },
  { label: 'EMERALD HUD', hex: '#00ff88' },
  { label: 'SOLAR AMBER', hex: '#ff6b00' },
  { label: 'CRIMSON CORE', hex: '#ff3355' },
  { label: 'TITANIUM', hex: '#cbd5e1' },
];
