import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  Trash2,
  Plus,
  Radio,
  Cpu,
  Sparkles,
  Brain,
  Smartphone,
  Server,
  RefreshCw,
  Rocket,
  Folder,
  FileText,
  Download,
  Upload,
  Terminal,
  ArrowUp,
  Eye,
  Play,
  Search,
} from 'lucide-react';
import { ACCENT_PRESETS } from '../lib/theme';
import type { MemoryItem, MonitorItem, UserProfile } from '../hooks/useJarvisData';

export interface RemoteServerStatusData {
  online: boolean;
  configured: boolean;
  url: string;
  checkedAt: string;
  latencyMs: number;
  platform: string;
  hostname: string;
  os: string;
  cpuName: string;
  cpuPct: number;
  totalMemMB: number;
  usedMemMB: number;
  freeMemMB: number;
  memPct: number;
  diskUsedGB: number;
  diskFreeGB: number;
  diskPct: number;
  uptimeMinutes: number;
  nodeVersion?: string;
  topProcesses: Array<{ name: string; pid: number; memMB: number }>;
  deployedApp?: {
    exists: boolean;
    path: string;
    built: boolean;
    running: boolean;
    port: number;
  };
  error?: string;
}

interface ModalShellProps {
  title: string;
  code: string;
  onClose: () => void;
  children: React.ReactNode;
}

const ModalShell: React.FC<ModalShellProps> = ({ title, code, onClose, children }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-xs p-4">
    <div
      className="hud-chamfer w-full max-w-lg border flex flex-col max-h-[85vh]"
      style={{
        backgroundColor: 'var(--hud-panel)',
        borderColor: 'var(--hud-border-b)',
      }}
    >
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b"
        style={{
          backgroundColor: 'var(--hud-panel2)',
          borderColor: 'var(--hud-border)',
        }}
      >
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-3.5" style={{ backgroundColor: 'var(--hud-pri)' }} />
          <span
            className="text-xs font-semibold tracking-[2px] uppercase"
            style={{ color: 'var(--hud-white)' }}
          >
            {title}
          </span>
          <span
            className="text-[10px] font-mono tracking-[1.4px]"
            style={{ color: 'var(--hud-pri-dim)' }}
          >
            {code}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:opacity-80 cursor-pointer"
          style={{ color: 'var(--hud-text-med)' }}
          aria-label="Close overlay"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="p-4 overflow-y-auto hud-scroll space-y-4">{children}</div>
    </div>
  </div>
);

interface CustomizeOverlayProps {
  profile: UserProfile;
  onSave: (patch: Partial<Omit<UserProfile, 'uid' | 'email'>>) => Promise<void>;
  onClose: () => void;
}

