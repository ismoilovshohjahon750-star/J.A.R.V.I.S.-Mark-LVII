import PptxGenPkg from 'pptxgenjs';

export type PptxThemeId = 'midnight' | 'ivory' | 'slate' | 'emerald';
export type PptxSlideLayout = 'hero' | 'bullets' | 'columns' | 'metrics' | 'timeline' | 'closing';

export interface PptxColumnItem {
  heading: string;
  points: string[];
}

export interface PptxMetricItem {
  value: string;
  label: string;
  detail?: string;
}

export interface PptxTimelineStep {
  step: string;
  title: string;
  detail: string;
}

export interface PptxSlide {
  id: string;
  layout: PptxSlideLayout;
  title: string;
  subtitle?: string;
  bullets?: string[];
  columns?: PptxColumnItem[];
  metrics?: PptxMetricItem[];
  steps?: PptxTimelineStep[];
  callout?: string;
  notes?: string;
}

export interface PptxDeck {
  id: string;
  title: string;
  subtitle: string;
  fileName: string;
  theme: PptxThemeId;
  slides: PptxSlide[];
  updatedAt: string;
  fileSizeBytes: number;
}

export interface PptxThemePalette {
  id: PptxThemeId;
  label: string;
  bg: string;
  surface: string;
  text: string;
  muted: string;
  accent: string;
  accent2: string;
  border: string;
}

export const PPTX_THEMES: Record<PptxThemeId, PptxThemePalette> = {
  midnight: {
    id: 'midnight',
    label: 'Midnight',
    bg: '0A1628',
    surface: '13233C',
    text: 'F8FAFC',
    muted: '94A3B8',
    accent: '00D4FF',
    accent2: 'FF9500',
    border: '1E3A5F',
  },
  ivory: {
    id: 'ivory',
    label: 'Ivory',
    bg: 'FAF9F6',
    surface: 'FFFFFF',
    text: '0F172A',
    muted: '475569',
    accent: '0369A1',
    accent2: 'D97706',
    border: 'CBD5E1',
  },
  slate: {
    id: 'slate',
    label: 'Slate',
    bg: '0F172A',
    surface: '1E293B',
    text: 'F1F5F9',
    muted: '94A3B8',
    accent: '38BDF8',
    accent2: 'A78BFA',
    border: '334155',
  },
  emerald: {
    id: 'emerald',
    label: 'Emerald',
    bg: '06281E',
    surface: '0B3B2D',
    text: 'ECFDF5',
    muted: 'A7F3D0',
    accent: '10B981',
    accent2: 'F59E0B',
    border: '115E46',
  },
};

let activeDeck: PptxDeck | null = null;
let activeBuffer: Buffer | null = null;

export function getPptxDeckState(): PptxDeck | null {
  return activeDeck;
}

export function getPptxBinaryBuffer(): { buffer: Buffer; fileName: string } | null {
  if (!activeDeck || !activeBuffer) return null;
  return { buffer: activeBuffer, fileName: activeDeck.fileName };
}

export function clearPptxDeck() {
  activeDeck = null;
  activeBuffer = null;
}

function normalizeLayout(raw: unknown, idx: number, total: number): PptxSlideLayout {
  const val = String(raw || '').toLowerCase().trim();
  if (val === 'hero' || val === 'bullets' || val === 'columns' || val === 'metrics' || val === 'timeline' || val === 'closing') {
    return val;
  }
  if (idx === 0) return 'hero';
  if (idx === total - 1) return 'closing';
  return 'bullets';
}

function normalizeTheme(raw: unknown): PptxThemeId {
  const val = String(raw || '').toLowerCase().trim();
  if (val === 'midnight' || val === 'ivory' || val === 'slate' || val === 'emerald') {
    return val;
  }
  return 'midnight';
}

