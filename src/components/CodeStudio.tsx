import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  Play,
  RefreshCw,
  Terminal,
  X,
} from 'lucide-react';

export interface CodeFileItem {
  path: string;
  language: string;
  content: string;
}

export interface CodeProjectState {
  id: string;
  title: string;
  projectName: string;
  entryFile: string;
  files: CodeFileItem[];
  status: 'stopped' | 'starting' | 'running' | 'error';
  port: number | null;
  logs: string[];
  error?: string;
  updatedAt: string;
}

interface CodeStudioProps {
  project: CodeProjectState | null;
  generating: boolean;
  running: boolean;
  error: string | null;
  previewStamp: number;
  onGenerate: (prompt: string) => void;
  onRunEdited: (project: CodeProjectState) => void;
  onUpdateFileContent: (filePath: string, nextContent: string) => void;
  onReloadPreview: () => void;
  onCloseToHud: () => void;
}

type StudioViewMode = 'split' | 'preview' | 'code' | 'logs';

const STARTER_PROMPTS = [
  {
    label: 'Maktab Portali (Node.js)',
    prompt: 'Maktab veb-sayti va boshqaruv panelini Node.js + Express yordamida full-stack app qilib yoz: dars jadvali, yangiliklar va oquvchilar royxati CRUD API bilan.',
  },
  {
    label: 'Vazifalar Tizimi (CRUD)',
    prompt: 'Node.js + Express yordamida full-stack vazifalar boshqaruvi (Task Manager) ilovasini yoz: loyiha, status, filter va JSON faylga saqlash API bilan.',
  },
  {
    label: 'Moliya Jurnali (API)',
    prompt: 'Node.js + Express yordamida kirim-chiqim hisoboti (Expense Tracker) full-stack veb-ilovasini yoz: statistika, kategoriya filteri va REST API bilan.',
  },
];