export const CustomizeOverlay: React.FC<CustomizeOverlayProps> = ({
  profile,
  onSave,
  onClose,
}) => {
  const [assistantName, setAssistantName] = useState(profile.assistantName);
  const [userName, setUserName] = useState(profile.userName);
  const [accentColor, setAccentColor] = useState(profile.accentColor);
  const [hudStyle, setHudStyle] = useState<'face' | 'reactor'>(profile.hudStyle);
  const [voiceName, setVoiceName] = useState(profile.voiceName);
  const [saving, setSaving] = useState(false);

  const handleApply = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await onSave({
        assistantName: assistantName.trim() || 'J.A.R.V.I.S',
        userName: userName.trim() || 'Sir',
        accentColor,
        hudStyle,
        voiceName,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalShell title="CUSTOMISE ASSISTANT" code="MARK LVII" onClose={onClose}>
      <form onSubmit={handleApply} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] tracking-[1.5px] uppercase mb-1" style={{ color: 'var(--hud-text-dim)' }}>
              Assistant Name
            </label>
            <input
              value={assistantName}
              onChange={(e) => setAssistantName(e.target.value)}
              maxLength={60}
              className="w-full px-2.5 py-1.5 text-xs border outline-none"
              style={{
                backgroundColor: 'var(--hud-bg)',
                borderColor: 'var(--hud-border-a)',
                color: 'var(--hud-white)',
              }}
            />
          </div>
          <div>
            <label className="block text-[10px] tracking-[1.5px] uppercase mb-1" style={{ color: 'var(--hud-text-dim)' }}>
              Your Name / Title
            </label>
            <input
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              maxLength={80}
              className="w-full px-2.5 py-1.5 text-xs border outline-none"
              style={{
                backgroundColor: 'var(--hud-bg)',
                borderColor: 'var(--hud-border-a)',
                color: 'var(--hud-white)',
              }}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] tracking-[1.5px] uppercase mb-1" style={{ color: 'var(--hud-text-dim)' }}>
              HUD Centrepiece
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {(['face', 'reactor'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setHudStyle(mode)}
                  className="py-1.5 text-[11px] font-semibold tracking-[1.2px] uppercase border cursor-pointer"
                  style={{
                    backgroundColor: hudStyle === mode ? 'var(--hud-pri-gho)' : 'var(--hud-bg)',
                    borderColor: hudStyle === mode ? 'var(--hud-pri)' : 'var(--hud-border)',
                    color: hudStyle === mode ? 'var(--hud-white)' : 'var(--hud-text-dim)',
                  }}
                >
                  {mode === 'face' ? '3D FACE' : 'REACTOR'}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-[10px] tracking-[1.5px] uppercase mb-1" style={{ color: 'var(--hud-text-dim)' }}>
              Gemini Voice
            </label>
            <select
              value={voiceName}
              onChange={(e) => setVoiceName(e.target.value)}
              className="w-full px-2.5 py-1.5 text-xs border outline-none"
              style={{
                backgroundColor: 'var(--hud-bg)',
                borderColor: 'var(--hud-border-a)',
                color: 'var(--hud-white)',
              }}
            >
              {['Charon', 'Fenrir', 'Kore', 'Puck', 'Aoede'].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[10px] tracking-[1.5px] uppercase mb-1.5" style={{ color: 'var(--hud-text-dim)' }}>
            HUD Accent Hue (Instant Retint)
          </label>
          <div className="flex flex-wrap gap-2 items-center">
            {ACCENT_PRESETS.map((p) => (
              <button
                key={p.hex}
                type="button"
                onClick={() => setAccentColor(p.hex)}
                className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-mono border cursor-pointer"
                style={{
                  borderColor: accentColor.toLowerCase() === p.hex ? p.hex : 'var(--hud-border)',
                  backgroundColor: 'var(--hud-bg)',
                  color: 'var(--hud-white)',
                }}
              >
                <span className="w-2.5 h-2.5 inline-block" style={{ backgroundColor: p.hex }} />
                {p.label}
              </button>
            ))}
            <input
              type="color"
              value={accentColor}
              onChange={(e) => setAccentColor(e.target.value)}
              className="w-8 h-7 border cursor-pointer bg-transparent"
              style={{ borderColor: 'var(--hud-border-a)' }}
              aria-label="Custom accent hex color"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t" style={{ borderColor: 'var(--hud-border)' }}>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-[11px] font-semibold tracking-[1px] uppercase border cursor-pointer"
            style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-text-med)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-1.5 text-[11px] font-semibold tracking-[1px] uppercase border cursor-pointer"
            style={{
              backgroundColor: 'var(--hud-pri-gho)',
              borderColor: 'var(--hud-pri)',
              color: 'var(--hud-white)',
            }}
          >
            {saving ? 'Applying...' : 'Apply Changes'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
};

interface MemoryOverlayProps {
  memories: MemoryItem[];
  monitors: MonitorItem[];
  onAddMemory: (cat: MemoryItem['category'], key: string, content: string) => Promise<void>;
  onDeleteMemory: (id: string) => Promise<void>;
  onAddMonitor: (topic: string, freq: 'daily' | 'hourly' | 'weekly') => Promise<void>;
  onDeleteMonitor: (id: string) => Promise<void>;
  onClose: () => void;
}

export const MemoryOverlay: React.FC<MemoryOverlayProps> = ({
  memories,
  monitors,
  onAddMemory,
  onDeleteMemory,
  onAddMonitor,
  onDeleteMonitor,
  onClose,
}) => {
  const [tab, setTab] = useState<'memory' | 'monitors'>('memory');
  const [category, setCategory] = useState<MemoryItem['category']>('fact');
  const [keyInput, setKeyInput] = useState('');
  const [contentInput, setContentInput] = useState('');
  const [topicInput, setTopicInput] = useState('');
  const [freq, setFreq] = useState<'daily' | 'hourly' | 'weekly'>('daily');

  const submitMemory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyInput.trim() || !contentInput.trim()) return;
    await onAddMemory(category, keyInput, contentInput);
    setKeyInput('');
    setContentInput('');
  };

  const submitMonitor = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topicInput.trim()) return;
    await onAddMonitor(topicInput, freq);
    setTopicInput('');
  };

  return (
    <ModalShell title="LONG-TERM MEMORY & MONITORS" code="FIRESTORE" onClose={onClose}>
      <div className="flex gap-2 border-b pb-2" style={{ borderColor: 'var(--hud-border)' }}>
        <button
          onClick={() => setTab('memory')}
          className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-semibold tracking-[1.4px] uppercase border cursor-pointer"
          style={{
            backgroundColor: tab === 'memory' ? 'var(--hud-pri-gho)' : 'transparent',
            borderColor: tab === 'memory' ? 'var(--hud-pri)' : 'var(--hud-border)',
            color: tab === 'memory' ? 'var(--hud-white)' : 'var(--hud-text-dim)',
          }}
        >
          <Brain className="w-3.5 h-3.5" /> Memories ({memories.length})
        </button>
        <button
          onClick={() => setTab('monitors')}
          className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-semibold tracking-[1.4px] uppercase border cursor-pointer"
          style={{
            backgroundColor: tab === 'monitors' ? 'var(--hud-pri-gho)' : 'transparent',
            borderColor: tab === 'monitors' ? 'var(--hud-pri)' : 'var(--hud-border)',
            color: tab === 'monitors' ? 'var(--hud-white)' : 'var(--hud-text-dim)',
          }}
        >
          <Radio className="w-3.5 h-3.5" /> Topic Monitors ({monitors.length})
        </button>
      </div>

      {tab === 'memory' ? (
        <div className="space-y-3">
          <form onSubmit={submitMemory} className="space-y-2 border p-2.5" style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-bg)' }}>
            <div className="grid grid-cols-3 gap-2">
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as MemoryItem['category'])}
                className="px-2 py-1 text-xs border outline-none"
                style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border-a)', color: 'var(--hud-white)' }}
              >
                <option value="identity">identity</option>
                <option value="preference">preference</option>
                <option value="project">project</option>
                <option value="session">session</option>
                <option value="fact">fact</option>
              </select>
              <input
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="Key (e.g. timezone)"
                className="col-span-2 px-2 py-1 text-xs border outline-none"
                style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border-a)', color: 'var(--hud-white)' }}
              />
            </div>
            <div className="flex gap-2">
              <input
                value={contentInput}
                onChange={(e) => setContentInput(e.target.value)}
                placeholder="Memory detail..."
                className="flex-1 px-2 py-1 text-xs border outline-none"
                style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border-a)', color: 'var(--hud-white)' }}
              />
              <button
                type="submit"
                className="px-3 py-1 text-[10px] font-semibold tracking-[1px] uppercase border flex items-center gap-1 cursor-pointer"
                style={{ backgroundColor: 'var(--hud-pri-gho)', borderColor: 'var(--hud-pri)', color: 'var(--hud-white)' }}
              >
                <Plus className="w-3 h-3" /> Save
              </button>
            </div>
          </form>

          <div className="space-y-1.5 max-h-64 overflow-y-auto hud-scroll">
            {memories.length === 0 ? (
              <p className="text-xs py-4 text-center" style={{ color: 'var(--hud-text-dim)' }}>
                No persistent memories stored yet. Tell J.A.R.V.I.S what to remember.
              </p>
            ) : (
              memories.map((m) => (
                <div
                  key={m.id}
                  className="flex items-start justify-between gap-2 p-2 border text-xs"
                  style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-panel2)' }}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 border" style={{ borderColor: 'var(--hud-pri-dim)', color: 'var(--hud-pri)' }}>
                        {m.category}
                      </span>
                      <span className="font-semibold truncate" style={{ color: 'var(--hud-white)' }}>
                        {m.key}
                      </span>
                    </div>
                    <p className="mt-1 hud-selectable" style={{ color: 'var(--hud-text-med)' }}>
                      {m.content}
                    </p>
                  </div>
                  <button
                    onClick={() => onDeleteMemory(m.id)}
                    className="p-1 hover:opacity-75 cursor-pointer shrink-0"
                    style={{ color: 'var(--hud-red)' }}
                    aria-label="Delete memory"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <form onSubmit={submitMonitor} className="flex gap-2 border p-2.5" style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-bg)' }}>
            <input
              value={topicInput}
              onChange={(e) => setTopicInput(e.target.value)}
              placeholder="Topic to watch (e.g. Gemini API updates)"
              className="flex-1 px-2 py-1 text-xs border outline-none"
              style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border-a)', color: 'var(--hud-white)' }}
            />
            <select
              value={freq}
              onChange={(e) => setFreq(e.target.value as 'daily' | 'hourly' | 'weekly')}
              className="px-2 py-1 text-xs border outline-none"
              style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border-a)', color: 'var(--hud-white)' }}
            >
              <option value="daily">daily</option>
              <option value="hourly">hourly</option>
              <option value="weekly">weekly</option>
            </select>
            <button
              type="submit"
              className="px-3 py-1 text-[10px] font-semibold uppercase border cursor-pointer"
              style={{ backgroundColor: 'var(--hud-pri-gho)', borderColor: 'var(--hud-pri)', color: 'var(--hud-white)' }}
            >
              Watch
            </button>
          </form>

          <div className="space-y-1.5 max-h-64 overflow-y-auto hud-scroll">
            {monitors.length === 0 ? (
              <p className="text-xs py-4 text-center" style={{ color: 'var(--hud-text-dim)' }}>
                No background topic monitors configured.
              </p>
            ) : (
              monitors.map((mon) => (
                <div
                  key={mon.id}
                  className="flex items-center justify-between gap-2 p-2 border text-xs"
                  style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-panel2)' }}
                >
                  <div>
                    <span className="font-semibold" style={{ color: 'var(--hud-white)' }}>
                      {mon.topic}
                    </span>
                    <span className="ml-2 text-[10px] font-mono uppercase" style={{ color: 'var(--hud-pri-dim)' }}>
                      [{mon.frequency}]
                    </span>
                  </div>
                  <button
                    onClick={() => onDeleteMonitor(mon.id)}
                    className="p-1 hover:opacity-75 cursor-pointer"
                    style={{ color: 'var(--hud-red)' }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </ModalShell>
  );
};

export const RemoteOverlay: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const url = typeof window !== 'undefined' ? window.location.href : '';
  return (
    <ModalShell title="REMOTE COMPANION" code="CLOUD SYNC" onClose={onClose}>
      <div className="space-y-3 text-xs">
        <div className="flex items-start gap-3 p-3 border" style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-bg)' }}>
          <Smartphone className="w-6 h-6 shrink-0 mt-0.5" style={{ color: 'var(--hud-pri)' }} />
          <div>
            <p className="font-semibold" style={{ color: 'var(--hud-white)' }}>
              Synchronized Phone & Desktop Access
            </p>
            <p className="mt-1 leading-relaxed" style={{ color: 'var(--hud-text-med)' }}>
              Open this workspace URL on your phone and sign in with the same Google account. Communications log, memories, routines, and background tasks synchronize live via Firestore.
            </p>
          </div>
        </div>
        <div className="p-2.5 border font-mono text-[11px] break-all hud-selectable" style={{ borderColor: 'var(--hud-border-a)', backgroundColor: 'var(--hud-panel2)', color: 'var(--hud-white)' }}>
          {url}
        </div>
      </div>
    </ModalShell>
  );
};

