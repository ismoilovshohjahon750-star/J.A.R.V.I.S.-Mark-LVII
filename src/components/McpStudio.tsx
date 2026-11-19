import React, { useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  Copy,
  Download,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  Shield,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';

export type TrainingKind = 'skill' | 'rule' | 'qa' | 'correction' | 'persona';

export interface TrainingLessonItem {
  id: string;
  kind: TrainingKind;
  title: string;
  trigger?: string;
  content: string;
  source: 'claude-mcp' | 'user' | 'jarvis';
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpActivityItem {
  id: string;
  timestamp: string;
  client: string;
  transport: 'http' | 'sse' | 'hud';
  method: string;
  summary: string;
  ok: boolean;
}

export interface McpStudioState {
  token: string;
  requireAuth: boolean;
  lessons: TrainingLessonItem[];
  activityLog: McpActivityItem[];
  connectedClients: number;
  snapshotSyncedAt: string;
}

interface McpStudioProps {
  mcpState: McpStudioState | null;
  initialTab?: 'training' | 'connect' | 'console';
  busy?: boolean;
  onAddLesson: (input: {
    kind: TrainingKind;
    title: string;
    trigger?: string;
    content: string;
  }) => Promise<void>;
  onToggleLesson: (id: string) => Promise<void>;
  onDeleteLesson: (id: string) => Promise<void>;
  onRotateToken: () => Promise<void>;
  onToggleRequireAuth: (next: boolean) => Promise<void>;
  onRunRpcTest: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  onCloseToHud: () => void;
}

const KIND_LABELS: Record<TrainingKind, string> = {
  skill: 'Skill / Bilim',
  rule: 'Rule / Qoida',
  qa: 'Q&A Namuna',
  correction: 'Correction / Tuzatish',
  persona: 'Persona / Ohang',
};

export const McpStudio: React.FC<McpStudioProps> = ({
  mcpState,
  initialTab = 'training',
  busy = false,
  onAddLesson,
  onToggleLesson,
  onDeleteLesson,
  onRotateToken,
  onToggleRequireAuth,
  onRunRpcTest,
  onCloseToHud,
}) => {
  const [tab, setTab] = useState<'training' | 'connect' | 'console'>(initialTab);
  const [kindFilter, setKindFilter] = useState<'all' | TrainingKind>('all');

  // Add training lesson form
  const [kind, setKind] = useState<TrainingKind>('skill');
  const [title, setTitle] = useState('');
  const [trigger, setTrigger] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  // Live training test bar
  const [testPrompt, setTestPrompt] = useState('');
  const [testReply, setTestReply] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // Connect tab helpers
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);

  // Console RPC tester
  const [rpcOutput, setRpcOutput] = useState<string>('');
  const [rpcBusy, setRpcBusy] = useState(false);

  const origin = useMemo(() => {
    if (typeof window === 'undefined') return 'http://localhost:3000';
    return window.location.origin;
  }, []);

  const token = mcpState?.token || '';
  const requireAuth = mcpState?.requireAuth ?? false;
  const lessons = mcpState?.lessons || [];
  const activityLog = mcpState?.activityLog || [];

  const filteredLessons = useMemo(() => {
    if (kindFilter === 'all') return lessons;
    return lessons.filter((l) => l.kind === kindFilter);
  }, [lessons, kindFilter]);

  const activeCount = useMemo(() => lessons.filter((l) => l.enabled).length, [lessons]);

  const streamableUrl = `${origin}/api/mcp`;
  const tokenizedUrl = requireAuth ? `${origin}/api/mcp?token=${encodeURIComponent(token)}` : streamableUrl;
  const sseTokenizedUrl = requireAuth
    ? `${origin}/api/mcp/sse?token=${encodeURIComponent(token)}`
    : `${origin}/api/mcp/sse`;

  const claudeBridgeConfig = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            jarvis: {
              command: 'node',
              args: ['C:\\Users\\YOUR_NAME\\Downloads\\jarvis-mcp-bridge.mjs'],
            },
          },
        },
        null,
        2
      ),
    []
  );

  const claudeRemoteConfig = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            jarvis: {
              command: 'npx',
              args: requireAuth
                ? ['-y', 'mcp-remote', streamableUrl, '--header', `Authorization: Bearer ${token}`]
                : ['-y', 'mcp-remote', streamableUrl],
            },
          },
        },
        null,
        2
      ),
    [streamableUrl, token, requireAuth]
  );

  const claudeStarterPrompt =
    'jarvis MCP serveriga ulan. Avval get_jarvis_context va list_jarvis_lessons orqali hozirgi holatni tekshir. Keyin menga kerakli yangi bilim va qoidalarni teach_jarvis / teach_jarvis_batch bilan JARVISga oʻrgat va ask_jarvis orqali tekshir.';

  const copyText = (id: string, value: string) => {
    if (!value) return;
    navigator.clipboard?.writeText(value).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1800);
  };

  const handleSaveLesson = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !content.trim() || saving) return;
    setSaving(true);
    try {
      await onAddLesson({
        kind,
        title: title.trim(),
        trigger: trigger.trim() || undefined,
        content: content.trim(),
      });
      setTitle('');
      setTrigger('');
      setContent('');
    } finally {
      setSaving(false);
    }
  };

  const handleTestJarvis = async (overridePrompt?: string) => {
    const q = (overridePrompt ?? testPrompt).trim();
    if (!q || testing) return;
    if (overridePrompt) setTestPrompt(overridePrompt);
    setTesting(true);
    setTestReply(null);
    try {
      const resp = (await onRunRpcTest('tools/call', {
        name: 'ask_jarvis',
        arguments: { prompt: q },
      })) as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
      if (resp?.error?.message) {
        setTestReply(`Xatolik: ${resp.error.message}`);
        return;
      }
      const rawText = resp?.result?.content?.[0]?.text || '';
      try {
        const parsed = JSON.parse(rawText) as { jarvisReply?: string };
        setTestReply(parsed.jarvisReply || rawText);
      } catch {
        setTestReply(rawText || 'Javob olinmadi.');
      }
    } catch (err) {
      setTestReply(err instanceof Error ? err.message : 'Test failed.');
    } finally {
      setTesting(false);
    }
  };

  const handleConsoleRpc = async (method: string, params?: Record<string, unknown>) => {
    setRpcBusy(true);
    try {
      const resp = await onRunRpcTest(method, params);
      setRpcOutput(JSON.stringify(resp, null, 2));
    } catch (err) {
      setRpcOutput(err instanceof Error ? err.message : 'RPC call failed.');
    } finally {
      setRpcBusy(false);
    }
  };

  return (
    <div
      className="h-full w-full flex flex-col min-h-0"
      style={{ backgroundColor: 'var(--hud-bg)' }}
    >
      {/* Top Bar */}
      <div
        className="px-4 py-2.5 border-b flex flex-wrap items-center justify-between gap-2 shrink-0"
        style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)' }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <BookOpen className="w-4 h-4 shrink-0" style={{ color: 'var(--hud-pri)' }} />
          <div className="min-w-0">
            <div className="text-xs font-bold tracking-wider uppercase truncate" style={{ color: 'var(--hud-white)' }}>
              MCP STUDIO — CLAUDE AI TRAINING BRIDGE
            </div>
            <div className="text-[10px] font-mono truncate" style={{ color: 'var(--hud-text-dim)' }}>
              {activeCount} active lessons · {mcpState?.connectedClients || 0} live MCP sessions · JSON-RPC 2.0
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <button
            onClick={() => setTab('training')}
            className="px-2.5 py-1 text-[10px] font-mono border cursor-pointer whitespace-nowrap"
            style={{
              backgroundColor: tab === 'training' ? 'var(--hud-pri-gho)' : 'var(--hud-panel2)',
              borderColor: tab === 'training' ? 'var(--hud-pri)' : 'var(--hud-border)',
              color: tab === 'training' ? 'var(--hud-white)' : 'var(--hud-text)',
            }}
          >
            Training Base ({lessons.length})
          </button>
          <button
            onClick={() => setTab('connect')}
            className="px-2.5 py-1 text-[10px] font-mono border cursor-pointer whitespace-nowrap"
            style={{
              backgroundColor: tab === 'connect' ? 'var(--hud-pri-gho)' : 'var(--hud-panel2)',
              borderColor: tab === 'connect' ? 'var(--hud-pri)' : 'var(--hud-border)',
              color: tab === 'connect' ? 'var(--hud-white)' : 'var(--hud-text)',
            }}
          >
            Claude AI Connect
          </button>
          <button
            onClick={() => setTab('console')}
            className="px-2.5 py-1 text-[10px] font-mono border cursor-pointer whitespace-nowrap"
            style={{
              backgroundColor: tab === 'console' ? 'var(--hud-pri-gho)' : 'var(--hud-panel2)',
              borderColor: tab === 'console' ? 'var(--hud-pri)' : 'var(--hud-border)',
              color: tab === 'console' ? 'var(--hud-white)' : 'var(--hud-text)',
            }}
          >
            Live Console ({activityLog.length})
          </button>
          <button
            onClick={onCloseToHud}
            className="px-2.5 py-1 text-[10px] font-mono border flex items-center gap-1 cursor-pointer whitespace-nowrap"
            style={{
              backgroundColor: 'var(--hud-panel2)',
              borderColor: 'var(--hud-border)',
              color: 'var(--hud-text-med)',
            }}
          >
            <X className="w-3 h-3" /> 3D HUD
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {tab === 'training' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            {/* Left: Teach Lesson Form + Instant Evaluator */}
            <div className="lg:col-span-5 space-y-4">
              <form
                onSubmit={handleSaveLesson}
                className="p-3.5 border space-y-2.5"
                style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)' }}
              >
                <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--hud-pri)' }}>
                  Yangi bilim / qoida oʻrgatish
                </div>
                <p className="text-[11px] leading-snug" style={{ color: 'var(--hud-text-dim)' }}>
                  Bu yerda qoʻshilgan yoki Claude AI MCP orqali yuborilgan har bir bilim J.A.R.V.I.S. xulq-atvoriga darhol taʼsir qiladi.
                </p>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] font-mono mb-1" style={{ color: 'var(--hud-text-dim)' }}>
                      Turi
                    </label>
                    <select
                      value={kind}
                      onChange={(e) => setKind(e.target.value as TrainingKind)}
                      className="w-full px-2.5 py-1.5 text-xs border outline-none"
                      style={{
                        backgroundColor: 'var(--hud-panel2)',
                        borderColor: 'var(--hud-border)',
                        color: 'var(--hud-white)',
                      }}
                    >
                      <option value="skill">Skill / Bilim</option>
                      <option value="rule">Rule / Qoida</option>
                      <option value="qa">Q&amp;A Namuna</option>
                      <option value="correction">Correction / Tuzatish</option>
                      <option value="persona">Persona / Ohang</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-mono mb-1" style={{ color: 'var(--hud-text-dim)' }}>
                      Sarlavha
                    </label>
                    <input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Masalan: Maktab jadvali qoidasi"
                      className="w-full px-2.5 py-1.5 text-xs border outline-none"
                      style={{
                        backgroundColor: 'var(--hud-panel2)',
                        borderColor: 'var(--hud-border)',
                        color: 'var(--hud-white)',
                      }}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] font-mono mb-1" style={{ color: 'var(--hud-text-dim)' }}>
                    Trigger / Savol namunasi (ixtiyoriy)
                  </label>
                  <input
                    value={trigger}
                    onChange={(e) => setTrigger(e.target.value)}
                    placeholder="Qaysi savol yoki holatda qoʻllansin?"
                    className="w-full px-2.5 py-1.5 text-xs border outline-none"
                    style={{
                      backgroundColor: 'var(--hud-panel2)',
                      borderColor: 'var(--hud-border)',
                      color: 'var(--hud-white)',
                    }}
                  />
                </div>

                <div>
                  <label className="block text-[10px] font-mono mb-1" style={{ color: 'var(--hud-text-dim)' }}>
                    Koʻrsatma / Bilim matni
                  </label>
                  <textarea
                    rows={4}
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="J.A.R.V.I.S. nimani bilishi yoki qanday javob berishi kerak?"
                    className="w-full px-2.5 py-1.5 text-xs border outline-none resize-y"
                    style={{
                      backgroundColor: 'var(--hud-panel2)',
                      borderColor: 'var(--hud-border)',
                      color: 'var(--hud-white)',
                    }}
                  />
                </div>

                <button
                  type="submit"
                  disabled={saving || busy || !title.trim() || !content.trim()}
                  className="w-full py-2 px-3 text-xs font-semibold border flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                  style={{
                    backgroundColor: 'var(--hud-pri-gho)',
                    borderColor: 'var(--hud-pri)',
                    color: 'var(--hud-white)',
                  }}
                >
                  <Plus className="w-3.5 h-3.5" />
                  {saving ? 'Saqlanmoqda...' : 'Oʻqitishni saqlash'}
                </button>
              </form>

              {/* Test Trained Brain */}
              <div
                className="p-3.5 border space-y-2.5"
                style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)' }}
              >
                <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--hud-green)' }}>
                  Oʻqitilgan bilimlarni tekshirish (ask_jarvis)
                </div>
                <div className="flex gap-2">
                  <input
                    value={testPrompt}
                    onChange={(e) => setTestPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleTestJarvis();
                      }
                    }}
                    placeholder="Sinov savolini yozing..."
                    className="flex-1 px-2.5 py-1.5 text-xs border outline-none"
                    style={{
                      backgroundColor: 'var(--hud-panel2)',
                      borderColor: 'var(--hud-border)',
                      color: 'var(--hud-white)',
                    }}
                  />
                  <button
                    onClick={() => void handleTestJarvis()}
                    disabled={testing || !testPrompt.trim()}
                    className="px-3 py-1.5 text-xs font-mono border flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    style={{
                      backgroundColor: 'var(--hud-pri-gho)',
                      borderColor: 'var(--hud-pri)',
                      color: 'var(--hud-white)',
                    }}
                  >
                    <Play className="w-3 h-3" /> {testing ? '...' : 'Test'}
                  </button>
                </div>
                {testReply !== null && (
                  <div
                    className="p-2.5 border text-xs whitespace-pre-wrap leading-relaxed"
                    style={{
                      backgroundColor: 'var(--hud-panel2)',
                      borderColor: 'var(--hud-border)',
                      color: 'var(--hud-white)',
                    }}
                  >
                    {testReply}
                  </div>
                )}
              </div>
            </div>

            {/* Right: Trained Lessons List */}
            <div className="lg:col-span-7 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1 flex-wrap">
                  {(['all', 'skill', 'rule', 'qa', 'correction', 'persona'] as const).map((f) => (
                    <button
                      key={f}
                      onClick={() => setKindFilter(f)}
                      className="px-2 py-1 text-[10px] font-mono border cursor-pointer"
                      style={{
                        backgroundColor: kindFilter === f ? 'var(--hud-pri-gho)' : 'var(--hud-panel)',
                        borderColor: kindFilter === f ? 'var(--hud-pri)' : 'var(--hud-border)',
                        color: kindFilter === f ? 'var(--hud-white)' : 'var(--hud-text-dim)',
                      }}
                    >
                      {f === 'all' ? `All (${lessons.length})` : KIND_LABELS[f]}
                    </button>
                  ))}
                </div>
              </div>

              {filteredLessons.length === 0 ? (
                <div
                  className="p-6 border text-center space-y-2"
                  style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)' }}
                >
                  <div className="text-xs font-semibold" style={{ color: 'var(--hud-white)' }}>
                    Hozircha oʻqitilgan darslar yoʻq
                  </div>
                  <p className="text-[11px] max-w-md mx-auto" style={{ color: 'var(--hud-text-dim)' }}>
                    Chap tarafdan qoʻlda bilim qoʻshing yoki <strong>Claude AI Connect</strong> boʻlimidan Claude Desktop / Claude.ai ni ulang va Claude orqali J.A.R.V.I.S. ga yangi koʻnikmalarni oʻrgating.
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {filteredLessons.map((lesson) => (
                    <div
                      key={lesson.id}
                      className="p-3 border space-y-1.5"
                      style={{
                        backgroundColor: 'var(--hud-panel)',
                        borderColor: lesson.enabled ? 'var(--hud-border)' : 'var(--hud-panel2)',
                        opacity: lesson.enabled ? 1 : 0.65,
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-xs font-semibold truncate" style={{ color: 'var(--hud-white)' }}>
                            {lesson.title}
                          </div>
                          <div className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--hud-text-dim)' }}>
                            {KIND_LABELS[lesson.kind]} · {lesson.source === 'claude-mcp' ? 'Claude MCP' : lesson.source === 'jarvis' ? 'J.A.R.V.I.S.' : 'Operator'} · {lesson.enabled ? 'Faol' : 'Oʻchirilgan'}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {lesson.trigger && (
                            <button
                              onClick={() => void handleTestJarvis(lesson.trigger)}
                              className="px-2 py-0.5 text-[10px] font-mono border cursor-pointer"
                              style={{
                                borderColor: 'var(--hud-border)',
                                color: 'var(--hud-pri)',
                              }}
                              title="Ushbu triggerni sinab koʻrish"
                            >
                              Test
                            </button>
                          )}
                          <button
                            onClick={() => void onToggleLesson(lesson.id)}
                            className="px-2 py-0.5 text-[10px] font-mono border cursor-pointer"
                            style={{
                              borderColor: lesson.enabled ? 'var(--hud-green-d)' : 'var(--hud-border)',
                              color: lesson.enabled ? 'var(--hud-green)' : 'var(--hud-text-dim)',
                            }}
                          >
                            {lesson.enabled ? 'ON' : 'OFF'}
                          </button>
                          <button
                            onClick={() => void onDeleteLesson(lesson.id)}
                            className="p-1 border cursor-pointer"
                            style={{
                              borderColor: 'var(--hud-border)',
                              color: 'var(--hud-red)',
                            }}
                            title="Oʻchirish"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>

                      {lesson.trigger && (
                        <div className="text-[11px]" style={{ color: 'var(--hud-pri)' }}>
                          Trigger: {lesson.trigger}
                        </div>
                      )}
                      <div className="text-xs whitespace-pre-wrap leading-relaxed" style={{ color: 'var(--hud-text)' }}>
                        {lesson.content}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'connect' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Endpoints & Token */}
            <div
              className="p-4 border space-y-3"
              style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)' }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--hud-pri)' }}>
                  MCP Server Ulash Maʼlumotlari
                </div>
                <button
                  onClick={() => void onToggleRequireAuth(!requireAuth)}
                  className="px-2 py-1 text-[10px] font-mono border flex items-center gap-1 cursor-pointer"
                  style={{
                    borderColor: requireAuth ? 'var(--hud-green-d)' : 'var(--hud-amber)',
                    color: requireAuth ? 'var(--hud-green)' : 'var(--hud-amber)',
                  }}
                >
                  <Shield className="w-3 h-3" />
                  {requireAuth ? 'Token Auth: ON' : 'Token Auth: OFF'}
                </button>
              </div>

              <div className="space-y-2">
                <div>
                  <div className="text-[10px] font-mono mb-1" style={{ color: 'var(--hud-text-dim)' }}>
                    Streamable HTTP MCP URL (Claude.ai Custom Connector / mcp-remote)
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      readOnly
                      value={tokenizedUrl}
                      className="flex-1 px-2.5 py-1.5 text-[11px] font-mono border outline-none"
                      style={{
                        backgroundColor: 'var(--hud-panel2)',
                        borderColor: 'var(--hud-border)',
                        color: 'var(--hud-white)',
                      }}
                    />
                    <button
                      onClick={() => copyText('url', tokenizedUrl)}
                      className="px-2.5 py-1.5 text-[10px] font-mono border flex items-center gap-1 cursor-pointer"
                      style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-pri)' }}
                    >
                      {copiedId === 'url' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      Copy
                    </button>
                  </div>
                </div>

                <div>
                  <div className="text-[10px] font-mono mb-1" style={{ color: 'var(--hud-text-dim)' }}>
                    Legacy SSE Endpoint (eski MCP mijozlari uchun)
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      readOnly
                      value={sseTokenizedUrl}
                      className="flex-1 px-2.5 py-1.5 text-[11px] font-mono border outline-none"
                      style={{
                        backgroundColor: 'var(--hud-panel2)',
                        borderColor: 'var(--hud-border)',
                        color: 'var(--hud-text)',
                      }}
                    />
                    <button
                      onClick={() => copyText('sse', sseTokenizedUrl)}
                      className="px-2.5 py-1.5 text-[10px] font-mono border flex items-center gap-1 cursor-pointer"
                      style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-pri)' }}
                    >
                      {copiedId === 'sse' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      Copy
                    </button>
                  </div>
                </div>

                <div>
                  <div className="text-[10px] font-mono mb-1" style={{ color: 'var(--hud-text-dim)' }}>
                    Bearer Access Token
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      readOnly
                      type={showToken ? 'text' : 'password'}
                      value={token}
                      className="flex-1 px-2.5 py-1.5 text-[11px] font-mono border outline-none"
                      style={{
                        backgroundColor: 'var(--hud-panel2)',
                        borderColor: 'var(--hud-border)',
                        color: 'var(--hud-white)',
                      }}
                    />
                    <button
                      onClick={() => setShowToken((v) => !v)}
                      className="px-2 py-1.5 text-[10px] font-mono border cursor-pointer"
                      style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-text)' }}
                    >
                      {showToken ? 'Hide' : 'Show'}
                    </button>
                    <button
                      onClick={() => copyText('token', token)}
                      className="px-2 py-1.5 text-[10px] font-mono border flex items-center gap-1 cursor-pointer"
                      style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-pri)' }}
                    >
                      {copiedId === 'token' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </button>
                    <button
                      onClick={() => void onRotateToken()}
                      className="px-2 py-1.5 text-[10px] font-mono border flex items-center gap-1 cursor-pointer"
                      style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-amber)' }}
                      title="Yangi token yaratish"
                    >
                      <KeyRound className="w-3 h-3" /> Rotate
                    </button>
                  </div>
                </div>
              </div>

              <div
                className="p-3 border space-y-2"
                style={{ backgroundColor: 'var(--hud-panel2)', borderColor: 'var(--hud-border)' }}
              >
                <div className="text-[11px] font-semibold" style={{ color: 'var(--hud-white)' }}>
                  Claude AI ga yuborish uchun tayyor buyruq:
                </div>
                <div className="text-[11px] leading-relaxed" style={{ color: 'var(--hud-text)' }}>
                  {claudeStarterPrompt}
                </div>
                <button
                  onClick={() => copyText('starter', claudeStarterPrompt)}
                  className="px-2.5 py-1 text-[10px] font-mono border flex items-center gap-1 cursor-pointer"
                  style={{ borderColor: 'var(--hud-pri)', color: 'var(--hud-pri)' }}
                >
                  {copiedId === 'starter' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  Buyruqni nusxalash
                </button>
              </div>
            </div>

            {/* Claude Desktop Configs */}
            <div
              className="p-4 border space-y-3"
              style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)' }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--hud-pri)' }}>
                  Claude Desktop Sozlash (1-qadam)
                </div>
                <a
                  href="/api/mcp/bridge-script"
                  download="jarvis-mcp-bridge.mjs"
                  className="px-2.5 py-1 text-[10px] font-mono border flex items-center gap-1"
                  style={{
                    backgroundColor: 'var(--hud-pri-gho)',
                    borderColor: 'var(--hud-pri)',
                    color: 'var(--hud-white)',
                  }}
                >
                  <Download className="w-3 h-3" /> Download Bridge (.mjs)
                </a>
              </div>

              <p className="text-[11px] leading-snug" style={{ color: 'var(--hud-text-dim)' }}>
                1) <strong>Download Bridge (.mjs)</strong> tugmasini bosing. 2) Quyidagi JSON ni Claude Desktop dagi <code className="font-mono">claude_desktop_config.json</code> fayliga qoʻshing va yoʻlni saqlagan faylingizga moslang. 3) Claude Desktop ni qayta oching.
              </p>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono" style={{ color: 'var(--hud-text-dim)' }}>
                    Variant A: Lokal Node.js Bridge (eng barqaror)
                  </span>
                  <button
                    onClick={() => copyText('cfgA', claudeBridgeConfig)}
                    className="px-2 py-0.5 text-[10px] font-mono border flex items-center gap-1 cursor-pointer"
                    style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-pri)' }}
                  >
                    {copiedId === 'cfgA' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    Copy JSON
                  </button>
                </div>
                <pre
                  className="p-2.5 border text-[10px] font-mono overflow-x-auto"
                  style={{
                    backgroundColor: 'var(--hud-panel2)',
                    borderColor: 'var(--hud-border)',
                    color: 'var(--hud-white)',
                  }}
                >
                  {claudeBridgeConfig}
                </pre>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono" style={{ color: 'var(--hud-text-dim)' }}>
                    Variant B: npx mcp-remote orqali
                  </span>
                  <button
                    onClick={() => copyText('cfgB', claudeRemoteConfig)}
                    className="px-2 py-0.5 text-[10px] font-mono border flex items-center gap-1 cursor-pointer"
                    style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-pri)' }}
                  >
                    {copiedId === 'cfgB' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    Copy JSON
                  </button>
                </div>
                <pre
                  className="p-2.5 border text-[10px] font-mono overflow-x-auto"
                  style={{
                    backgroundColor: 'var(--hud-panel2)',
                    borderColor: 'var(--hud-border)',
                    color: 'var(--hud-text)',
                  }}
                >
                  {claudeRemoteConfig}
                </pre>
              </div>
            </div>
          </div>
        )}

        {tab === 'console' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-6 space-y-3">
              <div
                className="p-3.5 border space-y-2.5"
                style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)' }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color: 'var(--hud-pri)' }}>
                    <Terminal className="w-3.5 h-3.5" /> MCP JSON-RPC Diagnostika
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    onClick={() =>
                      void handleConsoleRpc('initialize', {
                        protocolVersion: '2025-03-26',
                        clientInfo: { name: 'HUD Simulator', version: '1.0' },
                      })
                    }
                    disabled={rpcBusy}
                    className="px-2.5 py-1 text-[10px] font-mono border cursor-pointer"
                    style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-white)' }}
                  >
                    initialize
                  </button>
                  <button
                    onClick={() => void handleConsoleRpc('tools/list')}
                    disabled={rpcBusy}
                    className="px-2.5 py-1 text-[10px] font-mono border cursor-pointer"
                    style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-white)' }}
                  >
                    tools/list
                  </button>
                  <button
                    onClick={() =>
                      void handleConsoleRpc('tools/call', {
                        name: 'get_jarvis_context',
                        arguments: { includeMessages: true },
                      })
                    }
                    disabled={rpcBusy}
                    className="px-2.5 py-1 text-[10px] font-mono border cursor-pointer"
                    style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-white)' }}
                  >
                    get_jarvis_context
                  </button>
                  <button
                    onClick={() =>
                      void handleConsoleRpc('tools/call', {
                        name: 'list_jarvis_lessons',
                        arguments: { kind: 'all' },
                      })
                    }
                    disabled={rpcBusy}
                    className="px-2.5 py-1 text-[10px] font-mono border cursor-pointer"
                    style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-white)' }}
                  >
                    list_jarvis_lessons
                  </button>
                </div>
                <pre
                  className="p-2.5 border text-[10px] font-mono max-h-80 overflow-auto whitespace-pre-wrap"
                  style={{
                    backgroundColor: 'var(--hud-panel2)',
                    borderColor: 'var(--hud-border)',
                    color: 'var(--hud-text)',
                  }}
                >
                  {rpcOutput || 'MCP JSON-RPC javobini koʻrish uchun yuqoridagi metodlardan birini bosing.'}
                </pre>
              </div>
            </div>

            <div className="lg:col-span-6 space-y-2">
              <div
                className="p-3.5 border space-y-2"
                style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)' }}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--hud-pri)' }}>
                    Kiruvchi MCP Amallar Jurnali
                  </span>
                  <span className="text-[10px] font-mono flex items-center gap-1" style={{ color: 'var(--hud-text-dim)' }}>
                    <RefreshCw className="w-3 h-3" /> Live SSE
                  </span>
                </div>

                {activityLog.length === 0 ? (
                  <div className="text-xs py-6 text-center" style={{ color: 'var(--hud-text-dim)' }}>
                    Hali MCP qoʻngʻiroqlari qayd etilmadi. Claude AI ulanganda barcha soʻrovlar shu yerda koʻrinadi.
                  </div>
                ) : (
                  <div className="space-y-1.5 max-h-80 overflow-y-auto">
                    {activityLog.map((evt) => (
                      <div
                        key={evt.id}
                        className="p-2 border text-[11px]"
                        style={{
                          backgroundColor: 'var(--hud-panel2)',
                          borderColor: evt.ok ? 'var(--hud-border)' : 'var(--hud-red)',
                        }}
                      >
                        <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
                          <span style={{ color: evt.ok ? 'var(--hud-pri)' : 'var(--hud-red)' }}>
                            {evt.method}
                          </span>
                          <span style={{ color: 'var(--hud-text-dim)' }}>
                            {evt.client} · {evt.transport.toUpperCase()} · {new Date(evt.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        <div className="mt-0.5" style={{ color: 'var(--hud-white)' }}>
                          {evt.summary}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