export const CodeStudio: React.FC<CodeStudioProps> = ({
  project,
  generating,
  running,
  error,
  previewStamp,
  onGenerate,
  onRunEdited,
  onUpdateFileContent,
  onReloadPreview,
  onCloseToHud,
}) => {
  const [viewMode, setViewMode] = useState<StudioViewMode>('split');
  const [activeFilePath, setActiveFilePath] = useState<string>('server.js');
  const [promptDraft, setPromptDraft] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!project || project.files.length === 0) return;
    if (!project.files.some((f) => f.path === activeFilePath)) {
      const preferred =
        project.files.find((f) => f.path === project.entryFile) ||
        project.files.find((f) => f.path.endsWith('.js')) ||
        project.files[0];
      setActiveFilePath(preferred.path);
    }
  }, [project, activeFilePath]);

  const activeFile = useMemo(() => {
    if (!project || project.files.length === 0) return null;
    return project.files.find((f) => f.path === activeFilePath) || project.files[0];
  }, [project, activeFilePath]);

  const lineCount = useMemo(() => {
    if (!activeFile) return 0;
    return activeFile.content.split('\n').length;
  }, [activeFile]);

  const handleCopy = async () => {
    if (!activeFile) return;
    try {
      await navigator.clipboard.writeText(activeFile.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Ignore clipboard permission errors
    }
  };

  const handleSubmitPrompt = (e: React.FormEvent) => {
    e.preventDefault();
    const text = promptDraft.trim();
    if (!text || generating) return;
    setPromptDraft('');
    onGenerate(text);
  };

  const statusLabel = generating
    ? 'Generating Node.js code...'
    : running
    ? 'Starting Node.js server...'
    : project?.status === 'running'
    ? `Running · Port ${project.port} · ${project.files.length} files`
    : project?.status === 'error'
    ? 'Server error'
    : project
    ? `Stopped · ${project.files.length} files`
    : 'Node.js Full-Stack';

  return (
    <div
      className="w-full h-full flex flex-col min-h-0"
      style={{ backgroundColor: 'var(--hud-bg)', color: 'var(--hud-text)' }}
    >
      {/* Top Studio Header */}
      <div
        className="px-3 py-2 border-b flex items-center justify-between gap-2 flex-wrap shrink-0"
        style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)' }}
      >
        <div className="min-w-0 flex items-center gap-2.5">
          <Code2 className="w-4 h-4 shrink-0" style={{ color: 'var(--hud-pri)' }} />
          <div className="min-w-0">
            <div className="text-xs font-semibold truncate" style={{ color: 'var(--hud-white)' }}>
              {project?.title || 'Node.js Code Studio'}
            </div>
            <div
              className="text-[10px] font-mono tabular-nums truncate"
              style={{
                color:
                  project?.status === 'running'
                    ? 'var(--hud-green)'
                    : project?.status === 'error'
                    ? 'var(--hud-red)'
                    : 'var(--hud-text-dim)',
              }}
            >
              {statusLabel}
            </div>
          </div>
        </div>

        {/* Segmented View Controls */}
        <div
          className="flex items-center gap-1 p-0.5 border shrink-0"
          style={{ backgroundColor: 'var(--hud-panel2)', borderColor: 'var(--hud-border)' }}
        >
          {(
            [
              { id: 'split', label: 'Split' },
              { id: 'preview', label: 'Result' },
              { id: 'code', label: 'Code' },
              { id: 'logs', label: 'Logs' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setViewMode(tab.id)}
              className="px-2.5 py-1 text-[10px] font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-colors"
              style={{
                backgroundColor: viewMode === tab.id ? 'var(--hud-pri-gho)' : 'transparent',
                color: viewMode === tab.id ? 'var(--hud-white)' : 'var(--hud-text-dim)',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Right Actions */}
        <div className="flex items-center gap-1.5 shrink-0">
          {project && (
            <>
              <button
                type="button"
                onClick={() => onRunEdited(project)}
                disabled={running || generating}
                className="px-2.5 py-1 text-[10px] font-semibold border flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
                style={{
                  backgroundColor: 'var(--hud-pri-gho)',
                  borderColor: 'var(--hud-pri)',
                  color: 'var(--hud-white)',
                }}
              >
                <Play className="w-3 h-3" /> {running ? 'Starting...' : 'Run'}
              </button>
              <a
                href="/api/code/download"
                download={`${project.projectName || 'jarvis-node-app'}.zip`}
                className="px-2.5 py-1 text-[10px] font-semibold border flex items-center gap-1 whitespace-nowrap shrink-0"
                style={{
                  backgroundColor: 'var(--hud-panel2)',
                  borderColor: 'var(--hud-border)',
                  color: 'var(--hud-text-med)',
                }}
                title="Download Node.js project ZIP"
              >
                <Download className="w-3 h-3" /> ZIP
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
        onSubmit={handleSubmitPrompt}
        className="px-3 py-2 border-b flex items-center gap-2 shrink-0"
        style={{ backgroundColor: 'var(--hud-panel2)', borderColor: 'var(--hud-border)' }}
      >
        <input
          value={promptDraft}
          onChange={(e) => setPromptDraft(e.target.value)}
          disabled={generating}
          placeholder={
            project
              ? 'Modify this Node.js app (e.g. Add search bar, CSV export, or dark mode)...'
              : 'Describe the full-stack Node.js app to build...'
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
          {generating ? 'Building...' : project ? 'Update App' : 'Build Node.js App'}
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

      {/* Main Studio Content */}
      {generating && !project ? (
        <div className="flex-1 min-h-0 p-6 flex flex-col justify-center items-center gap-4">
          <div className="w-full max-w-md space-y-3">
            <div className="text-xs font-mono text-center" style={{ color: 'var(--hud-pri)' }}>
              Writing Node.js server.js + REST API + frontend code...
            </div>
            <div className="h-3 w-full animate-pulse" style={{ backgroundColor: 'var(--hud-panel2)' }} />
            <div className="h-3 w-5/6 animate-pulse" style={{ backgroundColor: 'var(--hud-panel2)' }} />
            <div className="h-3 w-4/6 animate-pulse" style={{ backgroundColor: 'var(--hud-panel2)' }} />
          </div>
        </div>
      ) : !project ? (
        <div className="flex-1 min-h-0 p-6 flex flex-col items-center justify-center text-center gap-4 overflow-y-auto hud-scroll">
          <div className="max-w-md space-y-2">
            <h3 className="text-sm font-semibold" style={{ color: 'var(--hud-white)' }}>
              Node.js Full-Stack Code Studio
            </h3>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--hud-text-dim)' }}>
              Enter what you want to build above or ask J.A.R.V.I.S. in chat. Complete Node.js + Express backend and frontend code will appear here alongside the live running result.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2 max-w-lg">
            {STARTER_PROMPTS.map((item) => (
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
        <div className="flex-1 min-h-0 flex flex-col">
          {/* File Tabs Strip (shown in Code or Split view) */}
          {(viewMode === 'split' || viewMode === 'code') && (
            <div
              className="px-2.5 py-1.5 border-b flex items-center justify-between gap-2 shrink-0"
              style={{ backgroundColor: 'var(--hud-panel)', borderColor: 'var(--hud-border)' }}
            >
              <div className="flex items-center gap-1 overflow-x-auto hud-scroll min-w-0">
                {project.files.map((f) => {
                  const active = f.path === activeFile?.path;
                  return (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => setActiveFilePath(f.path)}
                      className="px-2.5 py-1 text-[11px] font-mono whitespace-nowrap shrink-0 border cursor-pointer"
                      style={{
                        backgroundColor: active ? 'var(--hud-pri-gho)' : 'var(--hud-panel2)',
                        borderColor: active ? 'var(--hud-pri)' : 'var(--hud-border)',
                        color: active ? 'var(--hud-white)' : 'var(--hud-text-dim)',
                      }}
                    >
                      {f.path}
                    </button>
                  );
                })}
              </div>
              {activeFile && (
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className="text-[10px] font-mono tabular-nums hidden sm:inline"
                    style={{ color: 'var(--hud-text-dim)' }}
                  >
                    {lineCount} lines
                  </span>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="px-2 py-1 text-[10px] font-mono border flex items-center gap-1 whitespace-nowrap shrink-0 cursor-pointer"
                    style={{
                      backgroundColor: 'var(--hud-panel2)',
                      borderColor: 'var(--hud-border)',
                      color: copied ? 'var(--hud-green)' : 'var(--hud-text-med)',
                    }}
                  >
                    {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Active Workspace Panes */}
          <div
            className={`flex-1 min-h-0 grid ${
              viewMode === 'split' ? 'grid-cols-1 xl:grid-cols-2' : 'grid-cols-1'
            }`}
          >
            {/* Code Pane */}
            {(viewMode === 'split' || viewMode === 'code') && activeFile && (
              <div
                className={`min-h-0 flex flex-col ${
                  viewMode === 'split' ? 'border-b xl:border-b-0 xl:border-r' : ''
                }`}
                style={{ borderColor: 'var(--hud-border)', backgroundColor: '#050a12' }}
              >
                <textarea
                  value={activeFile.content}
                  onChange={(e) => onUpdateFileContent(activeFile.path, e.target.value)}
                  spellCheck={false}
                  className="flex-1 w-full h-full p-3 font-mono text-xs leading-relaxed outline-none resize-none hud-scroll"
                  style={{
                    backgroundColor: '#050a12',
                    color: '#e2e8f0',
                    tabSize: 2,
                  }}
                />
              </div>
            )}

            {/* Live Result Preview Pane */}
            {(viewMode === 'split' || viewMode === 'preview') && (
              <div className="min-h-0 flex flex-col bg-slate-950">
                <div
                  className="px-2.5 py-1 border-b flex items-center justify-between gap-2 shrink-0"
                  style={{ backgroundColor: 'var(--hud-panel2)', borderColor: 'var(--hud-border)' }}
                >
                  <div className="flex items-center gap-1.5 text-[10px] font-mono truncate" style={{ color: 'var(--hud-text-med)' }}>
                    <Eye className="w-3 h-3 shrink-0" style={{ color: 'var(--hud-pri)' }} />
                    <span className="truncate">
                      {project.status === 'running'
                        ? `Live Node.js Result · http://localhost:${project.port}`
                        : 'Sandbox Output'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={onReloadPreview}
                      className="p-1 border cursor-pointer"
                      style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-text-med)' }}
                      title="Reload live result"
                    >
                      <RefreshCw className="w-3 h-3" />
                    </button>
                    {project.status === 'running' && (
                      <a
                        href="/api/code/preview/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1 border"
                        style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-pri)' }}
                        title="Open full preview in new tab"
                      >
                        <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </div>

                {generating ? (
                  <div className="flex-1 flex items-center justify-center text-xs font-mono" style={{ color: 'var(--hud-pri)' }}>
                    Rebuilding Node.js application...
                  </div>
                ) : project.status === 'running' ? (
                  <iframe
                    key={`${project.id}_${previewStamp}`}
                    src={`/api/code/preview/?v=${previewStamp}`}
                    title={project.title}
                    className="flex-1 w-full h-full border-0 bg-white"
                  />
                ) : (
                  <div className="flex-1 p-4 overflow-y-auto hud-scroll font-mono text-xs space-y-2" style={{ color: 'var(--hud-red)' }}>
                    <div className="font-semibold">Node.js server failed to start</div>
                    <pre className="whitespace-pre-wrap text-[11px] leading-relaxed" style={{ color: 'var(--hud-text)' }}>
                      {project.error || project.logs.join('\n') || 'Click Run to start the Node.js server.'}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* Server Logs Pane */}
            {viewMode === 'logs' && (
              <div
                className="min-h-0 flex flex-col p-3 overflow-y-auto hud-scroll font-mono text-xs"
                style={{ backgroundColor: '#050a12', color: '#cbd5e1' }}
              >
                <div className="flex items-center gap-2 pb-2 mb-2 border-b text-[11px]" style={{ borderColor: 'var(--hud-border)', color: 'var(--hud-pri)' }}>
                  <Terminal className="w-3.5 h-3.5" />
                  <span>Node.js Runtime Console</span>
                </div>
                {project.logs.length === 0 ? (
                  <div style={{ color: 'var(--hud-text-dim)' }}>No console output yet.</div>
                ) : (
                  <pre className="whitespace-pre-wrap leading-relaxed tabular-nums">
                    {project.logs.join('\n')}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