export const EngineOverlay: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <ModalShell title="ENGINE & CAPABILITIES" code="MARK LVII WEB" onClose={onClose}>
    <div className="space-y-3 text-xs">
      <div className="p-3 border space-y-1.5" style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-bg)' }}>
        <div className="flex items-center gap-2 font-semibold" style={{ color: 'var(--hud-white)' }}>
          <Cpu className="w-4 h-4" style={{ color: 'var(--hud-pri)' }} /> Active Neural Stack
        </div>
        <p style={{ color: 'var(--hud-text-med)' }}>Core Reasoning & Grounding: gemini-4-hydrogen (Server-Side)</p>
        <p style={{ color: 'var(--hud-text-med)' }}>Voice Synthesis (TTS): gemini-3.8-flash-lite-tts</p>
        <p style={{ color: 'var(--hud-text-med)' }}>Audio Transcription: gemini-3.5-transcribe + Web Speech</p>
        <p style={{ color: 'var(--hud-text-med)' }}>State & Memory Persistence: Firebase Firestore + Auth</p>
      </div>
      <div className="p-3 border space-y-1.5" style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-bg)' }}>
        <div className="flex items-center gap-2 font-semibold" style={{ color: 'var(--hud-white)' }}>
          <Sparkles className="w-4 h-4" style={{ color: 'var(--hud-acc)' }} /> Web Runtime Scope
        </div>
        <p className="leading-relaxed" style={{ color: 'var(--hud-text-dim)' }}>
          All web-compatible Mark-XXX subsystems are active: 3D Face & Reactor HUD, voice I/O, webcam & screen vision, file analysis, multi-mode Google Search, clipboard intelligence, autonomous background tasks, routines, remote server diagnostics, and persistent memory.
        </p>
      </div>
    </div>
  </ModalShell>
);