export function parsePptxDeckJson(
  rawText: string,
  fallbackTitle = 'Presentation Deck',
  preferredTheme?: PptxThemeId
): PptxDeck {
  let cleaned = String(rawText || '').trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    cleaned = fenced[1].trim();
  } else {
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last > first) {
      cleaned = cleaned.slice(first, last + 1);
    }
  }

  const parsed = JSON.parse(cleaned) as {
    title?: string;
    subtitle?: string;
    theme?: string;
    slides?: Array<{
      layout?: string;
      title?: string;
      subtitle?: string;
      bullets?: unknown[];
      columns?: Array<{ heading?: string; points?: unknown[] }>;
      metrics?: Array<{ value?: string; label?: string; detail?: string }>;
      steps?: Array<{ step?: string; title?: string; detail?: string }>;
      callout?: string;
      notes?: string;
    }>;
  };

  if (!Array.isArray(parsed.slides) || parsed.slides.length === 0) {
    throw new Error('Generated presentation contained no slides.');
  }

  const total = parsed.slides.length;
  const slides: PptxSlide[] = parsed.slides.slice(0, 18).map((s, idx) => {
    const layout = normalizeLayout(s?.layout, idx, total);
    const bullets = Array.isArray(s?.bullets)
      ? s.bullets.map((b) => String(b || '').trim()).filter(Boolean).slice(0, 7)
      : undefined;
    const columns = Array.isArray(s?.columns)
      ? s.columns
          .slice(0, 3)
          .map((c) => ({
            heading: String(c?.heading || 'Section').trim().slice(0, 80),
            points: Array.isArray(c?.points)
              ? c.points.map((p) => String(p || '').trim()).filter(Boolean).slice(0, 5)
              : [],
          }))
          .filter((c) => c.heading || c.points.length > 0)
      : undefined;
    const metrics = Array.isArray(s?.metrics)
      ? s.metrics
          .slice(0, 4)
          .map((m) => ({
            value: String(m?.value || '—').trim().slice(0, 24),
            label: String(m?.label || 'Metric').trim().slice(0, 48),
            detail: m?.detail ? String(m.detail).trim().slice(0, 90) : undefined,
          }))
      : undefined;
    const steps = Array.isArray(s?.steps)
      ? s.steps
          .slice(0, 5)
          .map((st, sIdx) => ({
            step: String(st?.step || `0${sIdx + 1}`).trim().slice(0, 16),
            title: String(st?.title || 'Step').trim().slice(0, 48),
            detail: String(st?.detail || '').trim().slice(0, 140),
          }))
      : undefined;

    return {
      id: `slide_${idx + 1}`,
      layout,
      title: String(s?.title || `Slide ${idx + 1}`).trim().slice(0, 120),
      subtitle: s?.subtitle ? String(s.subtitle).trim().slice(0, 220) : undefined,
      bullets,
      columns,
      metrics,
      steps,
      callout: s?.callout ? String(s.callout).trim().slice(0, 220) : undefined,
      notes: s?.notes ? String(s.notes).trim().slice(0, 600) : undefined,
    };
  });

  const title = String(parsed.title || fallbackTitle).trim().slice(0, 100) || fallbackTitle;
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 42) || 'jarvis-presentation';

  return {
    id: `deck_${Date.now()}`,
    title,
    subtitle: String(parsed.subtitle || 'J.A.R.V.I.S. Mark LVII').trim().slice(0, 160),
    fileName: `${slug}.pptx`,
    theme: preferredTheme || normalizeTheme(parsed.theme),
    slides,
    updatedAt: new Date().toISOString(),
    fileSizeBytes: 0,
  };
}

