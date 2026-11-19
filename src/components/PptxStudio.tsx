import React, { useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Edit3,
  FileSpreadsheet,
  Presentation,
  X,
} from 'lucide-react';

export type PptxThemeId = 'midnight' | 'ivory' | 'slate' | 'emerald';
export type PptxSlideLayout = 'hero' | 'bullets' | 'columns' | 'metrics' | 'timeline' | 'closing';

export interface PptxSlideItem {
  id: string;
  layout: PptxSlideLayout;
  title: string;
  subtitle?: string;
  bullets?: string[];
  columns?: Array<{ heading: string; points: string[] }>;
  metrics?: Array<{ value: string; label: string; detail?: string }>;
  steps?: Array<{ step: string; title: string; detail: string }>;
  callout?: string;
  notes?: string;
}

export interface PptxDeckState {
  id: string;
  title: string;
  subtitle: string;
  fileName: string;
  theme: PptxThemeId;
  slides: PptxSlideItem[];
  updatedAt: string;
  fileSizeBytes: number;
}

interface ThemeVisual {
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

const THEMES: Record<PptxThemeId, ThemeVisual> = {
  midnight: {
    id: 'midnight',
    label: 'Midnight',
    bg: '#0A1628',
    surface: '#13233C',
    text: '#F8FAFC',
    muted: '#94A3B8',
    accent: '#00D4FF',
    accent2: '#FF9500',
    border: '#1E3A5F',
  },
  ivory: {
    id: 'ivory',
    label: 'Ivory',
    bg: '#FAF9F6',
    surface: '#FFFFFF',
    text: '#0F172A',
    muted: '#475569',
    accent: '#0369A1',
    accent2: '#D97706',
    border: '#CBD5E1',
  },
  slate: {
    id: 'slate',
    label: 'Slate',
    bg: '#0F172A',
    surface: '#1E293B',
    text: '#F1F5F9',
    muted: '#94A3B8',
    accent: '#38BDF8',
    accent2: '#A78BFA',
    border: '#334155',
  },
  emerald: {
    id: 'emerald',
    label: 'Emerald',
    bg: '#06281E',
    surface: '#0B3B2D',
    text: '#ECFDF5',
    muted: '#A7F3D0',
    accent: '#10B981',
    accent2: '#F59E0B',
    border: '#115E46',
  },
};

const STARTER_DECKS = [
  {
    label: 'Suniy Intellekt Taqdimoti',
    prompt: "Sun'iy intellekt va zamonaviy dasturlash texnologiyalari haqida 7 slaydli taqdimot (.pptx) tayyorla.",
  },
  {
    label: 'Maktab Loyihasi (.pptx)',
    prompt: 'Zamonaviy maktab raqamli ekotizimi va oquvchilar portali boyicha 7 slaydli prezentatsiya yarat.',
  },
  {
    label: 'Startup Pitch Deck',
    prompt: 'Create an 8-slide investor startup pitch deck covering problem, solution, market size, traction metrics, roadmap, and ask.',
  },
];

interface PptxStudioProps {
  deck: PptxDeckState | null;
  generating: boolean;
  rendering: boolean;
  error: string | null;
  onGenerate: (prompt: string) => void;
  onUpdateDeck: (nextDeck: PptxDeckState) => void;
  onCloseToHud: () => void;
}

export const PptxStudio: React.FC<PptxStudioProps> = ({
  deck,
  generating,
  rendering,
  error,
  onGenerate,
  onUpdateDeck,
  onCloseToHud,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const [promptDraft, setPromptDraft] = useState('');

  useEffect(() => {
    if (!deck) {
      setSelectedIndex(0);
      return;
    }
    if (selectedIndex >= deck.slides.length) {
      setSelectedIndex(Math.max(0, deck.slides.length - 1));
    }
  }, [deck, selectedIndex]);

  const activeSlide = useMemo(() => {
    if (!deck || deck.slides.length === 0) return null;
    return deck.slides[selectedIndex] || deck.slides[0];
  }, [deck, selectedIndex]);

  const visualTheme = THEMES[deck?.theme || 'midnight'] || THEMES.midnight;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = promptDraft.trim();
    if (!text || generating) return;
    setPromptDraft('');
    onGenerate(text);
  };

  const updateSlideField = (patch: Partial<PptxSlideItem>) => {
    if (!deck || !activeSlide) return;
    const nextSlides = deck.slides.map((s, idx) =>
      idx === selectedIndex ? { ...s, ...patch } : s
    );
    onUpdateDeck({ ...deck, slides: nextSlides });
  };

  const sizeKb = deck?.fileSizeBytes ? Math.max(1, Math.round(deck.fileSizeBytes / 1024)) : 0;

  return (
    <div
      className="w-full h-full flex flex-col min-h-0"
      style={{ backgroundColor: 'var(--hud-bg)', color: 'var(--hud-text)' }}
    >
      {/* Header Bar */}
      <div
        className="px-3 py-2 border-b flex items-center justify-between gap-2 flex-wrap shrink-0"
        style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)' }}
      >
        <div className="min-w-0 flex items-center gap-2.5">
          <Presentation className="w-4 h-4 shrink-0" style={{ color: 'var(--hud-pri)' }} />
          <div className="min-w-0">
            <div className="text-xs font-semibold truncate" style={{ color: 'var(--hud-white)' }}>
              {deck?.title || 'PowerPoint (.pptx) Studio'}
            </div>
            <div className="text-[10px] font-mono tabular-nums truncate" style={{ color: 'var(--hud-text-dim)' }}>
              {generating
                ? 'Generating slide deck...'
                : rendering
                ? 'Rebuilding .pptx file...'
                : deck
                ? `${deck.slides.length} slides · ${visualTheme.label} · ${sizeKb} KB`
                : 'Ready to build .pptx'}
            </div>
          </div>
        </div>

        {/* Theme Controls */}
        {deck && (
          <div
            className="flex items-center gap-1 p-0.5 border shrink-0"
            style={{ backgroundColor: 'var(--hud-panel2)', borderColor: 'var(--hud-border)' }}
          >
            {(['midnight', 'ivory', 'slate', 'emerald'] as const).map((t) => (
              <button
                key={t}
                type="button"
                disabled={rendering}
                onClick={() => onUpdateDeck({ ...deck, theme: t })}
                className="px-2 py-1 text-[10px] font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors disabled:opacity-50"
                style={{
                  backgroundColor: deck.theme === t ? 'var(--hud-pri-gho)' : 'transparent',
                  color: deck.theme === t ? 'var(--hud-white)' : 'var(--hud-text-dim)',
                }}
              >
                {THEMES[t].label}
              </button>
            ))}
          </div>
        )}

        {/* Right Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {deck && (
            <>
              <button
                type="button"
                onClick={() => setEditing((v) => !v)}
                className="px-2.5 py-1 text-[10px] font-semibold border flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                style={{
                  backgroundColor: editing ? 'var(--hud-pri-gho)' : 'var(--hud-panel2)',
                  borderColor: editing ? 'var(--hud-pri)' : 'var(--hud-border)',
                  color: editing ? 'var(--hud-white)' : 'var(--hud-text-med)',
                }}
              >
                <Edit3 className="w-3 h-3" /> {editing ? 'Preview' : 'Edit'}
              </button>
              <a
                href="/api/pptx/download"
                download={deck.fileName}
                className="px-2.5 py-1 text-[10px] font-semibold border flex items-center gap-1 whitespace-nowrap shrink-0"
                style={{
                  backgroundColor: 'var(--hud-pri-gho)',
                  borderColor: 'var(--hud-pri)',
                  color: 'var(--hud-white)',
                }}
              >
                <Download className="w-3 h-3" /> Download .PPTX
              </a>
            </>
          )}
          <button
            type="button"
            onClick={onCloseToHud}
            className="px-2.5 py-1 text-[10px] font-semibold border flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
            style={{
              backgroundColor: 'var(--hud-panel2)',
              borderColor: 'var(--hud-border)',
              color: 'var(--hud-text-med)',
            }}
            title="Return to 3D HUD"
          >
            <X className="w-3 h-3" /> 3D HUD
          </button>
        </div>
      </div>

      {/* Prompt Bar */}
      <form
        onSubmit={handleSubmit}
        className="px-3 py-2 border-b flex items-center gap-2 shrink-0"
        style={{ backgroundColor: 'var(--hud-panel2)', borderColor: 'var(--hud-border)' }}
      >
        <input
          value={promptDraft}
          onChange={(e) => setPromptDraft(e.target.value)}
          disabled={generating}
          placeholder={
            deck
              ? 'Update presentation (e.g. Add a budget slide, make 8 slides, translate to English)...'
              : 'Describe the presentation topic, language, and slide count...'
          }
          className="flex-1 min-w-0 px-2.5 py-1.5 text-xs border outline-none"
          style={{
            backgroundColor: 'var(--hud-bg)',
            borderColor: 'var(--hud-border-a)',
            color: 'var(--hud-white)',
          }}
        />
        <button
          type="submit"
          disabled={generating || !promptDraft.trim()}
          className="px-3 py-1.5 text-[11px] font-semibold border whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-40"
          style={{
            backgroundColor: 'var(--hud-pri-gho)',
            borderColor: 'var(--hud-pri)',
            color: 'var(--hud-white)',
          }}
        >
          {generating ? 'Generating...' : deck ? 'Update .PPTX' : 'Create .PPTX'}
        </button>
      </form>

      {error && (
        <div
          className="px-3 py-2 border-b text-xs shrink-0"
          style={{
            backgroundColor: 'rgba(255, 68, 85, 0.12)',
            borderColor: 'var(--hud-red)',
            color: 'var(--hud-red)',
          }}
        >
          {error}
        </div>
      )}

      {/* Body */}
      {generating && !deck ? (
        <div className="flex-1 min-h-0 p-6 flex flex-col items-center justify-center gap-4">
          <div className="w-full max-w-md space-y-3">
            <div className="text-xs font-mono text-center" style={{ color: 'var(--hud-pri)' }}>
              Designing slide structure and compiling .pptx file...
            </div>
            <div className="aspect-video w-full animate-pulse border" style={{ backgroundColor: 'var(--hud-panel2)', borderColor: 'var(--hud-border)' }} />
          </div>
        </div>
      ) : !deck ? (
        <div className="flex-1 min-h-0 p-6 flex flex-col items-center justify-center text-center gap-4 overflow-y-auto hud-scroll">
          <FileSpreadsheet className="w-8 h-8" style={{ color: 'var(--hud-pri)' }} />
          <div className="max-w-md space-y-2">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--hud-white)' }}>
              PowerPoint (.pptx) Presentation Studio
            </h3>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--hud-text-dim)' }}>
              Describe any presentation above or in chat. J.A.R.V.I.S. builds a multi-layout slide deck with live visual preview, theme switching, inline editing, and instant .pptx download.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2 max-w-xl">
            {STARTER_DECKS.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => onGenerate(item.prompt)}
                className="px-3 py-1.5 text-[11px] font-medium border whitespace-nowrap shrink-0 cursor-pointer"
                style={{
                  backgroundColor: 'var(--hud-panel2)',
                  borderColor: 'var(--hud-border-b)',
                  color: 'var(--hud-text)',
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[175px_1fr]">
          {/* Slide Thumbnail Rail */}
          <div
            className="border-b md:border-b-0 md:border-r p-2 flex md:flex-col gap-1.5 overflow-x-auto md:overflow-y-auto hud-scroll shrink-0"
            style={{ backgroundColor: 'var(--hud-panel2)', borderColor: 'var(--hud-border)' }}
          >
            {deck.slides.map((sl, idx) => {
              const active = idx === selectedIndex;
              return (
                <button
                  key={sl.id}
                  type="button"
                  onClick={() => setSelectedIndex(idx)}
                  className="text-left p-2 border cursor-pointer shrink-0 w-36 md:w-full transition-colors"
                  style={{
                    backgroundColor: active ? 'var(--hud-pri-gho)' : 'var(--hud-panel)',
                    borderColor: active ? 'var(--hud-pri)' : 'var(--hud-border)',
                  }}
                >
                  <div className="flex items-center justify-between text-[9px] font-mono tabular-nums mb-1" style={{ color: active ? 'var(--hud-pri)' : 'var(--hud-text-dim)' }}>
                    <span>{String(idx + 1).padStart(2, '0')}</span>
                    <span className="uppercase">{sl.layout}</span>
                  </div>
                  <div className="text-[11px] font-medium truncate" style={{ color: 'var(--hud-white)' }}>
                    {sl.title}
                  </div>
                </button>
              );
            })}
          </div>

          {/* Slide Canvas / Inline Editor */}
          <div className="min-h-0 flex flex-col overflow-hidden">
            {editing && activeSlide ? (
              <div className="flex-1 overflow-y-auto hud-scroll p-4 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[10px] font-mono uppercase mb-1" style={{ color: 'var(--hud-text-dim)' }}>
                      Slide Title
                    </label>
                    <input
                      value={activeSlide.title}
                      onChange={(e) => updateSlideField({ title: e.target.value })}
                      className="w-full px-2.5 py-1.5 text-xs border outline-none"
                      style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)', color: 'var(--hud-white)' }}
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-mono uppercase mb-1" style={{ color: 'var(--hud-text-dim)' }}>
                      Subtitle
                    </label>
                    <input
                      value={activeSlide.subtitle || ''}
                      onChange={(e) => updateSlideField({ subtitle: e.target.value })}
                      className="w-full px-2.5 py-1.5 text-xs border outline-none"
                      style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)', color: 'var(--hud-white)' }}
                    />
                  </div>
                </div>
                {activeSlide.bullets && (
                  <div>
                    <label className="block text-[10px] font-mono uppercase mb-1" style={{ color: 'var(--hud-text-dim)' }}>
                      Bullets (one per line)
                    </label>
                    <textarea
                      rows={5}
                      value={activeSlide.bullets.join('\n')}
                      onChange={(e) =>
                        updateSlideField({
                          bullets: e.target.value
                            .split('\n')
                            .map((line) => line.trim())
                            .filter(Boolean),
                        })
                      }
                      className="w-full p-2.5 text-xs border outline-none resize-none"
                      style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)', color: 'var(--hud-white)' }}
                    />
                  </div>
                )}
                <div>
                  <label className="block text-[10px] font-mono uppercase mb-1" style={{ color: 'var(--hud-text-dim)' }}>
                    Speaker Notes
                  </label>
                  <textarea
                    rows={3}
                    value={activeSlide.notes || ''}
                    onChange={(e) => updateSlideField({ notes: e.target.value })}
                    className="w-full p-2.5 text-xs border outline-none resize-none"
                    style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)', color: 'var(--hud-white)' }}
                  />
                </div>
              </div>
            ) : (
              activeSlide && (
                <div className="flex-1 min-h-0 p-4 flex flex-col items-center justify-center overflow-y-auto hud-scroll">
                  {/* Proportional 16:9 Slide Render */}
                  <div
                    className="w-full max-w-3xl aspect-video border p-6 flex flex-col justify-between overflow-hidden shadow-xl"
                    style={{
                      backgroundColor: visualTheme.bg,
                      borderColor: visualTheme.border,
                      color: visualTheme.text,
                    }}
                  >
                    {activeSlide.layout === 'hero' ? (
                      <>
                        <div />
                        <div className="pl-5 border-l-4 space-y-2.5" style={{ borderColor: visualTheme.accent }}>
                          <div className="text-[11px] font-semibold tracking-[2px] uppercase" style={{ color: visualTheme.accent }}>
                            {deck.subtitle || 'PRESENTATION'}
                          </div>
                          <h2 className="text-2xl md:text-3xl font-bold leading-tight text-balance">
                            {activeSlide.title}
                          </h2>
                          {activeSlide.subtitle && (
                            <p className="text-xs md:text-sm leading-relaxed" style={{ color: visualTheme.muted }}>
                              {activeSlide.subtitle}
                            </p>
                          )}
                        </div>
                        <div className="pt-3 border-t flex justify-between text-[10px] font-mono tabular-nums" style={{ borderColor: visualTheme.border, color: visualTheme.muted }}>
                          <span>{deck.title}</span>
                          <span>1 / {deck.slides.length}</span>
                        </div>
                      </>
                    ) : activeSlide.layout === 'closing' ? (
                      <>
                        <div />
                        <div
                          className="mx-auto w-full max-w-lg p-6 border text-center space-y-2.5"
                          style={{
                            backgroundColor: visualTheme.surface,
                            borderTopWidth: '3px',
                            borderTopColor: visualTheme.accent,
                            borderRightColor: visualTheme.border,
                            borderBottomColor: visualTheme.border,
                            borderLeftColor: visualTheme.border,
                          }}
                        >
                          <h2 className="text-xl md:text-2xl font-bold">{activeSlide.title}</h2>
                          {(activeSlide.subtitle || activeSlide.callout) && (
                            <p className="text-xs md:text-sm" style={{ color: visualTheme.muted }}>
                              {activeSlide.subtitle || activeSlide.callout}
                            </p>
                          )}
                        </div>
                        <div className="text-right text-[10px] font-mono tabular-nums" style={{ color: visualTheme.muted }}>
                          {selectedIndex + 1} / {deck.slides.length}
                        </div>
                      </>
                    ) : (
                      <>
                        {/* Slide Header */}
                        <div className="pb-2.5 border-b flex items-start justify-between gap-3" style={{ borderColor: visualTheme.border }}>
                          <div className="min-w-0">
                            <h3 className="text-base md:text-lg font-bold truncate">{activeSlide.title}</h3>
                            {activeSlide.subtitle && (
                              <p className="text-[11px] truncate mt-0.5" style={{ color: visualTheme.muted }}>
                                {activeSlide.subtitle}
                              </p>
                            )}
                          </div>
                        </div>

                        {/* Slide Body by Layout */}
                        <div className="flex-1 min-h-0 py-3 flex flex-col justify-center overflow-hidden">
                          {activeSlide.layout === 'metrics' && activeSlide.metrics?.length ? (
                            <div className="space-y-3">
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                                {activeSlide.metrics.slice(0, 4).map((m, mIdx) => (
                                  <div
                                    key={mIdx}
                                    className="p-2.5 border"
                                    style={{
                                      backgroundColor: visualTheme.surface,
                                      borderTopWidth: '2px',
                                      borderTopColor: mIdx % 2 === 0 ? visualTheme.accent : visualTheme.accent2,
                                      borderRightColor: visualTheme.border,
                                      borderBottomColor: visualTheme.border,
                                      borderLeftColor: visualTheme.border,
                                    }}
                                  >
                                    <div
                                      className="text-lg md:text-xl font-bold tabular-nums"
                                      style={{ color: mIdx % 2 === 0 ? visualTheme.accent : visualTheme.accent2 }}
                                    >
                                      {m.value}
                                    </div>
                                    <div className="text-[11px] font-semibold mt-0.5 truncate">{m.label}</div>
                                    {m.detail && (
                                      <div className="text-[10px] mt-0.5 line-clamp-2" style={{ color: visualTheme.muted }}>
                                        {m.detail}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                              {activeSlide.bullets && activeSlide.bullets.length > 0 && (
                                <ul className="space-y-1 text-xs pl-4 list-disc">
                                  {activeSlide.bullets.slice(0, 3).map((b, bIdx) => (
                                    <li key={bIdx}>{b}</li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          ) : activeSlide.layout === 'columns' && activeSlide.columns?.length ? (
                            <div
                              className="grid gap-3 h-full"
                              style={{
                                gridTemplateColumns: `repeat(${Math.min(3, activeSlide.columns.length)}, minmax(0, 1fr))`,
                              }}
                            >
                              {activeSlide.columns.slice(0, 3).map((col, cIdx) => (
                                <div
                                  key={cIdx}
                                  className="p-3 border flex flex-col"
                                  style={{
                                    backgroundColor: visualTheme.surface,
                                    borderTopWidth: '2px',
                                    borderTopColor: cIdx % 2 === 0 ? visualTheme.accent : visualTheme.accent2,
                                    borderRightColor: visualTheme.border,
                                    borderBottomColor: visualTheme.border,
                                    borderLeftColor: visualTheme.border,
                                  }}
                                >
                                  <div className="text-xs font-bold mb-2 truncate">{col.heading}</div>
                                  <ul className="space-y-1.5 text-[11px] pl-3.5 list-disc" style={{ color: visualTheme.muted }}>
                                    {col.points.slice(0, 4).map((pt, pIdx) => (
                                      <li key={pIdx}>{pt}</li>
                                    ))}
                                  </ul>
                                </div>
                              ))}
                            </div>
                          ) : activeSlide.layout === 'timeline' && activeSlide.steps?.length ? (
                            <div
                              className="grid gap-2"
                              style={{
                                gridTemplateColumns: `repeat(${Math.min(5, activeSlide.steps.length)}, minmax(0, 1fr))`,
                              }}
                            >
                              {activeSlide.steps.slice(0, 5).map((st, sIdx) => (
                                <div
                                  key={sIdx}
                                  className="p-2.5 border space-y-1"
                                  style={{
                                    backgroundColor: visualTheme.surface,
                                    borderColor: visualTheme.border,
                                  }}
                                >
                                  <div className="text-xs font-bold font-mono tabular-nums" style={{ color: visualTheme.accent }}>
                                    {st.step}
                                  </div>
                                  <div className="text-[11px] font-semibold leading-snug">{st.title}</div>
                                  <div className="text-[10px] leading-snug" style={{ color: visualTheme.muted }}>
                                    {st.detail}
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className={`grid gap-4 items-center ${activeSlide.callout ? 'grid-cols-[1.6fr_1fr]' : 'grid-cols-1'}`}>
                              <ul className="space-y-2 text-xs md:text-sm pl-4 list-disc">
                                {(activeSlide.bullets || []).slice(0, 6).map((b, bIdx) => (
                                  <li key={bIdx}>{b}</li>
                                ))}
                              </ul>
                              {activeSlide.callout && (
                                <div
                                  className="p-3.5 border space-y-1.5"
                                  style={{
                                    backgroundColor: visualTheme.surface,
                                    borderTopWidth: '2px',
                                    borderTopColor: visualTheme.accent2,
                                    borderRightColor: visualTheme.border,
                                    borderBottomColor: visualTheme.border,
                                    borderLeftColor: visualTheme.border,
                                  }}
                                >
                                  <div className="text-[9px] font-bold tracking-wider uppercase" style={{ color: visualTheme.accent2 }}>
                                    Key Takeaway
                                  </div>
                                  <div className="text-xs leading-relaxed">{activeSlide.callout}</div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Slide Footer */}
                        <div className="pt-2 border-t flex justify-between text-[10px] font-mono tabular-nums" style={{ borderColor: visualTheme.border, color: visualTheme.muted }}>
                          <span className="truncate">{deck.title}</span>
                          <span>{selectedIndex + 1} / {deck.slides.length}</span>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )
            )}

            {/* Bottom Navigation & Speaker Notes Bar */}
            <div
              className="px-3 py-2 border-t flex items-center justify-between gap-3 shrink-0"
              style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)' }}
            >
              <div className="text-[11px] truncate flex-1 min-w-0" style={{ color: 'var(--hud-text-dim)' }}>
                {activeSlide?.notes ? `Notes: ${activeSlide.notes}` : 'Use arrows or thumbnail rail to inspect slides.'}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setSelectedIndex((i) => Math.max(0, i - 1))}
                  disabled={selectedIndex <= 0}
                  className="p-1.5 border cursor-pointer disabled:opacity-40"
                  style={{ backgroundColor: 'var(--hud-panel2)', borderColor: 'var(--hud-border)', color: 'var(--hud-text)' }}
                  aria-label="Previous slide"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="text-[11px] font-mono tabular-nums px-1.5" style={{ color: 'var(--hud-text-med)' }}>
                  {selectedIndex + 1} / {deck.slides.length}
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedIndex((i) => Math.min(deck.slides.length - 1, i + 1))}
                  disabled={selectedIndex >= deck.slides.length - 1}
                  className="p-1.5 border cursor-pointer disabled:opacity-40"
                  style={{ backgroundColor: 'var(--hud-panel2)', borderColor: 'var(--hud-border)', color: 'var(--hud-text)' }}
                  aria-label="Next slide"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