interface RemoteFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: string;
}

interface RemoteFileListPayload {
  cwd: string;
  parent: string | null;
  drives: string[];
  entries: RemoteFileEntry[];
}

export interface RemoteFilePreviewData {
  name: string;
  path: string;
  size: number;
  kind: 'text' | 'image' | 'pdf' | 'video' | 'audio' | 'other';
  mimeType: string;
  textContent?: string;
  viewUrl: string;
  launchResult?: {
    launched: boolean;
    path: string;
    sessionId: number;
    note: string;
  };
}

interface ServerNodeOverlayProps {
  status: RemoteServerStatusData | null;
  onStatusChange: (status: RemoteServerStatusData) => void;
  onOpenFile?: (path: string) => void;
  onClose: () => void;
}

export const ServerNodeOverlay: React.FC<ServerNodeOverlayProps> = ({
  status,
  onStatusChange,
  onOpenFile,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'telemetry' | 'files' | 'terminal'>('telemetry');
  const [url, setUrl] = useState(status?.url || '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hasPassword, setHasPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Remote file explorer state
  const [fileList, setFileList] = useState<RemoteFileListPayload | null>(null);
  const [pathInput, setPathInput] = useState('HOME');
  const [searchInput, setSearchInput] = useState('');
  const [filesLoading, setFilesLoading] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [fileFeedback, setFileFeedback] = useState<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

  // Remote terminal state
  const [termCwd, setTermCwd] = useState('');
  const [termCmd, setTermCmd] = useState('');
  const [termRunning, setTermRunning] = useState(false);
  const [termLog, setTermLog] = useState<Array<{ cmd: string; cwd: string; out: string }>>([]);

  useEffect(() => {
    fetch('/api/server/config')
      .then((r) => r.json())
      .then((cfg: { url?: string; username?: string; hasPassword?: boolean }) => {
        if (cfg.url) setUrl(cfg.url);
        if (cfg.username) setUsername(cfg.username);
        setHasPassword(Boolean(cfg.hasPassword));
      })
      .catch(() => {});
  }, []);

  const loadFiles = async (targetPath?: string) => {
    setFilesLoading(true);
    setFileFeedback(null);
    try {
      const q = targetPath !== undefined ? targetPath : pathInput;
      const res = await fetch(`/api/server/files?path=${encodeURIComponent(q)}`);
      const data = (await res.json()) as RemoteFileListPayload & { error?: string };
      if (!res.ok) throw new Error(data.error || 'Failed to read directory');
      setFileList(data);
      setPathInput(data.cwd || q);
      if (!termCwd && data.cwd) setTermCwd(data.cwd);
    } catch (err) {
      setFileFeedback(err instanceof Error ? err.message : 'Directory load failed');
    } finally {
      setFilesLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'files' && !fileList && status?.configured) {
      void loadFiles('HOME');
    }
  }, [activeTab]);

  const searchFiles = async () => {
    const q = searchInput.trim();
    if (!q) {
      await loadFiles(fileList?.cwd || pathInput || 'HOME');
      return;
    }
    setFilesLoading(true);
    setFileFeedback(null);
    try {
      const root = fileList?.cwd || pathInput || 'HOME';
      const res = await fetch(
        `/api/server/files/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(root)}`
      );
      const data = (await res.json()) as {
        root?: string;
        query?: string;
        matches?: RemoteFileEntry[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error || 'Search failed');
      setFileList({
        cwd: data.root || root,
        parent: data.root || null,
        drives: fileList?.drives || ['C:\\'],
        entries: data.matches || [],
      });
      setFileFeedback(`Found ${(data.matches || []).length} match(es) for "${q}"`);
    } catch (err) {
      setFileFeedback(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setFilesLoading(false);
    }
  };

  const handleDownloadFile = async (entry: RemoteFileEntry) => {
    setDownloadingPath(entry.path);
    setFileFeedback(null);
    try {
      const res = await fetch(`/api/server/files/download?path=${encodeURIComponent(entry.path)}`);
      if (!res.ok) {
        const errData = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errData.error || 'Download failed');
      }
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = entry.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
      setFileFeedback(`Downloaded ${entry.name}`);
    } catch (err) {
      setFileFeedback(err instanceof Error ? err.message : 'Download error');
    } finally {
      setDownloadingPath(null);
    }
  };

  const handleUploadFile = async (file: File) => {
    if (file.size > 15 * 1024 * 1024) {
      setFileFeedback('File exceeds 15 MB transfer limit.');
      return;
    }
    setUploadingFile(true);
    setFileFeedback(`Uploading ${file.name}...`);
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
        reader.onerror = () => reject(new Error('Failed to read local file'));
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/server/files/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetDir: fileList?.cwd || pathInput || 'HOME',
          fileName: file.name,
          base64,
        }),
      });
      const data = (await res.json()) as { ok?: boolean; path?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setFileFeedback(`Saved to ${data.path}`);
      await loadFiles(fileList?.cwd || pathInput);
    } catch (err) {
      setFileFeedback(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploadingFile(false);
    }
  };

  const runTerminalCommand = async (cmdOverride?: string) => {
    const command = (cmdOverride ?? termCmd).trim();
    if (!command || termRunning) return;
    if (!cmdOverride) setTermCmd('');
    setTermRunning(true);
    try {
      const res = await fetch('/api/server/exec', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, cwd: termCwd || undefined }),
      });
      const data = (await res.json()) as { output?: string; cwd?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'Execution failed');
      if (data.cwd) setTermCwd(data.cwd);
      setTermLog((prev) => [
        ...prev.slice(-14),
        { cmd: command, cwd: data.cwd || termCwd || 'remote', out: data.output || '(no output)' },
      ]);
    } catch (err) {
      setTermLog((prev) => [
        ...prev.slice(-14),
        {
          cmd: command,
          cwd: termCwd || 'remote',
          out: `Error: ${err instanceof Error ? err.message : 'Command failed'}`,
        },
      ]);
    } finally {
      setTermRunning(false);
    }
  };

  const refreshStatus = async () => {
    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/server/status?force=1');
      const data = (await res.json()) as RemoteServerStatusData;
      onStatusChange(data);
      if (!data.online && data.error) {
        setFeedback(data.error);
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setLoading(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/server/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), username: username.trim(), password }),
      });
      const data = (await res.json()) as {
        error?: string;
        status?: RemoteServerStatusData;
        config?: { hasPassword?: boolean };
      };
      if (!res.ok) throw new Error(data.error || 'Configuration failed');
      if (data.status) onStatusChange(data.status);
      if (data.config) setHasPassword(Boolean(data.config.hasPassword));
      setPassword('');
      setFeedback(
        data.status?.online
          ? `Connected to ${data.status.hostname} (${data.status.latencyMs} ms).`
          : data.status?.error || 'Configuration saved.'
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setLoading(false);
    }
  };

  const triggerDeploy = async () => {
    setDeploying(true);
    setFeedback('Deploying Mark LVII bundle to remote server...');
    try {
      const res = await fetch('/api/server/deploy', { method: 'POST' });
      const data = (await res.json()) as { ok?: boolean; message?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'Deployment failed');
      setFeedback(data.message || 'Deployment completed.');
      await refreshStatus();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Deployment error');
    } finally {
      setDeploying(false);
    }
  };

  const formatUp = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}m`;
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <ModalShell title="SERVER NODE CONTROL" code={status?.online ? status.hostname : 'STANDBY'} onClose={onClose}>
      <div className="flex gap-1.5 border-b pb-2" style={{ borderColor: 'var(--hud-border)' }}>
        {(
          [
            { id: 'telemetry', label: 'TELEMETRY', icon: Server },
            { id: 'files', label: 'FILES', icon: Folder },
            { id: 'terminal', label: 'TERMINAL', icon: Terminal },
          ] as const
        ).map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className="flex items-center gap-1.5 px-3 py-1 text-[10px] font-semibold tracking-[1.3px] uppercase border cursor-pointer"
              style={{
                backgroundColor: active ? 'var(--hud-pri-gho)' : 'transparent',
                borderColor: active ? 'var(--hud-pri)' : 'var(--hud-border)',
                color: active ? 'var(--hud-white)' : 'var(--hud-text-dim)',
              }}
            >
              <Icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'telemetry' && (
        <div className="space-y-3 text-xs">
          <div className="p-3 border space-y-2" style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-bg)' }}>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-semibold" style={{ color: 'var(--hud-white)' }}>
                <Server className="w-4 h-4" style={{ color: status?.online ? 'var(--hud-green)' : 'var(--hud-red)' }} />
                <span>{status?.hostname || 'No Host Connected'}</span>
                {status?.online && (
                  <span className="text-[10px] font-mono px-1.5 py-0.5 border" style={{ borderColor: 'var(--hud-green-d)', color: 'var(--hud-green)' }}>
                    {status.latencyMs} ms
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={refreshStatus}
                  disabled={loading || deploying}
                  className="px-2 py-1 text-[10px] font-semibold uppercase border flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  style={{ borderColor: 'var(--hud-pri)', backgroundColor: 'var(--hud-pri-gho)', color: 'var(--hud-white)' }}
                >
                  <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} /> Refresh
                </button>
                <button
                  type="button"
                  onClick={triggerDeploy}
                  disabled={loading || deploying || !status?.configured}
                  className="px-2 py-1 text-[10px] font-semibold uppercase border flex items-center gap-1 cursor-pointer disabled:opacity-50"
                  style={{ borderColor: 'var(--hud-acc)', color: 'var(--hud-acc)', backgroundColor: 'var(--hud-panel2)' }}
                >
                  <Rocket className="w-3 h-3" /> {deploying ? 'Deploying...' : 'Deploy'}
                </button>
              </div>
            </div>

            {status?.online ? (
              <div className="grid grid-cols-2 gap-2 pt-1 font-mono text-[11px]">
                <div className="p-2 border" style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-panel2)' }}>
                  <div className="text-[9px]" style={{ color: 'var(--hud-text-dim)' }}>OS / RUNTIME</div>
                  <div className="truncate" style={{ color: 'var(--hud-white)' }}>{status.os}</div>
                  <div className="text-[10px]" style={{ color: 'var(--hud-pri)' }}>
                    Uptime: {formatUp(status.uptimeMinutes)} {status.nodeVersion ? `· ${status.nodeVersion}` : ''}
                  </div>
                </div>
                <div className="p-2 border" style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-panel2)' }}>
                  <div className="text-[9px]" style={{ color: 'var(--hud-text-dim)' }}>PROCESSOR</div>
                  <div className="truncate" style={{ color: 'var(--hud-white)' }}>{status.cpuName}</div>
                  <div className="text-[10px]" style={{ color: 'var(--hud-green)' }}>Load: {status.cpuPct}%</div>
                </div>
                <div className="p-2 border" style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-panel2)' }}>
                  <div className="text-[9px]" style={{ color: 'var(--hud-text-dim)' }}>MEMORY</div>
                  <div style={{ color: 'var(--hud-white)' }}>{status.usedMemMB} / {status.totalMemMB} MB</div>
                  <div className="text-[10px]" style={{ color: status.memPct > 85 ? 'var(--hud-acc)' : 'var(--hud-green)' }}>
                    {status.memPct}% used ({status.freeMemMB} MB free)
                  </div>
                </div>
                <div className="p-2 border" style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-panel2)' }}>
                  <div className="text-[9px]" style={{ color: 'var(--hud-text-dim)' }}>DISK C:\</div>
                  <div style={{ color: 'var(--hud-white)' }}>{status.diskUsedGB} GB used</div>
                  <div className="text-[10px]" style={{ color: 'var(--hud-green)' }}>
                    {status.diskFreeGB} GB free ({status.diskPct}%)
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-[11px]" style={{ color: 'var(--hud-text-dim)' }}>
                {status?.error || 'Server status not yet fetched. Click Refresh or configure connection below.'}
              </p>
            )}

            {status?.deployedApp && (
              <div className="p-2 border font-mono text-[10px] flex items-center justify-between" style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-panel2)' }}>
                <span className="truncate" style={{ color: 'var(--hud-text-med)' }}>
                  DEPLOY: {status.deployedApp.path}
                </span>
                <span style={{ color: status.deployedApp.running ? 'var(--hud-green)' : 'var(--hud-acc)' }}>
                  {status.deployedApp.running
                    ? `LIVE :${status.deployedApp.port}`
                    : status.deployedApp.built
                    ? 'BUILT (STOPPED)'
                    : status.deployedApp.exists
                    ? 'PRESENT'
                    : 'NOT DEPLOYED'}
                </span>
              </div>
            )}

            {status?.topProcesses && status.topProcesses.length > 0 && (
              <div className="space-y-1 pt-1">
                <div className="text-[9px] font-mono uppercase" style={{ color: 'var(--hud-pri-dim)' }}>
                  Top Processes (Memory)
                </div>
                <div className="grid grid-cols-2 gap-1 font-mono text-[10px]">
                  {status.topProcesses.slice(0, 6).map((p) => (
                    <div
                      key={`${p.pid}_${p.name}`}
                      className="flex justify-between px-2 py-1 border"
                      style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-panel2)' }}
                    >
                      <span className="truncate" style={{ color: 'var(--hud-white)' }}>{p.name}</span>
                      <span style={{ color: 'var(--hud-pri)' }}>{p.memMB} MB</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <form onSubmit={saveConfig} className="p-3 border space-y-2.5" style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-bg)' }}>
            <div className="text-[10px] font-mono uppercase tracking-[1.4px]" style={{ color: 'var(--hud-pri-dim)' }}>
              Server Tunnel Connection (ttyd)
            </div>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://your-tunnel.trycloudflare.com"
              className="w-full px-2.5 py-1.5 text-xs border outline-none font-mono"
              style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border-a)', color: 'var(--hud-white)' }}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Login (e.g. server)"
                className="px-2.5 py-1.5 text-xs border outline-none font-mono"
                style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border-a)', color: 'var(--hud-white)' }}
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={hasPassword ? '•••••••• (unchanged if blank)' : 'Password'}
                className="px-2.5 py-1.5 text-xs border outline-none font-mono"
                style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border-a)', color: 'var(--hud-white)' }}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] truncate" style={{ color: 'var(--hud-text-med)' }}>
                {feedback || 'Ask J.A.R.V.I.S "server holati qanday?" anytime for live diagnostics.'}
              </span>
              <button
                type="submit"
                disabled={loading || deploying}
                className="px-3 py-1.5 text-[10px] font-semibold uppercase border cursor-pointer shrink-0"
                style={{ backgroundColor: 'var(--hud-pri-gho)', borderColor: 'var(--hud-pri)', color: 'var(--hud-white)' }}
              >
                Connect
              </button>
            </div>
          </form>
        </div>
      )}

      {activeTab === 'files' && (
        <div className="space-y-2.5 text-xs">
          <div className="flex flex-wrap gap-1">
            {(['HOME', 'DESKTOP', 'DOCUMENTS', 'DOWNLOADS'] as const).map((shortcut) => (
              <button
                key={shortcut}
                type="button"
                onClick={() => void loadFiles(shortcut)}
                className="px-2 py-0.5 text-[9px] font-mono uppercase border cursor-pointer"
                style={{
                  borderColor: 'var(--hud-border-a)',
                  backgroundColor: 'var(--hud-panel2)',
                  color: 'var(--hud-pri)',
                }}
              >
                {shortcut}
              </button>
            ))}
            {(fileList?.drives || []).map((drv) => (
              <button
                key={drv}
                type="button"
                onClick={() => void loadFiles(drv)}
                className="px-2 py-0.5 text-[9px] font-mono uppercase border cursor-pointer"
                style={{
                  borderColor: 'var(--hud-border)',
                  backgroundColor: 'var(--hud-bg)',
                  color: 'var(--hud-white)',
                }}
              >
                {drv}
              </button>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void loadFiles(pathInput);
            }}
            className="flex gap-1.5"
          >
            <button
              type="button"
              disabled={!fileList?.parent || filesLoading}
              onClick={() => fileList?.parent && void loadFiles(fileList.parent)}
              className="px-2 py-1 border cursor-pointer disabled:opacity-40"
              style={{ borderColor: 'var(--hud-border-a)', backgroundColor: 'var(--hud-panel2)', color: 'var(--hud-white)' }}
              title="Parent Folder"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              className="flex-1 px-2 py-1 text-[11px] font-mono border outline-none"
              style={{ backgroundColor: 'var(--hud-bg)', borderColor: 'var(--hud-border-a)', color: 'var(--hud-white)' }}
            />
            <button
              type="submit"
              disabled={filesLoading}
              className="px-2.5 py-1 text-[10px] font-semibold uppercase border cursor-pointer"
              style={{ borderColor: 'var(--hud-pri)', backgroundColor: 'var(--hud-pri-gho)', color: 'var(--hud-white)' }}
            >
              {filesLoading ? '...' : 'Open'}
            </button>
            <button
              type="button"
              disabled={uploadingFile}
              onClick={() => uploadInputRef.current?.click()}
              className="px-2.5 py-1 text-[10px] font-semibold uppercase border flex items-center gap-1 cursor-pointer disabled:opacity-50"
              style={{ borderColor: 'var(--hud-green)', color: 'var(--hud-green)', backgroundColor: 'var(--hud-panel2)' }}
            >
              <Upload className="w-3 h-3" /> {uploadingFile ? 'Saving...' : 'Save Here'}
            </button>
            <input
              ref={uploadInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUploadFile(f);
                e.target.value = '';
              }}
            />
          </form>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void searchFiles();
            }}
            className="flex gap-1.5"
          >
            <input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search filename across folders (e.g. hisobot, .pdf, mp4)..."
              className="flex-1 px-2 py-1 text-[11px] font-mono border outline-none"
              style={{ backgroundColor: 'var(--hud-bg)', borderColor: 'var(--hud-border-a)', color: 'var(--hud-white)' }}
            />
            <button
              type="submit"
              disabled={filesLoading}
              className="px-2.5 py-1 text-[10px] font-semibold uppercase border flex items-center gap-1 cursor-pointer"
              style={{ borderColor: 'var(--hud-pri)', backgroundColor: 'var(--hud-panel2)', color: 'var(--hud-pri)' }}
            >
              <Search className="w-3 h-3" /> Find
            </button>
          </form>

          {fileFeedback && (
            <div className="px-2 py-1 border text-[11px] font-mono truncate" style={{ borderColor: 'var(--hud-pri-dim)', color: 'var(--hud-pri)' }}>
              {fileFeedback}
            </div>
          )}

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) void handleUploadFile(f);
            }}
            className="border max-h-64 overflow-y-auto hud-scroll divide-y"
            style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-bg)' }}
          >
            {filesLoading && !fileList ? (
              <div className="p-4 text-center text-[11px]" style={{ color: 'var(--hud-text-dim)' }}>
                Loading remote filesystem...
              </div>
            ) : !fileList || fileList.entries.length === 0 ? (
              <div className="p-4 text-center text-[11px]" style={{ color: 'var(--hud-text-dim)' }}>
                Folder is empty or inaccessible. Drop a file here to save it to this directory.
              </div>
            ) : (
              fileList.entries.map((entry) => (
                <div
                  key={entry.path}
                  className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] hover:bg-white/5"
                  style={{ borderColor: 'var(--hud-border)' }}
                >
                  {entry.isDir ? (
                    <button
                      type="button"
                      onClick={() => void loadFiles(entry.path)}
                      className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                      style={{ color: 'var(--hud-pri)' }}
                    >
                      <Folder className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate font-semibold">{entry.name}</span>
                    </button>
                  ) : (
                    <div className="flex items-center gap-2 min-w-0 flex-1" style={{ color: 'var(--hud-white)' }}>
                      <FileText className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--hud-text-dim)' }} />
                      <span className="truncate">{entry.name}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2 shrink-0 font-mono text-[10px]">
                    <span style={{ color: 'var(--hud-text-dim)' }}>
                      {entry.isDir ? 'DIR' : formatBytes(entry.size)}
                    </span>
                    {!entry.isDir && (
                      <div className="flex items-center gap-1">
                        {onOpenFile && (
                          <button
                            type="button"
                            onClick={() => onOpenFile(entry.path)}
                            className="px-1.5 py-0.5 border flex items-center gap-1 cursor-pointer"
                            style={{ borderColor: 'var(--hud-green)', color: 'var(--hud-green)', backgroundColor: 'var(--hud-panel2)' }}
                            title="Open & preview file"
                          >
                            <Eye className="w-3 h-3" /> Open
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={downloadingPath === entry.path}
                          onClick={() => void handleDownloadFile(entry)}
                          className="px-1.5 py-0.5 border flex items-center gap-1 cursor-pointer disabled:opacity-40"
                          style={{ borderColor: 'var(--hud-pri-dim)', color: 'var(--hud-pri)', backgroundColor: 'var(--hud-panel2)' }}
                          title="Download to your computer"
                        >
                          <Download className="w-3 h-3" />
                          {downloadingPath === entry.path ? '...' : 'Get'}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {activeTab === 'terminal' && (
        <div className="space-y-2.5 text-xs">
          <div className="flex flex-wrap gap-1">
            {['hostname', 'dir', 'ipconfig', 'tasklist /fo table | more'].map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => void runTerminalCommand(q)}
                disabled={termRunning}
                className="px-2 py-0.5 text-[9px] font-mono border cursor-pointer"
                style={{ borderColor: 'var(--hud-border-a)', backgroundColor: 'var(--hud-panel2)', color: 'var(--hud-pri)' }}
              >
                {q}
              </button>
            ))}
          </div>

          <div
            className="border p-2.5 h-56 overflow-y-auto hud-scroll font-mono text-[11px] space-y-2 hud-selectable"
            style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-bg)', color: 'var(--hud-white)' }}
          >
            {termLog.length === 0 ? (
              <div style={{ color: 'var(--hud-text-dim)' }}>
                Remote command console ready ({status?.hostname || 'SAM-CORP'}). Enter any cmd/PowerShell command below.
              </div>
            ) : (
              termLog.map((item, i) => (
                <div key={i} className="space-y-0.5">
                  <div style={{ color: 'var(--hud-pri)' }}>
                    {item.cwd}&gt; {item.cmd}
                  </div>
                  <pre className="whitespace-pre-wrap break-words text-[10px]" style={{ color: 'var(--hud-text-med)' }}>
                    {item.out}
                  </pre>
                </div>
              ))
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runTerminalCommand();
            }}
            className="flex gap-1.5"
          >
            <input
              value={termCmd}
              onChange={(e) => setTermCmd(e.target.value)}
              placeholder={termCwd ? `${termCwd}> command...` : 'Enter remote command...'}
              className="flex-1 px-2.5 py-1.5 text-xs font-mono border outline-none"
              style={{ backgroundColor: 'var(--hud-bg)', borderColor: 'var(--hud-border-a)', color: 'var(--hud-white)' }}
            />
            <button
              type="submit"
              disabled={termRunning}
              className="px-3 py-1.5 text-[10px] font-semibold uppercase border cursor-pointer disabled:opacity-50"
              style={{ backgroundColor: 'var(--hud-pri-gho)', borderColor: 'var(--hud-pri)', color: 'var(--hud-white)' }}
            >
              {termRunning ? 'Running...' : 'Run'}
            </button>
          </form>
        </div>
      )}
    </ModalShell>
  );
};

interface RemoteFileViewerOverlayProps {
  file: RemoteFilePreviewData;
  onClose: () => void;
}

export const RemoteFileViewerOverlay: React.FC<RemoteFileViewerOverlayProps> = ({ file, onClose }) => {
  const [launching, setLaunching] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [note, setNote] = useState<string | null>(file.launchResult?.note || null);

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const handleDownload = async () => {
    setDownloading(true);
    setNote(null);
    try {
      const res = await fetch(`/api/server/files/download?path=${encodeURIComponent(file.path)}`);
      if (!res.ok) throw new Error('Download failed.');
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
      setNote(`Downloaded ${file.name}`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  const handleLaunchOnPc = async () => {
    setLaunching(true);
    setNote(null);
    try {
      const res = await fetch('/api/server/files/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file.path }),
      });
      const data = (await res.json()) as { launched?: boolean; note?: string; error?: string };
      if (!res.ok) throw new Error(data.error || 'Launch failed');
      setNote(data.note || 'Launched on remote PC.');
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Host launch failed');
    } finally {
      setLaunching(false);
    }
  };

  return (
    <ModalShell title="REMOTE FILE VIEWER" code={file.kind.toUpperCase()} onClose={onClose}>
      <div className="space-y-3 text-xs">
        <div
          className="p-2.5 border space-y-1 font-mono"
          style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-bg)' }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold truncate" style={{ color: 'var(--hud-white)' }}>
              {file.name}
            </span>
            <span className="shrink-0 text-[10px]" style={{ color: 'var(--hud-pri)' }}>
              {formatBytes(file.size)}
            </span>
          </div>
          <div className="text-[10px] break-all" style={{ color: 'var(--hud-text-dim)' }}>
            {file.path}
          </div>
        </div>

        <div
          className="border p-2 max-h-80 overflow-auto hud-scroll hud-selectable"
          style={{ borderColor: 'var(--hud-border)', backgroundColor: 'var(--hud-bg)' }}
        >
          {file.kind === 'text' ? (
            file.textContent !== undefined ? (
              <pre className="whitespace-pre-wrap break-words font-mono text-[11px]" style={{ color: 'var(--hud-white)' }}>
                {file.textContent || '(empty file)'}
              </pre>
            ) : (
              <p className="p-3 text-center text-[11px]" style={{ color: 'var(--hud-text-dim)' }}>
                Text file is too large for inline preview ({formatBytes(file.size)}). Use Download below.
              </p>
            )
          ) : file.kind === 'image' ? (
            <img src={file.viewUrl} alt={file.name} className="max-h-72 mx-auto object-contain" />
          ) : file.kind === 'video' ? (
            <video src={file.viewUrl} controls autoPlay className="w-full max-h-72 bg-black" />
          ) : file.kind === 'audio' ? (
            <audio src={file.viewUrl} controls autoPlay className="w-full my-4" />
          ) : file.kind === 'pdf' ? (
            <iframe src={file.viewUrl} title={file.name} className="w-full h-72 border-0 bg-white" />
          ) : (
            <div className="p-4 text-center space-y-1.5">
              <p className="text-[11px]" style={{ color: 'var(--hud-text-med)' }}>
                Binary or desktop shortcut file ({file.name}).
              </p>
              <p className="text-[10px]" style={{ color: 'var(--hud-text-dim)' }}>
                You can download it to your device or trigger execution on the connected computer below.
              </p>
            </div>
          )}
        </div>

        {note && (
          <div className="px-2.5 py-1.5 border text-[11px] font-mono" style={{ borderColor: 'var(--hud-pri-dim)', color: 'var(--hud-pri)' }}>
            {note}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={launching}
            onClick={() => void handleLaunchOnPc()}
            className="px-3 py-1.5 text-[10px] font-semibold uppercase border flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            style={{ borderColor: 'var(--hud-acc)', color: 'var(--hud-acc)', backgroundColor: 'var(--hud-panel2)' }}
          >
            <Play className="w-3 h-3" /> {launching ? 'Launching...' : 'Open on PC'}
          </button>
          <button
            type="button"
            disabled={downloading}
            onClick={() => void handleDownload()}
            className="px-3 py-1.5 text-[10px] font-semibold uppercase border flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            style={{ borderColor: 'var(--hud-pri)', backgroundColor: 'var(--hud-pri-gho)', color: 'var(--hud-white)' }}
          >
            <Download className="w-3 h-3" /> {downloading ? 'Downloading...' : 'Download'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
};