export async function buildAndStorePptxDeck(deckInput: PptxDeck): Promise<PptxDeck> {
  const PptxGenJS =
    (PptxGenPkg as unknown as { default?: typeof PptxGenPkg }).default || PptxGenPkg;
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5 inches
  pptx.author = 'J.A.R.V.I.S. Mark LVII';
  pptx.title = deckInput.title;
  pptx.subject = deckInput.subtitle || deckInput.title;

  const palette = PPTX_THEMES[normalizeTheme(deckInput.theme)];
  const total = deckInput.slides.length;

  deckInput.slides.forEach((s, idx) => {
    const slide = pptx.addSlide();
    slide.background = { color: palette.bg };

    if (s.notes) {
      slide.addNotes(s.notes);
    }

    if (s.layout === 'hero') {
      // Left vertical accent stripe
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.75,
        y: 1.55,
        w: 0.1,
        h: 3.7,
        fill: { color: palette.accent },
      });
      slide.addText(deckInput.subtitle || 'PRESENTATION', {
        x: 1.15,
        y: 1.55,
        w: 11.2,
        h: 0.45,
        fontFace: 'Segoe UI',
        fontSize: 13,
        bold: true,
        color: palette.accent,
        charSpacing: 3,
      });
      slide.addText(s.title, {
        x: 1.15,
        y: 2.1,
        w: 11.2,
        h: 2.0,
        fontFace: 'Segoe UI',
        fontSize: 40,
        bold: true,
        color: palette.text,
        valign: 'top',
      });
      if (s.subtitle) {
        slide.addText(s.subtitle, {
          x: 1.15,
          y: 4.25,
          w: 10.6,
          h: 1.0,
          fontFace: 'Segoe UI',
          fontSize: 18,
          color: palette.muted,
        });
      }
      slide.addShape(pptx.ShapeType.line, {
        x: 1.15,
        y: 6.45,
        w: 11.4,
        h: 0,
        line: { color: palette.border, width: 1 },
      });
      slide.addText(`${deckInput.title} · Slide 1 / ${total}`, {
        x: 1.15,
        y: 6.62,
        w: 11.4,
        h: 0.35,
        fontFace: 'Segoe UI',
        fontSize: 11,
        color: palette.muted,
      });
      return;
    }

    if (s.layout === 'closing') {
      slide.addShape(pptx.ShapeType.rect, {
        x: 2.0,
        y: 2.0,
        w: 9.33,
        h: 3.4,
        fill: { color: palette.surface },
        line: { color: palette.border, width: 1.2 },
      });
      slide.addShape(pptx.ShapeType.rect, {
        x: 2.0,
        y: 2.0,
        w: 9.33,
        h: 0.08,
        fill: { color: palette.accent },
      });
      slide.addText(s.title, {
        x: 2.4,
        y: 2.5,
        w: 8.53,
        h: 1.1,
        fontFace: 'Segoe UI',
        fontSize: 32,
        bold: true,
        color: palette.text,
        align: 'center',
      });
      const closingBody = s.subtitle || s.callout || (s.bullets || []).join(' · ');
      if (closingBody) {
        slide.addText(closingBody, {
          x: 2.5,
          y: 3.7,
          w: 8.33,
          h: 1.2,
          fontFace: 'Segoe UI',
          fontSize: 16,
          color: palette.muted,
          align: 'center',
        });
      }
      slide.addText(`${idx + 1} / ${total}`, {
        x: 11.4,
        y: 6.85,
        w: 1.3,
        h: 0.3,
        fontFace: 'Segoe UI',
        fontSize: 10,
        color: palette.muted,
        align: 'right',
      });
      return;
    }

    // Standard content slide header
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.65,
      y: 0.52,
      w: 0.08,
      h: 0.56,
      fill: { color: palette.accent },
    });
    slide.addText(s.title, {
      x: 0.88,
      y: 0.45,
      w: 11.4,
      h: 0.65,
      fontFace: 'Segoe UI',
      fontSize: 24,
      bold: true,
      color: palette.text,
    });
    if (s.subtitle) {
      slide.addText(s.subtitle, {
        x: 0.88,
        y: 1.08,
        w: 11.4,
        h: 0.38,
        fontFace: 'Segoe UI',
        fontSize: 13,
        color: palette.muted,
      });
    }
    slide.addShape(pptx.ShapeType.line, {
      x: 0.65,
      y: 1.54,
      w: 12.03,
      h: 0,
      line: { color: palette.border, width: 1 },
    });

    if (s.layout === 'metrics' && s.metrics && s.metrics.length > 0) {
      const count = Math.min(4, s.metrics.length);
      const gap = 0.28;
      const totalW = 12.03;
      const cardW = (totalW - gap * (count - 1)) / count;
      s.metrics.slice(0, 4).forEach((m, mIdx) => {
        const x = 0.65 + mIdx * (cardW + gap);
        slide.addShape(pptx.ShapeType.rect, {
          x,
          y: 1.85,
          w: cardW,
          h: 2.35,
          fill: { color: palette.surface },
          line: { color: palette.border, width: 1 },
        });
        slide.addShape(pptx.ShapeType.rect, {
          x,
          y: 1.85,
          w: cardW,
          h: 0.06,
          fill: { color: mIdx % 2 === 0 ? palette.accent : palette.accent2 },
        });
        slide.addText(m.value, {
          x: x + 0.2,
          y: 2.1,
          w: cardW - 0.4,
          h: 0.85,
          fontFace: 'Segoe UI',
          fontSize: 30,
          bold: true,
          color: mIdx % 2 === 0 ? palette.accent : palette.accent2,
        });
        slide.addText(m.label, {
          x: x + 0.2,
          y: 2.98,
          w: cardW - 0.4,
          h: 0.45,
          fontFace: 'Segoe UI',
          fontSize: 13,
          bold: true,
          color: palette.text,
        });
        if (m.detail) {
          slide.addText(m.detail, {
            x: x + 0.2,
            y: 3.42,
            w: cardW - 0.4,
            h: 0.65,
            fontFace: 'Segoe UI',
            fontSize: 11,
            color: palette.muted,
          });
        }
      });

      if (s.bullets && s.bullets.length > 0) {
        slide.addText(
          s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
          {
            x: 0.75,
            y: 4.5,
            w: 11.8,
            h: 2.1,
            fontFace: 'Segoe UI',
            fontSize: 14,
            color: palette.text,
            paraSpaceAfter: 8,
            valign: 'top',
          }
        );
      }
    } else if (s.layout === 'columns' && s.columns && s.columns.length > 0) {
      const cols = s.columns.slice(0, 3);
      const gap = 0.3;
      const colW = (12.03 - gap * (cols.length - 1)) / cols.length;
      cols.forEach((col, cIdx) => {
        const x = 0.65 + cIdx * (colW + gap);
        slide.addShape(pptx.ShapeType.rect, {
          x,
          y: 1.85,
          w: colW,
          h: 4.75,
          fill: { color: palette.surface },
          line: { color: palette.border, width: 1 },
        });
        slide.addShape(pptx.ShapeType.rect, {
          x,
          y: 1.85,
          w: colW,
          h: 0.07,
          fill: { color: cIdx % 2 === 0 ? palette.accent : palette.accent2 },
        });
        slide.addText(col.heading, {
          x: x + 0.25,
          y: 2.08,
          w: colW - 0.5,
          h: 0.5,
          fontFace: 'Segoe UI',
          fontSize: 16,
          bold: true,
          color: palette.text,
        });
        if (col.points.length > 0) {
          slide.addText(
            col.points.map((pt) => ({ text: pt, options: { bullet: true, breakLine: true } })),
            {
              x: x + 0.25,
              y: 2.7,
              w: colW - 0.5,
              h: 3.7,
              fontFace: 'Segoe UI',
              fontSize: 13.5,
              color: palette.muted,
              paraSpaceAfter: 10,
              valign: 'top',
            }
          );
        }
      });
    } else if (s.layout === 'timeline' && s.steps && s.steps.length > 0) {
      const steps = s.steps.slice(0, 5);
      const gap = 0.22;
      const stepW = (12.03 - gap * (steps.length - 1)) / steps.length;
      steps.forEach((st, stIdx) => {
        const x = 0.65 + stIdx * (stepW + gap);
        slide.addShape(pptx.ShapeType.rect, {
          x,
          y: 2.05,
          w: stepW,
          h: 4.35,
          fill: { color: palette.surface },
          line: { color: palette.border, width: 1 },
        });
        slide.addText(st.step, {
          x: x + 0.18,
          y: 2.22,
          w: stepW - 0.36,
          h: 0.45,
          fontFace: 'Segoe UI',
          fontSize: 18,
          bold: true,
          color: palette.accent,
        });
        slide.addText(st.title, {
          x: x + 0.18,
          y: 2.75,
          w: stepW - 0.36,
          h: 0.65,
          fontFace: 'Segoe UI',
          fontSize: 14,
          bold: true,
          color: palette.text,
          valign: 'top',
        });
        slide.addText(st.detail, {
          x: x + 0.18,
          y: 3.45,
          w: stepW - 0.36,
          h: 2.75,
          fontFace: 'Segoe UI',
          fontSize: 12,
          color: palette.muted,
          valign: 'top',
        });
      });
    } else {
      const hasCallout = Boolean(s.callout && s.callout.trim());
      const bulletW = hasCallout ? 7.7 : 12.0;
      const bullets =
        s.bullets && s.bullets.length > 0
          ? s.bullets
          : s.columns?.[0]?.points || [s.subtitle || 'Key discussion point'];
      slide.addText(
        bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        {
          x: 0.75,
          y: 1.9,
          w: bulletW,
          h: 4.7,
          fontFace: 'Segoe UI',
          fontSize: 16,
          color: palette.text,
          paraSpaceAfter: 14,
          valign: 'top',
        }
      );

      if (hasCallout && s.callout) {
        slide.addShape(pptx.ShapeType.rect, {
          x: 8.8,
          y: 1.9,
          w: 3.88,
          h: 4.5,
          fill: { color: palette.surface },
          line: { color: palette.border, width: 1 },
        });
        slide.addShape(pptx.ShapeType.rect, {
          x: 8.8,
          y: 1.9,
          w: 3.88,
          h: 0.07,
          fill: { color: palette.accent2 },
        });
        slide.addText('KEY TAKEAWAY', {
          x: 9.05,
          y: 2.18,
          w: 3.38,
          h: 0.35,
          fontFace: 'Segoe UI',
          fontSize: 11,
          bold: true,
          color: palette.accent2,
          charSpacing: 1.8,
        });
        slide.addText(s.callout, {
          x: 9.05,
          y: 2.65,
          w: 3.38,
          h: 3.45,
          fontFace: 'Segoe UI',
          fontSize: 15,
          color: palette.text,
          valign: 'top',
        });
      }
    }

    // Footer on content slides
    slide.addText(deckInput.title, {
      x: 0.65,
      y: 6.88,
      w: 8.5,
      h: 0.3,
      fontFace: 'Segoe UI',
      fontSize: 10,
      color: palette.muted,
    });
    slide.addText(`${idx + 1} / ${total}`, {
      x: 11.4,
      y: 6.88,
      w: 1.28,
      h: 0.3,
      fontFace: 'Segoe UI',
      fontSize: 10,
      color: palette.muted,
      align: 'right',
    });
  });

  const out = await pptx.write({ outputType: 'nodebuffer' });
  const buf = Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);

  const storedDeck: PptxDeck = {
    ...deckInput,
    updatedAt: new Date().toISOString(),
    fileSizeBytes: buf.length,
  };
  activeDeck = storedDeck;
  activeBuffer = buf;
  return storedDeck;
}
