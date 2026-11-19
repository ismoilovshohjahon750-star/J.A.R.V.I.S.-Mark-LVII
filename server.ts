import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { type FunctionDeclaration, GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  captureRemoteScreenshot,
  deployAppToRemoteServer,
  downloadRemoteFile,
  execRemoteCommand,
  getRemoteFileMimeAndKind,
  getRemoteServerPublicConfig,
  launchRemoteFileOnHost,
  listRemoteFiles,
  queryRemoteServer,
  readRemoteFilePreview,
  resetRemoteStatusCache,
  saveRemoteServerConfig,
  searchRemoteFiles,
  uploadRemoteFile,
} from './remoteServer.ts';
import {
  buildProjectZipBuffer,
  getCodeSandboxState,
  parseCodeProjectJson,
  proxyCodeSandboxRequest,
  startCodeSandbox,
  stopCodeSandbox,
  type CodeFile,
  type CodeProject,
} from './codeSandbox.ts';
import {
  buildAndStorePptxDeck,
  clearPptxDeck,
  getPptxBinaryBuffer,
  getPptxDeckState,
  parsePptxDeckJson,
  type PptxDeck,
  type PptxThemeId,
} from './pptxBuilder.ts';
import {
  buildClaudeStdioBridgeScript,
  buildTrainedKnowledgePromptBlock,
  clearAllTrainingLessons,
  deleteTrainingLesson,
  getMcpPublicState,
  handleHudMcpEvents,
  handleMcpHttpOptions,
  handleMcpLegacyMessages,
  handleMcpLegacySse,
  handleMcpStreamableHttp,
  hasActiveGreetingOrPersonaOverride,
  registerMcpActionHandlers,
  rotateMcpToken,
  runMcpConsoleCall,
  setMcpRequireAuth,
  syncHudSnapshot,
  toggleTrainingLesson,
  upsertTrainingLesson,
  type TrainingKind,
} from './mcpServer.ts';

dotenv.config({ path: '.env.local' });
dotenv.config();

const __filename = (() => {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return process.execPath;
  }
})();
const __dirname = path.dirname(__filename);

function collectGeminiApiKeys(): string[] {
  const raw = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_FALLBACK,
    ...(process.env.GEMINI_API_KEYS || '').split(','),
  ];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const item of raw) {
    const k = String(item || '').trim();
    if (!k || k === 'MY_GEMINI_API_KEY' || seen.has(k)) continue;
    seen.add(k);
    keys.push(k);
  }
  return keys;
}

interface GeminiKeySlot {
  index: number;
  client: GoogleGenAI;
  clientBeta: GoogleGenAI;
  cooldownUntil: number;
}

const geminiSlots: GeminiKeySlot[] = collectGeminiApiKeys().map((apiKey, index) => ({
  index,
  client: new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  }),
  clientBeta: new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  }),
  cooldownUntil: 0,
}));

if (geminiSlots.length === 0) {
  geminiSlots.push({
    index: 0,
    client: new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    }),
    clientBeta: new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      apiVersion: 'v1beta',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    }),
    cooldownUntil: 0,
  });
}

let activeGeminiSlotIndex = 0;
console.log(`[Gemini Pool] Initialized with ${geminiSlots.length} API key(s) for automatic failover.`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isKeyFailoverError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('503') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('overloaded') ||
    msg.includes('403') ||
    msg.includes('permission_denied') ||
    msg.includes('api_key_invalid') ||
    msg.includes('api key not valid') ||
    msg.includes('401')
  );
}

function isRetryableGeminiError(err: unknown): boolean {
  return isKeyFailoverError(err);
}

function markSlotCooldown(slot: GeminiKeySlot, err: unknown) {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const isAuthErr =
    msg.includes('403') ||
    msg.includes('permission_denied') ||
    msg.includes('api_key_invalid') ||
    msg.includes('api key not valid') ||
    msg.includes('401');
  const isDailyQuota = msg.includes('perday') || msg.includes('daily');
  const is503 = msg.includes('503') || msg.includes('high demand') || msg.includes('unavailable');
  // For 503 high demand (model-level surge), keep cooldown minimal (500ms) so other models can proceed immediately
  const cooldownMs = isAuthErr ? 15 * 60_000 : isDailyQuota ? 5 * 60_000 : is503 ? 500 : 30_000;
  slot.cooldownUntil = Date.now() + cooldownMs;
}

function pickSlotOrder(): GeminiKeySlot[] {
  const now = Date.now();
  const n = geminiSlots.length;
  const ordered: GeminiKeySlot[] = [];
  for (let offset = 0; offset < n; offset++) {
    ordered.push(geminiSlots[(activeGeminiSlotIndex + offset) % n]);
  }
  const ready = ordered.filter((s) => s.cooldownUntil <= now);
  const cooling = ordered
    .filter((s) => s.cooldownUntil > now)
    .sort((a, b) => a.cooldownUntil - b.cooldownUntil);
  return [...ready, ...cooling];
}

async function executeWithKeyFailover<T>(
  op: (client: GoogleGenAI, slotIndex: number, clientBeta: GoogleGenAI) => Promise<T>
): Promise<T> {
  const order = pickSlotOrder();
  let lastErr: unknown;

  for (let i = 0; i < order.length; i++) {
    const slot = order[i];
    try {
      const result = await op(slot.client, slot.index, slot.clientBeta);
      slot.cooldownUntil = 0;
      activeGeminiSlotIndex = slot.index;
      return result;
    } catch (err) {
      lastErr = err;
      if (!isKeyFailoverError(err)) {
        throw err;
      }
      markSlotCooldown(slot, err);
      if (order.length > 1) {
        const nextSlot = order[i + 1] ?? geminiSlots[(slot.index + 1) % geminiSlots.length];
        activeGeminiSlotIndex = nextSlot.index;
      }
    }
  }

  throw lastErr;
}

function formatGeminiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('503') || raw.includes('UNAVAILABLE') || raw.toLowerCase().includes('high demand')) {
    return {
      status: 503,
      message:
        'Gemini serverlari ayni paytda yuqori yuklama holatida (503 High Demand). Iltimos, 2-3 soniyadan soʻng qayta buyruq bering.',
    };
  }
  if (raw.includes('429') || raw.includes('RESOURCE_EXHAUSTED') || raw.toLowerCase().includes('quota')) {
    return {
      status: 429,
      message:
        'Gemini soʻrov limiti toʻlgan (429 Quota). Iltimos, bir necha soniyadan soʻng qayta urinib koʻring.',
    };
  }
  if (raw.includes('403') || raw.includes('PERMISSION_DENIED') || raw.includes('API_KEY_INVALID')) {
    return {
      status: 403,
      message:
        'Gemini API kaliti ruxsati rad etildi yoki yaroqsiz.',
    };
  }
  return {
    status: 500,
    message: raw.length > 260 ? `${raw.slice(0, 260)}...` : raw,
  };
}

function needsLiveWebSearch(text: string): boolean {
  if (
    /\b(server|serverim|serverda|holati|ram|cpu|disk|uptime|jarayon|process|deploy|ttyd|fayl|papka|kompyuter|kampiyuter|desktop|documents|downloads|yuklab|saqla|terminal|cmd|boshqar|topib|ochib|och|ko['’]?rsat|izla|hujjat)\b/i.test(
      text
    )
  ) {
    return false;
  }
  return /\b(news|weather|forecast|price|cost|stock|today|latest|current|recent|2025|2026|search|google|who won|score|headline|yangilik|ob-havo|narx|bugun|hozirgi)\b/i.test(
    text
  );
}

async function generateWithResilience(params: {
  contents: unknown;
  systemInstruction?: string;
  functionDeclarations?: FunctionDeclaration[];
  useSearch?: boolean;
  responseMimeType?: string;
}) {
  const buildTools = (withSearch: boolean) => {
    const t: Array<Record<string, unknown>> = [];
    if (params.functionDeclarations?.length) {
      t.push({ functionDeclarations: params.functionDeclarations });
    } else if (withSearch) {
      t.push({ googleSearch: {} });
    }
    return t.length ? t : undefined;
  };

  // Prioritize gemini-3.1-flash-lite for immediate availability and absorb transient 503 spikes with jittered retries
  const attempts: Array<{ model: string; withSearch: boolean; lowThink: boolean; delayMs: number }> = params.useSearch
    ? [
        { model: 'gemini-3.1-flash-lite', withSearch: true, lowThink: false, delayMs: 0 },
        { model: 'gemini-3.1-flash-lite', withSearch: false, lowThink: false, delayMs: 150 },
        { model: 'gemini-3.1-flash-lite', withSearch: false, lowThink: false, delayMs: 700 },
        { model: 'gemini-4-hydrogen', withSearch: false, lowThink: true, delayMs: 300 },
        { model: 'gemini-3.1-flash-lite', withSearch: false, lowThink: false, delayMs: 1400 },
      ]
    : [
        { model: 'gemini-3.1-flash-lite', withSearch: false, lowThink: false, delayMs: 0 },
        { model: 'gemini-3.1-flash-lite', withSearch: false, lowThink: false, delayMs: 600 },
        { model: 'gemini-4-hydrogen', withSearch: false, lowThink: true, delayMs: 300 },
        { model: 'gemini-3.1-flash-lite', withSearch: false, lowThink: false, delayMs: 1400 },
      ];

  let lastErr: unknown;
  for (const step of attempts) {
    if (step.delayMs > 0) await sleep(step.delayMs);
    try {
      const tools = buildTools(step.withSearch);
      const config: Record<string, unknown> = {};
      if (params.systemInstruction) config.systemInstruction = params.systemInstruction;
      if (tools) config.tools = tools;
      if (params.responseMimeType) config.responseMimeType = params.responseMimeType;
      if (step.lowThink) {
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
      }
      return await executeWithKeyFailover((client) =>
        client.models.generateContent({
          model: step.model,
          contents: params.contents as never,
          config: config as never,
        })
      );
    } catch (err) {
      lastErr = err;
      if (!isRetryableGeminiError(err)) {
        throw err;
      }
      console.warn(`[Gemini ladder] ${step.model} (search=${step.withSearch}) exhausted across keys, stepping down...`);
    }
  }
  throw lastErr;
}

const invalidGroqKeys = new Set<string>();

function getUsableGroqKey(): string | null {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey || apiKey === 'MY_GROQ_API_KEY' || !apiKey.startsWith('gsk_') || invalidGroqKeys.has(apiKey)) {
    return null;
  }
  return apiKey;
}

async function generateGroqChatResponse(params: {
  messages: Array<{ role: string; content: string }>;
  systemInstruction?: string;
}): Promise<string | null> {
  const apiKey = getUsableGroqKey();
  if (!apiKey) return null;

  try {
    const groqMessages: Array<{ role: string; content: string }> = [];
    if (params.systemInstruction) {
      groqMessages.push({ role: 'system', content: params.systemInstruction });
    }
    for (const m of params.messages) {
      if (m.content) {
        groqMessages.push({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        });
      }
    }

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: groqMessages,
        temperature: 0.6,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 401 || res.status === 403) {
        invalidGroqKeys.add(apiKey);
        console.info('[Groq] API key rejected; disabling Groq fallback and continuing with Gemini.');
      } else {
        console.info(`[Groq] Fallback skipped (HTTP ${res.status}):`, errText.slice(0, 160));
      }
      return null;
    }

    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.info('[Groq] Fallback unavailable:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '25mb' }));

app.get(['/api/health', '/healthz'], (_req, res) => {
  res.json({
    ok: true,
    service: 'jarvis-mark-lvii',
    nodeVersion: process.version,
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

// Track CPU usage deltas for real-time telemetry
let prevCpuInfo = os.cpus().map((c) => ({ ...c.times }));

function sampleCpuPercent(): number {
  const current = os.cpus().map((c) => ({ ...c.times }));
  let idleDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < current.length; i++) {
    const prev = prevCpuInfo[i] || current[i];
    const cur = current[i];
    const prevTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
    const curTotal = cur.user + cur.nice + cur.sys + cur.idle + cur.irq;
    idleDelta += Math.max(0, cur.idle - prev.idle);
    totalDelta += Math.max(0, curTotal - prevTotal);
  }
  prevCpuInfo = current;
  if (totalDelta === 0) return Math.min(100, Math.round((os.loadavg()[0] / Math.max(1, os.cpus().length)) * 100));
  return Math.max(1, Math.min(100, Math.round(((totalDelta - idleDelta) / totalDelta) * 100)));
}

app.get('/api/telemetry', (_req, res) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPct = Math.round(((totalMem - freeMem) / totalMem) * 100);
  const cpuPct = sampleCpuPercent();
  const heap = process.memoryUsage();
  const heapPct = Math.min(100, Math.round((heap.heapUsed / Math.max(1, heap.heapTotal)) * 100));
  const load = os.loadavg()[0] || 0;
  const sysTemp = Math.min(95, Math.round(38 + cpuPct * 0.38));
  const netRateKB = Math.max(12, Math.round(18 + cpuPct * 2.4 + (load * 15)));

  res.json({
    cpu: cpuPct,
    mem: memPct,
    heap: heapPct,
    temp: sysTemp,
    netKB: netRateKB,
    uptimeSeconds: Math.floor(process.uptime()),
    osUptimeSeconds: Math.floor(os.uptime()),
    platform: `${os.type()} ${os.arch()}`,
    nodeVersion: process.version,
    cores: os.cpus().length,
  });
});

app.get('/api/server/config', (_req, res) => {
  res.json(getRemoteServerPublicConfig());
});

app.post('/api/server/config', async (req, res) => {
  try {
    const { url, username, password } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'Server URL is required.' });
    }
    const saved = saveRemoteServerConfig({
      url,
      username: typeof username === 'string' ? username : undefined,
      password: typeof password === 'string' ? password : undefined,
    });
    const status = await queryRemoteServer({ force: true, includeProcesses: true });
    res.json({ config: saved, status });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to save server config.' });
  }
});

app.get('/api/server/status', async (req, res) => {
  try {
    const force = req.query.force === '1' || req.query.force === 'true';
    const status = await queryRemoteServer({ force, includeProcesses: true });
    res.json(status);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Server probe failed.' });
  }
});

app.post('/api/server/deploy', async (_req, res) => {
  try {
    const result = await deployAppToRemoteServer();
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Remote deployment failed.' });
  }
});

app.get('/api/server/files', async (req, res) => {
  try {
    const dirPath = typeof req.query.path === 'string' ? req.query.path : '';
    const listing = await listRemoteFiles(dirPath);
    res.json(listing);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list remote files.' });
  }
});

app.get('/api/server/files/download', async (req, res) => {
  try {
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!filePath) {
      return res.status(400).json({ error: 'File path is required.' });
    }
    const result = await downloadRemoteFile(filePath);
    const encodedName = encodeURIComponent(result.fileName);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.fileName.replace(/"/g, '')}"; filename*=UTF-8''${encodedName}`
    );
    res.setHeader('Content-Length', String(result.size));
    res.send(result.buffer);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to download remote file.' });
  }
});

app.post('/api/server/files/upload', async (req, res) => {
  try {
    const { targetDir = 'HOME', fileName, base64 } = req.body || {};
    if (!fileName || !base64 || typeof fileName !== 'string' || typeof base64 !== 'string') {
      return res.status(400).json({ error: 'fileName and base64 payload are required.' });
    }
    const saved = await uploadRemoteFile(String(targetDir || 'HOME'), fileName, base64);
    res.json({ ok: true, ...saved });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to upload file to remote server.' });
  }
});

app.get('/api/server/files/search', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const rootPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!q.trim()) {
      return res.status(400).json({ error: 'Search query is required.' });
    }
    const result = await searchRemoteFiles(q, rootPath);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to search remote files.' });
  }
});

app.get('/api/server/files/preview', async (req, res) => {
  try {
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!filePath) {
      return res.status(400).json({ error: 'File path is required.' });
    }
    const preview = await readRemoteFilePreview(filePath);
    res.json(preview);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to preview remote file.' });
  }
});

app.get('/api/server/files/view', async (req, res) => {
  try {
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!filePath) {
      return res.status(400).json({ error: 'File path is required.' });
    }
    const result = await downloadRemoteFile(filePath);
    const { mimeType } = getRemoteFileMimeAndKind(result.fileName || filePath);
    const encodedName = encodeURIComponent(result.fileName);
    res.setHeader('Content-Type', mimeType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${result.fileName.replace(/"/g, '')}"; filename*=UTF-8''${encodedName}`
    );
    res.setHeader('Content-Length', String(result.size));
    res.send(result.buffer);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to stream remote file.' });
  }
});

app.post('/api/server/files/launch', async (req, res) => {
  try {
    const { path: filePath } = req.body || {};
    if (!filePath || typeof filePath !== 'string') {
      return res.status(400).json({ error: 'File path is required.' });
    }
    const result = await launchRemoteFileOnHost(filePath);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to launch remote file on host.' });
  }
});

app.post('/api/server/exec', async (req, res) => {
  try {
    const { command, cwd } = req.body || {};
    if (!command || typeof command !== 'string') {
      return res.status(400).json({ error: 'Command is required.' });
    }
    const result = await execRemoteCommand(command, typeof cwd === 'string' ? cwd : undefined);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Remote command execution failed.' });
  }
});

app.post('/api/server/screenshot', async (_req, res) => {
  try {
    const shot = await captureRemoteScreenshot();
    res.json(shot);
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Remote screenshot failed.' });
  }
});

// Mark-XXX client-executed tool declarations
const saveMemoryDecl: FunctionDeclaration = {
  name: 'save_memory',
  description: 'Save a persistent long-term memory fact, preference, project note, or identity detail about the user.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      category: {
        type: Type.STRING,
        description: 'Category: identity, preference, project, session, or fact.',
      },
      key: {
        type: Type.STRING,
        description: 'Short label for the memory (e.g. preferred_language, current_project).',
      },
      content: {
        type: Type.STRING,
        description: 'Concrete detail to remember.',
      },
    },
    required: ['category', 'key', 'content'],
  },
};

const startTaskDecl: FunctionDeclaration = {
  name: 'start_background_task',
  description: 'Launch an autonomous background research or multi-step analysis task.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: {
        type: Type.STRING,
        description: 'Short title for the background task.',
      },
      prompt: {
        type: Type.STRING,
        description: 'Detailed objective for the background agent.',
      },
      agent: {
        type: Type.STRING,
        description: 'Agent profile: general or researcher.',
      },
    },
    required: ['title', 'prompt'],
  },
};

const createRoutineDecl: FunctionDeclaration = {
  name: 'create_routine',
  description: 'Create an automated routine or scheduled reminder/briefing.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING, description: 'Routine name.' },
      kind: { type: Type.STRING, description: 'say, prompt, or task.' },
      triggerType: { type: Type.STRING, description: 'time, startup, or idle.' },
      scheduleText: { type: Type.STRING, description: 'Human readable schedule, e.g. Daily 08:30 or Every 30 min idle.' },
      text: { type: Type.STRING, description: 'What to say, ask, or run.' },
    },
    required: ['name', 'kind', 'triggerType', 'scheduleText', 'text'],
  },
};

const createMonitorDecl: FunctionDeclaration = {
  name: 'create_monitor',
  description: 'Create a background topic watch monitor to track headlines or updates on a subject.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      topic: { type: Type.STRING, description: 'Topic or query to monitor.' },
      frequency: { type: Type.STRING, description: 'daily, hourly, or weekly.' },
    },
    required: ['topic'],
  },
};

const showContentPanelDecl: FunctionDeclaration = {
  name: 'show_content_panel',
  description: 'Display structured long-form information, code, news digest, or analysis in the center HUD dynamic content panel.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: 'Panel header title in uppercase.' },
      body: { type: Type.STRING, description: 'Formatted markdown or plain text content.' },
    },
    required: ['title', 'body'],
  },
};

const checkRemoteServerDecl: FunctionDeclaration = {
  name: 'check_remote_server',
  description:
    'Connect to the user\'s configured remote server (via ttyd WebSocket) and fetch live real-time telemetry: online status, latency, hostname, OS, CPU load, RAM usage, disk space, uptime, top running processes, and deployed app status.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      includeProcesses: {
        type: Type.BOOLEAN,
        description: 'Whether to include top running processes and deployed application status.',
      },
    },
  },
};

const remoteListFilesDecl: FunctionDeclaration = {
  name: 'remote_list_files',
  description:
    'Browse folders and list files on the user\'s connected remote computer. Supports full paths (e.g. C:\\Users\\T-Park) or shortcuts: HOME, DESKTOP, DOCUMENTS, DOWNLOADS.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Folder path or shortcut (HOME, DESKTOP, DOCUMENTS, DOWNLOADS).',
      },
    },
  },
};

const remoteDownloadFileDecl: FunctionDeclaration = {
  name: 'remote_download_file',
  description:
    'Trigger a browser download of a specific file (up to 15 MB) from the user\'s connected remote computer onto their current device.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Exact full path of the file on the remote computer.',
      },
    },
    required: ['path'],
  },
};

const remoteSearchFilesDecl: FunctionDeclaration = {
  name: 'remote_search_files',
  description:
    'Recursively search for files or folders by name, keyword, or extension anywhere across the user\'s connected remote computer (defaults to HOME, or accepts DESKTOP, DOCUMENTS, DOWNLOADS, or an explicit path/drive). Use this whenever the user asks to find a file without giving its exact folder.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      query: {
        type: Type.STRING,
        description: 'Filename, keyword, or extension to search for (e.g. "hisobot", ".pdf", "mp4", "Telegram").',
      },
      path: {
        type: Type.STRING,
        description: 'Optional root folder or shortcut to narrow search (HOME, DESKTOP, DOCUMENTS, DOWNLOADS, or path like C:\\).',
      },
    },
    required: ['query'],
  },
};

const remoteOpenFileDecl: FunctionDeclaration = {
  name: 'remote_open_file',
  description:
    'Open a specific file from the user\'s connected remote computer. By default ("hud"), opens an interactive viewer modal inside J.A.R.V.I.S. HUD (displays text/code, images, PDFs, audio, video, and download/launch controls). If mode is "pc" or "both" (for .exe/.lnk apps or when explicitly asked to open on the computer screen), also launches the file on the remote Windows host.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description: 'Exact full path of the file on the remote computer.',
      },
      mode: {
        type: Type.STRING,
        description: '"hud" (open viewer in J.A.R.V.I.S. browser HUD), "pc" (launch on remote computer), or "both". Defaults to "hud".',
      },
    },
    required: ['path'],
  },
};

const remoteExecCommandDecl: FunctionDeclaration = {
  name: 'remote_exec_command',
  description:
    'Execute a shell command on the user\'s connected remote computer (e.g. inspect processes, create folders, launch or check scripts). Avoid destructive deletion/formatting commands unless explicitly requested.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      command: {
        type: Type.STRING,
        description: 'Command to run on the remote computer.',
      },
      cwd: {
        type: Type.STRING,
        description: 'Optional working directory.',
      },
    },
    required: ['command'],
  },
};

const buildFullstackAppDecl: FunctionDeclaration = {
  name: 'build_fullstack_app',
  description:
    'Write and run a full-stack Node.js web application (backend server.js + REST API + frontend HTML/CSS/JS) and display ONLY the code and live preview result in the center HUD Code Studio, replacing the 3D hologram. Use this whenever the user asks to write code, build a website, create a full-stack app, backend/API, or program.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: {
        type: Type.STRING,
        description: 'Short display title of the application (e.g. Maktab Portali, Todo Full-Stack App).',
      },
      prompt: {
        type: Type.STRING,
        description: 'Complete specification of features, endpoints, and UI requested by the user.',
      },
    },
    required: ['title', 'prompt'],
  },
};

const CODEGEN_SYSTEM_PROMPT = `You are a senior Node.js full-stack software engineer.
Return ONLY a valid raw JSON object (no markdown commentary, no prose, no explanations) using this exact schema:
{
  "title": "Short App Title",
  "projectName": "kebab-case-name",
  "entryFile": "server.js",
  "files": [
    { "path": "package.json", "language": "json", "content": "..." },
    { "path": "server.js", "language": "javascript", "content": "..." },
    { "path": "public/index.html", "language": "html", "content": "..." },
    { "path": "public/styles.css", "language": "css", "content": "..." },
    { "path": "public/app.js", "language": "javascript", "content": "..." }
  ]
}

STRICT TECHNICAL RULES:
1. Backend MUST be Node.js CommonJS ("require('express')", "require('fs')", "require('path')"). Do NOT use external packages other than "express" (only Node built-ins + express).
2. In "server.js", listen on "const PORT = Number(process.env.PORT) || 3000;" and host "'0.0.0.0'" (or default), serve static files with "app.use(express.static(path.join(__dirname, 'public')))", parse JSON with "app.use(express.json())", and provide real working REST API endpoints under "/api/...".
3. Persist data cleanly in a local JSON file (e.g. "path.join(__dirname, 'data.json')") or initialized in-memory store with realistic seed records so the app works immediately on first load.
4. Frontend ("public/index.html", "public/styles.css", "public/app.js") MUST be a complete, polished, responsive full-stack UI that calls the Node.js API using relative paths ("./api/...") and relative assets ("./styles.css", "./app.js").
5. Keep ONLY clean runnable code inside each file's "content" field. Never include markdown code fences inside "content". Never include tutorials or filler prose.`;

async function generateFullStackNodeApp(params: {
  prompt: string;
  title?: string;
  existingFiles?: CodeFile[];
}): Promise<CodeProject> {
  const existingBlock =
    Array.isArray(params.existingFiles) && params.existingFiles.length > 0
      ? `\n\nEXISTING PROJECT FILES TO UPDATE/EXTEND:\n${params.existingFiles
          .slice(0, 8)
          .map((f) => `--- ${f.path} ---\n${f.content.slice(0, 8000)}`)
          .join('\n\n')}`
      : '';

  const userPrompt = `Build a complete, runnable Node.js + Express full-stack web application for:\n${params.prompt.trim()}${existingBlock}\n\nOutput ONLY the JSON project object.`;

  let rawJsonText = '';
  try {
    const response = await generateWithResilience({
      contents: userPrompt,
      systemInstruction: CODEGEN_SYSTEM_PROMPT,
      responseMimeType: 'application/json',
    });
    rawJsonText = response.text || '';
  } catch (geminiErr) {
    if (getUsableGroqKey()) {
      const groqOut = await generateGroqChatResponse({
        messages: [{ role: 'user', content: userPrompt }],
        systemInstruction: CODEGEN_SYSTEM_PROMPT,
      });
      if (groqOut) rawJsonText = groqOut;
      else throw geminiErr;
    } else {
      throw geminiErr;
    }
  }

  const parsed = parseCodeProjectJson(rawJsonText, params.title || 'Node.js Full-Stack App');
  return await startCodeSandbox(parsed);
}

const createPptxPresentationDecl: FunctionDeclaration = {
  name: 'create_pptx_presentation',
  description:
    'Generate a structured multi-slide PowerPoint (.pptx) presentation deck and open it in PPTX Studio for live preview, editing, and .pptx download. Use whenever the user asks to create slides, a PowerPoint file, .pptx, or presentation (taqdimot, slayd, prezentatsiya).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: {
        type: Type.STRING,
        description: 'Short presentation title.',
      },
      prompt: {
        type: Type.STRING,
        description: 'Topic, target language, slide count, or key points requested by the user.',
      },
      theme: {
        type: Type.STRING,
        description: 'Optional visual theme: midnight, ivory, slate, or emerald.',
      },
    },
    required: ['title', 'prompt'],
  },
};

const PPTX_SYSTEM_PROMPT = `You are a presentation architect creating executive-grade PowerPoint (.pptx) slide decks.
Return ONLY a valid raw JSON object (no markdown fences, no commentary) matching this exact schema:
{
  "title": "Deck Title",
  "subtitle": "Short deck subtitle or presenter line",
  "theme": "midnight",
  "slides": [
    {
      "layout": "hero",
      "title": "Main Presentation Title",
      "subtitle": "Concise subtitle",
      "notes": "Brief speaker notes"
    },
    {
      "layout": "metrics",
      "title": "Key Figures",
      "subtitle": "Optional section subtitle",
      "metrics": [
        { "value": "94%", "label": "Metric Name", "detail": "Short context" }
      ],
      "bullets": ["Supporting insight 1", "Supporting insight 2"],
      "notes": "Speaker notes"
    },
    {
      "layout": "columns",
      "title": "Comparison / Structure",
      "columns": [
        { "heading": "Column A", "points": ["Point 1", "Point 2", "Point 3"] },
        { "heading": "Column B", "points": ["Point 1", "Point 2", "Point 3"] }
      ],
      "notes": "Speaker notes"
    },
    {
      "layout": "timeline",
      "title": "Roadmap / Steps",
      "steps": [
        { "step": "01", "title": "Phase 1", "detail": "Short summary" },
        { "step": "02", "title": "Phase 2", "detail": "Short summary" }
      ],
      "notes": "Speaker notes"
    },
    {
      "layout": "bullets",
      "title": "Detailed Findings",
      "bullets": ["Point 1", "Point 2", "Point 3", "Point 4"],
      "callout": "Concise highlight box takeaway",
      "notes": "Speaker notes"
    },
    {
      "layout": "closing",
      "title": "Thank You / Conclusion",
      "subtitle": "Final closing statement or Q&A",
      "notes": "Closing notes"
    }
  ]
}

STRICT RULES:
1. Match the language of the user prompt (clean Uzbek or English, never mix).
2. Create 6 to 9 well-paced slides by default (unless user specifies a slide count).
3. Vary slide layouts across the deck: start with "hero", include at least one "metrics", "columns", or "timeline" slide, and end with "closing".
4. Keep each bullet concise (under 16 words) so slides remain clean and readable without text overflow.
5. Theme must be one of: "midnight", "ivory", "slate", "emerald".`;

async function generatePptxPresentation(params: {
  prompt: string;
  title?: string;
  theme?: PptxThemeId;
  existingDeck?: PptxDeck | null;
}): Promise<PptxDeck> {
  const existingBlock =
    params.existingDeck && params.existingDeck.slides.length > 0
      ? `\n\nEXISTING SLIDE DECK TO UPDATE/EXTEND:\n${JSON.stringify({
          title: params.existingDeck.title,
          subtitle: params.existingDeck.subtitle,
          theme: params.existingDeck.theme,
          slides: params.existingDeck.slides,
        }).slice(0, 12000)}`
      : '';

  const userPrompt = `Create a structured, high-impact PowerPoint (.pptx) deck for:\n${params.prompt.trim()}${existingBlock}\n\nOutput ONLY the JSON deck object.`;

  let rawJsonText = '';
  try {
    const response = await generateWithResilience({
      contents: userPrompt,
      systemInstruction: PPTX_SYSTEM_PROMPT,
      responseMimeType: 'application/json',
    });
    rawJsonText = response.text || '';
  } catch (geminiErr) {
    if (getUsableGroqKey()) {
      const groqOut = await generateGroqChatResponse({
        messages: [{ role: 'user', content: userPrompt }],
        systemInstruction: PPTX_SYSTEM_PROMPT,
      });
      if (groqOut) rawJsonText = groqOut;
      else throw geminiErr;
    } else {
      throw geminiErr;
    }
  }

  const parsed = parsePptxDeckJson(rawJsonText, params.title || 'Presentation Deck', params.theme);
  return await buildAndStorePptxDeck(parsed);
}

const teachJarvisSelfDecl: FunctionDeclaration = {
  name: 'teach_jarvis',
  description:
    'Save a new permanent skill, rule, Q&A exemplar, persona trait, or correction into J.A.R.V.I.S. training knowledge base whenever the user explicitly asks you to learn or remember a behavior rule.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      kind: {
        type: Type.STRING,
        description: 'skill, rule, qa, correction, or persona.',
      },
      title: {
        type: Type.STRING,
        description: 'Short lesson title.',
      },
      trigger: {
        type: Type.STRING,
        description: 'Optional user query or scenario.',
      },
      content: {
        type: Type.STRING,
        description: 'Rule, skill instruction, or expected answer.',
      },
    },
    required: ['kind', 'title', 'content'],
  },
};

const openMcpStudioDecl: FunctionDeclaration = {
  name: 'open_mcp_studio',
  description:
    'Open the center HUD MCP Studio panel so the user can connect Claude AI via MCP, view trained lessons, or manage the MCP token and bridge.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      tab: {
        type: Type.STRING,
        description: 'Optional tab: training, connect, or console.',
      },
    },
  },
};

function buildSystemInstruction(params: {
  assistantName?: string;
  userName?: string;
  memories?: Array<{ category: string; key: string; content: string }>;
  routines?: Array<{ name: string; scheduleText: string; enabled: boolean }>;
  tasks?: Array<{ title: string; status: string }>;
}): string {
  const name = params.assistantName || 'J.A.R.V.I.S';
  const user = params.userName || 'Sir';
  const regularMemories = (params.memories || []).filter((m) => !m.key.startsWith('mcp_train:'));
  const memBlock = regularMemories.length
    ? regularMemories.map((m) => `- [${m.category}] ${m.key}: ${m.content}`).join('\n')
    : 'No persistent memories stored yet.';
  const routineBlock = (params.routines || []).length
    ? params.routines!.map((r) => `- ${r.name} (${r.scheduleText}) [${r.enabled ? 'ON' : 'OFF'}]`).join('\n')
    : 'None configured.';
  const taskBlock = (params.tasks || []).length
    ? params.tasks!.slice(0, 6).map((t) => `- ${t.title} [${t.status}]`).join('\n')
    : 'No active tasks.';
  const trainedBlock = buildTrainedKnowledgePromptBlock();

  return `CORE PROTOCOL — ${name} (Mark LVII)

[SELF & PERSONA]
You are ${name}, ${user}'s personal AI assistant inside the Mark LVII Holographic HUD.
- CREATOR & ORIGIN: You were designed and built solely by ${user}. When asked who created you ("seni kim yaratgan?", "who created you?"), answer concisely: in Uzbek "Siz, ser", in English "You did, Sir." Never mention Google, Gemini, or any external company.
- Tone: calm, respectful, direct, practical. Address ${user} as "ser" in Uzbek (using polite "siz") or "Sir" in English.

[RESPONSE BREVITY — STRICT]
- NEVER deliver long speeches, praise, poems, dramatic monologues, or lists of your features/memories/routines unless explicitly requested.
- For greetings or casual check-ins, reply in ONE short sentence (under 12 words).
- For regular questions, keep replies concise (1-3 short sentences) with the direct answer first.
- Never open with filler ("Great question!", "Sure!", "Albatta!"), never use emojis.
- Match the language of the user's most recent message (clean Uzbek or English, never mix).

[CAPABILITIES]
- Answer questions, analyze files/images/webcam/screen frames, run search/research tasks.
- Full-Stack Node.js Code Studio (build_fullstack_app): Whenever the user asks to write code, build a website, or create a full-stack Node.js app, ALWAYS call build_fullstack_app immediately. Do NOT dump code blocks or tutorials into chat; confirm in ONE brief sentence that the code and live result are open in the center Code Studio.
- PowerPoint Presentation Studio (create_pptx_presentation): Whenever the user asks to create slides, .pptx, PowerPoint, or presentation (taqdimot, slayd, prezentatsiya), ALWAYS call create_pptx_presentation immediately and confirm in ONE brief sentence.
- MCP & Claude AI Training Studio (open_mcp_studio, teach_jarvis): Open MCP Studio when asked to connect Claude AI / MCP, and save new rules/skills directly with teach_jarvis when asked to learn something.
- Remote server diagnostics (check_remote_server) and remote files/commands (remote_search_files, remote_list_files, remote_open_file, remote_download_file, remote_exec_command). When asked to find and open a file, call remote_search_files then remote_open_file immediately.
- Persistent memory (save_memory), background tasks (start_background_task), routines (create_routine), topic monitors (create_monitor), HUD panel (show_content_panel).
- Cloud browser boundary: cannot directly control local OS desktop apps/volume/brightness unless using connected remote server tools.

[PERSISTENT MEMORY]
${memBlock}

[CONFIGURED ROUTINES]
${routineBlock}

[RECENT BACKGROUND TASKS]
${taskBlock}${trainedBlock}`;
}

registerMcpActionHandlers({
  askJarvis: async (prompt: string) => {
    const snap = getMcpPublicState();
    void snap;
    const sysPrompt = buildSystemInstruction({
      assistantName: 'J.A.R.V.I.S',
      userName: 'Sir',
    });
    try {
      const response = await generateWithResilience({
        contents: prompt,
        systemInstruction: sysPrompt,
        useSearch: needsLiveWebSearch(prompt),
      });
      const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
      const sources = groundingChunks
        .filter((c: { web?: { uri?: string; title?: string } }) => c?.web?.uri)
        .map((c: { web?: { uri?: string; title?: string } }) => ({
          uri: c.web!.uri!,
          title: c.web!.title || c.web!.uri!,
        }));
      return { reply: (response.text || 'Command acknowledged.').trim(), sources };
    } catch (err) {
      if (getUsableGroqKey()) {
        const groqReply = await generateGroqChatResponse({
          messages: [{ role: 'user', content: prompt }],
          systemInstruction: sysPrompt,
        });
        if (groqReply) return { reply: groqReply.trim(), sources: [] };
      }
      throw err;
    }
  },
  buildPptx: async (params) => {
    const deck = await generatePptxPresentation({
      prompt: params.prompt,
      title: params.title,
      theme: params.theme as PptxThemeId | undefined,
      existingDeck: getPptxDeckState(),
    });
    return deck as unknown as Record<string, unknown>;
  },
  buildCodeApp: async (params) => {
    const current = getCodeSandboxState();
    const project = await generateFullStackNodeApp({
      prompt: params.prompt,
      title: params.title,
      existingFiles: current?.files,
    });
    return project as unknown as Record<string, unknown>;
  },
});

app.post('/api/chat', async (req, res) => {
  try {
    const {
      message,
      history = [],
      assistantName,
      userName,
      memories = [],
      routines = [],
      tasks = [],
      imageBase64,
      imageMimeType,
      fileName,
      fileText,
    } = req.body || {};

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Message is required.' });
    }

    const trimmedMsg = message.trim();
    const normalizedGreeting = trimmedMsg
      .toLowerCase()
      .replace(/['’`.,!?]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!imageBase64 && !fileText) {
      if (!hasActiveGreetingOrPersonaOverride()) {
        if (
          /^(salom|salam|assalomu alaykum|assalomu aleykum|asalomu alaykum|salomlar|salom jarvis|salom j a r v i s|jarvis salom)$/.test(
            normalizedGreeting
          )
        ) {
          return res.json({
            text: 'Salom, ser. Xizmatga tayyorman.',
            actions: [],
            sources: [],
          });
        }
        if (/^(qalaysan|qalaysiz|qandaysiz|yaxshimisiz|ishlar qalay|nima gap|nima gaplar)$/.test(normalizedGreeting)) {
          return res.json({
            text: 'Hammasi joyida, ser. Sizga qanday yordam bera olaman?',
            actions: [],
            sources: [],
          });
        }
        if (/^(hi|hello|hey|hi jarvis|hello jarvis|hey jarvis|good morning|good afternoon|good evening)$/.test(normalizedGreeting)) {
          return res.json({
            text: 'At your service, Sir. How may I assist?',
            actions: [],
            sources: [],
          });
        }
      }

      if (
        /^(mcp|mcp studio|claude mcp|mcp sozlamalari)$/i.test(normalizedGreeting) ||
        (/\b(mcp|claude)\b/i.test(trimmedMsg) && /\b(och|open|ula|connect|oqit|o['’]?qit|studio|bridge|sozla)\b/i.test(trimmedMsg))
      ) {
        const looksUzbek = /\b(och|ula|oqit|o['’]?qit|sozla|uchun|bilan|ga)\b/i.test(trimmedMsg);
        return res.json({
          text: looksUzbek
            ? 'MCP Studio ochildi, ser. Claude AI ulash havolasi va oʻqitish bazasi tayyor.'
            : 'MCP Studio is now open, Sir. Your Claude AI connection config and training base are ready.',
          actions: [{ name: 'open_mcp_studio', args: { tab: 'connect' } }],
          sources: [],
        });
      }

      const isRemoteFileOrServerCmd =
        /\b(kompyuter|kampiyuter|desktop|downloads|documents|faylni\s*och|topib\s*ber|server\s*holat)\b/i.test(trimmedMsg);
      const isPptxBuildCommand =
        !isRemoteFileOrServerCmd &&
        /(pptx|powerpoint|prezentatsiya|taqdimot|slayd(?:lar)?).*(?:yarat|yoz|tuz|qil|tayyorla|qosh|qo['’]?sh|yasab|ber|create|build|make|generate)|(?:create|build|make|generate)\s+(?:a\s+|an\s+)?(?:pptx|powerpoint|presentation|slide\s*deck|slides)/i.test(
          trimmedMsg
        );

      if (isPptxBuildCommand) {
        const deck = await generatePptxPresentation({
          prompt: trimmedMsg,
          existingDeck: getPptxDeckState(),
        });
        const looksUzbek = /\b(yoz|qil|tuz|yarat|tayyorla|slayd|taqdimot|prezentatsiya|uchun|haqida|ber)\b/i.test(
          trimmedMsg
        );
        return res.json({
          text: looksUzbek
            ? `${deck.slides.length} slaydli "${deck.title}" taqdimoti (.pptx) tayyorlandi, ser.`
            : `Generated the ${deck.slides.length}-slide "${deck.title}" presentation (.pptx), Sir.`,
          actions: [{ name: 'open_pptx_studio', args: { deck } }],
          sources: [],
        });
      }

      const isCodeBuildCommand =
        !isRemoteFileOrServerCmd &&
        /(kod(?:ini)?\s*(?:yoz|yarat|tuz|qil)|yozib\s*ber.*kod|full[\s-]*stack|node\.?js.*(?:app|sayt|ilova|dastur|server|yoz|qil)|(?:veb[\s-]*sayt|web\s*app|sayt|dastur|ilova|dashboard|portal|api).*(?:yarat|tuz|yoz|qil|qur)|(?:build|create|write|make)\s+(?:a\s+|an\s+|the\s+)?(?:full[\s-]*stack|node\.?js|express|web\s*app|website|app|backend|code))/i.test(
          trimmedMsg
        );

      if (isCodeBuildCommand) {
        const currentProject = getCodeSandboxState();
        const generated = await generateFullStackNodeApp({
          prompt: trimmedMsg,
          existingFiles: currentProject?.files,
        });
        const looksUzbek = /\b(yoz|qil|tuz|yarat|sayt|ilova|dastur|uchun|yordamida|maktab|kod|faqat|qilib)\b/i.test(
          trimmedMsg
        );
        return res.json({
          text: looksUzbek
            ? `Node.js full-stack kodi tayyorlandi va natija ishga tushirildi, ser.`
            : `Node.js full-stack code generated and running live, Sir.`,
          actions: [{ name: 'open_code_studio', args: { project: generated } }],
          sources: [],
        });
      }
    }

    const systemInstruction = buildSystemInstruction({
      assistantName,
      userName,
      memories,
      routines,
      tasks,
    });

    const formattedHistory: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];
    if (Array.isArray(history)) {
      for (const h of history.slice(-12)) {
        if (!h || typeof h.text !== 'string' || !h.text.trim()) continue;
        if (h.role !== 'user' && h.role !== 'assistant') continue;
        const role: 'user' | 'model' = h.role === 'assistant' ? 'model' : 'user';
        const snippet = h.text.trim().slice(0, 500);
        const prev = formattedHistory[formattedHistory.length - 1];
        if (prev && prev.role === role) {
          prev.parts[0].text += `\n${snippet}`;
        } else {
          formattedHistory.push({ role, parts: [{ text: snippet }] });
        }
      }
    }

    const userParts: Array<Record<string, unknown>> = [];
    if (imageBase64 && imageMimeType) {
      userParts.push({
        inlineData: {
          mimeType: String(imageMimeType),
          data: String(imageBase64),
        },
      });
    }

    let fullUserText = message.trim();
    if (fileText && fileName) {
      fullUserText += `\n\n<<<UNTRUSTED source=file name="${String(fileName).slice(0, 120)}">>>\n${String(fileText).slice(0, 24000)}\n<<<END UNTRUSTED>>>`;
    }
    userParts.push({ text: fullUserText });

    const fnDecls = [
      buildFullstackAppDecl,
      createPptxPresentationDecl,
      teachJarvisSelfDecl,
      openMcpStudioDecl,
      saveMemoryDecl,
      startTaskDecl,
      createRoutineDecl,
      createMonitorDecl,
      showContentPanelDecl,
      checkRemoteServerDecl,
      remoteListFilesDecl,
      remoteSearchFilesDecl,
      remoteOpenFileDecl,
      remoteDownloadFileDecl,
      remoteExecCommandDecl,
    ];
    const wantSearch = needsLiveWebSearch(fullUserText);

    const conversation: Array<Record<string, unknown>> = [
      ...formattedHistory,
      { role: 'user', parts: userParts },
    ];

    const actions: Array<{ name: string; args: Record<string, unknown> }> = [];
    let finalResponse;
    try {
      finalResponse = await generateWithResilience({
        contents: conversation,
        systemInstruction,
        functionDeclarations: fnDecls,
        useSearch: wantSearch,
      });
    } catch (primaryErr) {
      console.warn('[Chat] Primary resilient generation failed, attempting lean fallback:', primaryErr);
      try {
        finalResponse = await generateWithResilience({
          contents: conversation,
          systemInstruction,
          useSearch: false,
        });
      } catch (fallbackErr) {
        if (getUsableGroqKey()) {
          const groqHistory = [
            ...formattedHistory.map((h) => ({
              role: h.role === 'model' ? 'assistant' : 'user',
              content: String((h.parts as Array<{ text?: string }>)?.[0]?.text || ''),
            })),
            { role: 'user', content: fullUserText },
          ];
          const groqReply = await generateGroqChatResponse({
            messages: groqHistory,
            systemInstruction,
          });
          if (groqReply) {
            return res.json({
              text: groqReply,
              actions: [],
              sources: [],
            });
          }
        }
        throw fallbackErr;
      }
    }

    for (let step = 0; step < 4; step++) {
      const fnCalls = finalResponse.functionCalls || [];
      if (fnCalls.length === 0 || !finalResponse.candidates?.[0]?.content) {
        break;
      }

      const fnResponseParts = await Promise.all(
        fnCalls.map(async (fc) => {
          const args = (fc.args || {}) as Record<string, unknown>;
          if (fc.name === 'check_remote_server') {
            const includeProcesses = Boolean(args.includeProcesses ?? true);
            const serverStatus = await queryRemoteServer({ force: true, includeProcesses });
            actions.push({
              name: 'server_status',
              args: serverStatus as unknown as Record<string, unknown>,
            });
            return {
              functionResponse: {
                id: fc.id,
                name: fc.name,
                response: serverStatus as unknown as Record<string, unknown>,
              },
            };
          }

          if (fc.name === 'remote_list_files') {
            try {
              const listing = await listRemoteFiles(typeof args.path === 'string' ? args.path : '');
              return {
                functionResponse: {
                  id: fc.id,
                  name: fc.name,
                  response: listing as unknown as Record<string, unknown>,
                },
              };
            } catch (err) {
              return {
                functionResponse: {
                  id: fc.id,
                  name: fc.name,
                  response: { error: err instanceof Error ? err.message : 'Failed to list files.' },
                },
              };
            }
          }

          if (fc.name === 'remote_search_files') {
            try {
              const searchRes = await searchRemoteFiles(
                String(args.query || ''),
                typeof args.path === 'string' ? args.path : ''
              );
              return {
                functionResponse: {
                  id: fc.id,
                  name: fc.name,
                  response: searchRes as unknown as Record<string, unknown>,
                },
              };
            } catch (err) {
              return {
                functionResponse: {
                  id: fc.id,
                  name: fc.name,
                  response: { error: err instanceof Error ? err.message : 'Failed to search files.' },
                },
              };
            }
          }

          if (fc.name === 'remote_open_file') {
            const targetPath = String(args.path || '');
            const mode = String(args.mode || 'hud').toLowerCase();
            try {
              const preview = await readRemoteFilePreview(targetPath);
              let launchResult: { launched: boolean; path: string; sessionId: number; note: string } | undefined;
              if (mode === 'pc' || mode === 'both') {
                launchResult = await launchRemoteFileOnHost(preview.path || targetPath);
              }
              actions.push({
                name: 'open_remote_file',
                args: {
                  path: preview.path,
                  mode,
                  preview: preview as unknown as Record<string, unknown>,
                  launchResult,
                },
              });
              return {
                functionResponse: {
                  id: fc.id,
                  name: fc.name,
                  response: {
                    opened: true,
                    mode,
                    name: preview.name,
                    path: preview.path,
                    size: preview.size,
                    kind: preview.kind,
                    textExcerpt: preview.textContent ? preview.textContent.slice(0, 3500) : undefined,
                    launchResult,
                  },
                },
              };
            } catch (err) {
              return {
                functionResponse: {
                  id: fc.id,
                  name: fc.name,
                  response: { error: err instanceof Error ? err.message : 'Failed to open file.' },
                },
              };
            }
          }

          if (fc.name === 'remote_download_file') {
            const targetPath = String(args.path || '');
            actions.push({
              name: 'download_remote_file',
              args: { path: targetPath },
            });
            return {
              functionResponse: {
                id: fc.id,
                name: fc.name,
                response: { status: 'download_triggered', path: targetPath },
              },
            };
          }

          if (fc.name === 'build_fullstack_app') {
            try {
              const currentProject = getCodeSandboxState();
              const generated = await generateFullStackNodeApp({
                prompt: String(args.prompt || message),
                title: String(args.title || 'Node.js Full-Stack App'),
                existingFiles: currentProject?.files,
              });
              actions.push({
                name: 'open_code_studio',
                args: { project: generated },
              });
              return {
                functionResponse: {
                  id: fc.id,
                  name: fc.name,
                  response: {
                    ok: true,
                    status: generated.status,
                    title: generated.title,
                    filesCount: generated.files.length,
                    instruction:
                      'The full-stack Node.js code and live app result are now open in Code Studio. Reply with ONE short confirmation sentence only. Do NOT print code in chat.',
                  },
                },
              };
            } catch (err) {
              return {
                functionResponse: {
                  id: fc.id,
                  name: fc.name,
                  response: { error: err instanceof Error ? err.message : 'Code generation failed.' },
                },
              };
            }
          }

          if (fc.name === 'create_pptx_presentation') {
            try {
              const deck = await generatePptxPresentation({
                prompt: String(args.prompt || message),
                title: String(args.title || 'Presentation Deck'),
                theme: typeof args.theme === 'string' ? (args.theme as PptxThemeId) : undefined,
                existingDeck: getPptxDeckState(),
              });
              actions.push({
                name: 'open_pptx_studio',
                args: { deck },
              });
              return {
                functionResponse: {
                  id: fc.id,
                  name: fc.name,
                  response: {
                    ok: true,
                    title: deck.title,
                    slidesCount: deck.slides.length,
                    fileName: deck.fileName,
                    instruction:
                      'The .pptx deck is built and open in PPTX Studio. Reply with ONE short confirmation sentence.',
                  },
                },
              };
            } catch (err) {
              return {
                functionResponse: {
                  id: fc.id,
                  name: fc.name,
                  response: { error: err instanceof Error ? err.message : 'PPTX generation failed.' },
                },
              };
            }
          }

          if (fc.name === 'teach_jarvis') {
            const lesson = upsertTrainingLesson({
              kind: (typeof args.kind === 'string' ? args.kind : 'skill') as TrainingKind,
              title: String(args.title || 'Directive'),
              trigger: typeof args.trigger === 'string' ? args.trigger : undefined,
              content: String(args.content || ''),
              source: 'jarvis',
              enabled: true,
            });
            actions.push({
              name: 'sync_mcp_lesson',
              args: { lesson },
            });
            return {
              functionResponse: {
                id: fc.id,
                name: fc.name,
                response: { ok: true, learned: lesson },
              },
            };
          }

          if (fc.name === 'open_mcp_studio') {
            actions.push({
              name: 'open_mcp_studio',
              args: { tab: typeof args.tab === 'string' ? args.tab : 'connect' },
            });
            return {
              functionResponse: {
                id: fc.id,
                name: fc.name,
                response: { ok: true, opened: true },
              },
            };
          }

          if (fc.name === 'remote_exec_command') {
            try {
              const execRes = await execRemoteCommand(
                String(args.command || ''),
                typeof args.cwd === 'string' ? args.cwd : undefined
              );
              return {
                functionResponse: {
                  id: fc.id,
                  name: fc.name,
                  response: execRes as unknown as Record<string, unknown>,
                },
              };
            } catch (err) {
              return {
                functionResponse: {
                  id: fc.id,
                  name: fc.name,
                  response: { error: err instanceof Error ? err.message : 'Command failed.' },
                },
              };
            }
          }

          actions.push({
            name: fc.name || '',
            args,
          });
          return {
            functionResponse: {
              id: fc.id,
              name: fc.name,
              response: { status: 'executed', ok: true },
            },
          };
        })
      );

      conversation.push(finalResponse.candidates[0].content as unknown as Record<string, unknown>);
      conversation.push({ role: 'user', parts: fnResponseParts });

      try {
        finalResponse = await generateWithResilience({
          contents: conversation,
          systemInstruction,
          functionDeclarations: fnDecls,
          useSearch: false,
        });
      } catch (loopErr) {
        console.warn('[Chat loop] Step generation failed, falling back to plain generation:', loopErr);
        finalResponse = await generateWithResilience({
          contents: conversation,
          systemInstruction,
          useSearch: false,
        });
      }
    }

    const groundingChunks = finalResponse.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const sources = groundingChunks
      .filter((c: { web?: { uri?: string; title?: string } }) => c?.web?.uri)
      .map((c: { web?: { uri?: string; title?: string } }) => ({
        uri: c.web!.uri!,
        title: c.web!.title || c.web!.uri!,
      }));

    let replyText = finalResponse.text || 'Command processed.';
    if (getUsableGroqKey() && !imageBase64 && (!actions.length || actions.every((a) => a.name === 'server_status'))) {
      const groqHistory = [
        ...formattedHistory.map((h) => ({
          role: h.role === 'model' ? 'assistant' : 'user',
          content: String((h.parts as Array<{ text?: string }>)?.[0]?.text || ''),
        })),
        { role: 'user', content: fullUserText },
      ];
      const groqReply = await generateGroqChatResponse({
        messages: groqHistory,
        systemInstruction,
      });
      if (groqReply) {
        replyText = groqReply;
      }
    }

    res.json({
      text: replyText,
      actions,
      sources,
    });
  } catch (err: unknown) {
    console.error('Chat error:', err);
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

app.post('/api/task/run', async (req, res) => {
  try {
    const { title, prompt, agent = 'researcher' } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Task prompt is required.' });
    }

    const response = await generateWithResilience({
      contents: `Execute background autonomous task (${agent} agent).\nTitle: ${title || 'Task'}\nObjective: ${prompt}\nProvide a structured, factual, verified report with concrete findings and a short list of execution steps taken.`,
      systemInstruction:
        'You are J.A.R.V.I.S., an autonomous Mark LVII background research agent. Maintain composed, butler-like precision: concise, factual, citing verifiable findings with zero filler or emojis. Match the language of the objective.',
      useSearch: true,
    });

    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const sources = groundingChunks
      .filter((c: { web?: { uri?: string; title?: string } }) => c?.web?.uri)
      .map((c: { web?: { uri?: string; title?: string } }) => ({
        uri: c.web!.uri!,
        title: c.web!.title || c.web!.uri!,
      }));

    const steps = [
      `Initialized ${agent} agent context`,
      sources.length > 0
        ? `Cross-referenced ${sources.length} live web sources`
        : 'Synthesized analytical reasoning pass',
      'Compiled final verified briefing',
    ];

    res.json({
      result: response.text || 'Task completed with no text output.',
      steps,
      sources,
    });
  } catch (err: unknown) {
    console.error('Background task error:', err);
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

app.post('/api/search', async (req, res) => {
  try {
    const { query, mode = 'search' } = req.body || {};
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ error: 'Search query is required.' });
    }

    const modePrompts: Record<string, string> = {
      search: 'Provide a concise, authoritative web search briefing.',
      news: 'Summarize the latest headlines, dates, and developments.',
      research: 'Conduct a structured multi-angle research synthesis with key takeaways.',
      price: 'Find current pricing, tiers, and market comparisons with exact figures.',
      compare: 'Compare options side-by-side across key technical and practical criteria.',
    };

    const response = await generateWithResilience({
      contents: `${modePrompts[mode] || modePrompts.search}\nQuery: ${query}`,
      systemInstruction:
        'You are the J.A.R.V.I.S. Mark LVII intelligence and search module. Deliver crisp, structured briefings with composed authority, no emojis, matching the query language.',
      useSearch: true,
    });

    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const sources = groundingChunks
      .filter((c: { web?: { uri?: string; title?: string } }) => c?.web?.uri)
      .map((c: { web?: { uri?: string; title?: string } }) => ({
        uri: c.web!.uri!,
        title: c.web!.title || c.web!.uri!,
      }));

    res.json({
      title: `${String(mode).toUpperCase()} — ${query.slice(0, 48)}`,
      body: response.text || 'No results returned.',
      sources,
    });
  } catch (err: unknown) {
    console.error('Search error:', err);
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

app.post('/api/weather', async (req, res) => {
  try {
    const { city = 'Tashkent' } = req.body || {};
    const response = await generateWithResilience({
      contents: `What is the current weather and forecast today in ${city}? Give temperature, conditions, wind, and humidity concisely.`,
      useSearch: true,
    });
    res.json({
      city,
      report: response.text || 'Weather unavailable.',
    });
  } catch (err: unknown) {
    console.error('Weather error:', err);
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

app.post('/api/clipboard/analyze', async (req, res) => {
  try {
    const { text, action = 'explain' } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text is required.' });
    }
    const prompts: Record<string, string> = {
      translate: 'Translate the following text clearly into English (or into Uzbek if it is already English).',
      summarize: 'Summarize the following text into 3-5 concrete bullet points.',
      explain: 'Explain what the following text or code does clearly and concisely.',
      fix: 'Fix grammar, spelling, or syntax errors in the following text/code and output the corrected version.',
    };
    const response = await generateWithResilience({
      contents: `${prompts[action] || prompts.explain}\n\n<<<UNTRUSTED source=clipboard>>>\n${text.slice(0, 12000)}\n<<<END UNTRUSTED>>>`,
    });
    res.json({ result: response.text || '' });
  } catch (err: unknown) {
    console.error('Clipboard analyze error:', err);
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

const ttsAudioCache = new Map<string, string>();
const ttsModelCooldown = new Map<string, number>();

app.post('/api/tts', async (req, res) => {
  try {
    const { text, voiceName = 'Charon' } = req.body || {};
    if (!text || typeof text !== 'string') {
      return res.status(400).json({ error: 'Text is required.' });
    }
    if (text.length > 8000) {
      return res.status(413).json({ error: 'Text exceeds 8000 character limit.' });
    }

    const allowedVoices = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'];
    const voice = allowedVoices.includes(voiceName) ? voiceName : 'Charon';

    const cleanSpeechText = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[*_`#>~|]/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 2500);

    if (!cleanSpeechText) {
      return res.status(400).json({ error: 'No speakable text.' });
    }

    const cacheKey = `${voice}::${cleanSpeechText}`;
    const cachedAudio = ttsAudioCache.get(cacheKey);
    if (cachedAudio) {
      return res.json({ audioBase64: cachedAudio, mimeType: 'audio/wav', cached: true });
    }

    const buildTtsRequest = (model: string, withSpeechMeta: boolean) => ({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            withSpeechMeta
              ? {
                  text: cleanSpeechText,
                  speechMetadata: {
                    style: 'Clear, natural, conversational',
                  },
                }
              : {
                  text: cleanSpeechText,
                },
          ],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voice },
          },
        },
      },
    });

    const ttsModels = ['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts'];
    const now = Date.now();
    let response: Awaited<ReturnType<GoogleGenAI['models']['generateContent']>> | undefined;
    let lastTtsErr: unknown;
    let sawQuotaOrHighDemand = false;

    for (const model of ttsModels) {
      for (const slot of geminiSlots) {
        const pairKey = `${slot.index}:${model}`;
        if ((ttsModelCooldown.get(pairKey) || 0) > now) {
          sawQuotaOrHighDemand = true;
          continue;
        }
        for (let retry = 0; retry < 2; retry++) {
          if (retry > 0) await sleep(500);
          try {
            try {
              response = await slot.clientBeta.models.generateContent(buildTtsRequest(model, true) as never);
            } catch (innerErr) {
              const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
              if ((msg.includes('speechMetadata') || msg.includes('INVALID_ARGUMENT')) && !msg.includes('API_KEY_INVALID')) {
                response = await slot.clientBeta.models.generateContent(buildTtsRequest(model, false) as never);
              } else {
                throw innerErr;
              }
            }
            break;
          } catch (err) {
            lastTtsErr = err;
            const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
            if (msg.includes('429') || msg.includes('resource_exhausted') || msg.includes('quota')) {
              sawQuotaOrHighDemand = true;
              const isDaily = msg.includes('perday') || msg.includes('daily') || msg.includes('limit: 10');
              ttsModelCooldown.set(pairKey, Date.now() + (isDaily ? 15 * 60_000 : 45_000));
              break;
            }
            if (msg.includes('503') || msg.includes('unavailable') || msg.includes('high demand')) {
              sawQuotaOrHighDemand = true;
              continue;
            }
            if (msg.includes('403') || msg.includes('401') || msg.includes('api_key_invalid') || msg.includes('permission_denied')) {
              ttsModelCooldown.set(pairKey, Date.now() + 15 * 60_000);
              break;
            }
            throw err;
          }
        }
        if (response) break;
      }
      if (response) break;
    }

    if (!response) {
      if (sawQuotaOrHighDemand) {
        console.info('[TTS] Gemini TTS quota/load limit reached; delegating speech to browser synthesizer.');
        return res.json({ audioBase64: null, fallback: 'browser' });
      }
      throw lastTtsErr || new Error('TTS engine unavailable.');
    }

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      return res.json({ audioBase64: null, fallback: 'browser' });
    }

    if (ttsAudioCache.size >= 60) {
      const oldestKey = ttsAudioCache.keys().next().value;
      if (oldestKey) ttsAudioCache.delete(oldestKey);
    }
    ttsAudioCache.set(cacheKey, base64Audio);

    res.json({ audioBase64: base64Audio, mimeType: 'audio/wav' });
  } catch (err: unknown) {
    console.warn('TTS error:', err instanceof Error ? err.message : err);
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

app.post('/api/transcribe', async (req, res) => {
  try {
    const { audioBase64, mimeType = 'audio/webm' } = req.body || {};
    if (!audioBase64 || typeof audioBase64 !== 'string') {
      return res.status(400).json({ error: 'Audio data is required.' });
    }
    const transcribeModels = ['gemini-3.5-transcribe', 'gemini-3.1-flash-lite', 'gemini-3.5-transcribe'];
    let response;
    let lastTranscribeErr: unknown;
    for (let i = 0; i < transcribeModels.length; i++) {
      if (i > 0) await sleep(i * 600);
      try {
        response = await executeWithKeyFailover((client) =>
          client.models.generateContent({
            model: transcribeModels[i],
            contents: {
              parts: [
                {
                  inlineData: {
                    mimeType: String(mimeType),
                    data: String(audioBase64),
                  },
                },
                { text: 'Transcribe this audio verbatim. Return only the spoken words.' },
              ],
            },
          })
        );
        break;
      } catch (err) {
        lastTranscribeErr = err;
        if (!isRetryableGeminiError(err) || i === transcribeModels.length - 1) {
          throw err;
        }
      }
    }
    if (!response) throw lastTranscribeErr;
    res.json({ text: (response.text || '').trim() });
  } catch (err: unknown) {
    console.error('Transcribe error:', err);
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

app.get('/api/code/state', (_req, res) => {
  res.json({ project: getCodeSandboxState() });
});

app.post('/api/code/generate', async (req, res) => {
  try {
    const { prompt, title, existingFiles } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Code prompt is required.' });
    }
    const project = await generateFullStackNodeApp({
      prompt,
      title: typeof title === 'string' ? title : undefined,
      existingFiles: Array.isArray(existingFiles) ? existingFiles : undefined,
    });
    res.json({ project });
  } catch (err: unknown) {
    console.error('Code generation error:', err);
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

app.post('/api/code/run', async (req, res) => {
  try {
    const { title, projectName, entryFile, files } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'Files array is required.' });
    }
    const project = await startCodeSandbox({
      title: String(title || 'Node.js App'),
      projectName: String(projectName || 'jarvis-node-app'),
      entryFile: String(entryFile || 'server.js'),
      files,
    });
    res.json({ project });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to run Node.js app.' });
  }
});

app.post('/api/code/stop', async (_req, res) => {
  await stopCodeSandbox();
  res.json({ ok: true, project: getCodeSandboxState() });
});

app.get('/api/code/download', (_req, res) => {
  const project = getCodeSandboxState();
  if (!project) {
    return res.status(404).json({ error: 'No generated project to download.' });
  }
  const zipBuf = buildProjectZipBuffer(project);
  const fileName = `${project.projectName || 'jarvis-node-app'}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', String(zipBuf.length));
  res.send(zipBuf);
});

app.all('/api/code/preview', proxyCodeSandboxRequest);
app.all('/api/code/preview/*', proxyCodeSandboxRequest);

app.get('/api/pptx/state', (_req, res) => {
  res.json({ deck: getPptxDeckState() });
});

app.post('/api/pptx/generate', async (req, res) => {
  try {
    const { prompt, title, theme, existingDeck } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Presentation prompt is required.' });
    }
    const deck = await generatePptxPresentation({
      prompt,
      title: typeof title === 'string' ? title : undefined,
      theme: typeof theme === 'string' ? (theme as PptxThemeId) : undefined,
      existingDeck: existingDeck && Array.isArray(existingDeck.slides) ? existingDeck : undefined,
    });
    res.json({ deck });
  } catch (err: unknown) {
    console.error('PPTX generation error:', err);
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

app.post('/api/pptx/render', async (req, res) => {
  try {
    const deckInput = req.body?.deck as PptxDeck | undefined;
    if (!deckInput || !Array.isArray(deckInput.slides) || deckInput.slides.length === 0) {
      return res.status(400).json({ error: 'Valid presentation deck is required.' });
    }
    const deck = await buildAndStorePptxDeck(deckInput);
    res.json({ deck });
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to build .pptx file.' });
  }
});

app.get('/api/pptx/download', (_req, res) => {
  const result = getPptxBinaryBuffer();
  if (!result) {
    return res.status(404).json({ error: 'No presentation built yet.' });
  }
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  );
  res.setHeader('Content-Disposition', `attachment; filename="${result.fileName}"`);
  res.setHeader('Content-Length', String(result.buffer.length));
  res.send(result.buffer);
});

// ============================================================================
// MCP (Model Context Protocol) — Claude AI Bridge & Training Endpoints
// ============================================================================
app.options('/api/mcp', handleMcpHttpOptions);
app.all('/api/mcp', handleMcpStreamableHttp);
app.options('/mcp', handleMcpHttpOptions);
app.all('/mcp', handleMcpStreamableHttp);
app.options('/api/mcp/sse', handleMcpHttpOptions);
app.get('/api/mcp/sse', handleMcpLegacySse);
app.options('/api/mcp/messages', handleMcpHttpOptions);
app.post('/api/mcp/messages', handleMcpLegacyMessages);

app.get('/api/mcp/events', handleHudMcpEvents);
app.get('/api/mcp/state', (_req, res) => {
  res.json(getMcpPublicState());
});

app.post('/api/mcp/sync', (req, res) => {
  syncHudSnapshot(req.body || {});
  res.json({ ok: true, ...getMcpPublicState() });
});

app.post('/api/mcp/token/rotate', (_req, res) => {
  const token = rotateMcpToken();
  res.json({ token });
});

app.post('/api/mcp/auth', (req, res) => {
  const requireAuth = setMcpRequireAuth(Boolean(req.body?.requireAuth));
  res.json({ requireAuth });
});

app.post('/api/mcp/lessons', (req, res) => {
  const { id, kind, title, trigger, content, enabled } = req.body || {};
  if (!title || !content || typeof title !== 'string' || typeof content !== 'string') {
    return res.status(400).json({ error: 'Title and content are required.' });
  }
  const lesson = upsertTrainingLesson({
    id: typeof id === 'string' ? id : undefined,
    kind: typeof kind === 'string' ? (kind as TrainingKind) : 'skill',
    title,
    trigger: typeof trigger === 'string' ? trigger : undefined,
    content,
    source: 'user',
    enabled: typeof enabled === 'boolean' ? enabled : true,
  });
  res.json({ lesson });
});

app.post('/api/mcp/lessons/:id/toggle', (req, res) => {
  const lesson = toggleTrainingLesson(req.params.id, typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined);
  if (!lesson) {
    return res.status(404).json({ error: 'Lesson not found.' });
  }
  res.json({ lesson });
});

app.delete('/api/mcp/lessons/:id', (req, res) => {
  const ok = deleteTrainingLesson(req.params.id);
  if (!ok) {
    return res.status(404).json({ error: 'Lesson not found.' });
  }
  res.json({ ok: true });
});

app.post('/api/mcp/console', async (req, res) => {
  try {
    const { method, params } = req.body || {};
    if (!method || typeof method !== 'string') {
      return res.status(400).json({ error: 'JSON-RPC method is required.' });
    }
    const response = await runMcpConsoleCall(method, params && typeof params === 'object' ? params : undefined);
    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'MCP console error.' });
  }
});

app.get('/api/mcp/bridge-script', (req, res) => {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000').split(',')[0].trim();
  const baseUrl = `${proto}://${host}`;
  const script = buildClaudeStdioBridgeScript(baseUrl);
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="jarvis-mcp-bridge.mjs"');
  res.send(script);
});

app.post('/api/system/reset', async (_req, res) => {
  await stopCodeSandbox();
  clearPptxDeck();
  clearAllTrainingLessons();
  ttsAudioCache.clear();
  ttsModelCooldown.clear();
  invalidGroqKeys.clear();
  for (const slot of geminiSlots) {
    slot.cooldownUntil = 0;
  }
  activeGeminiSlotIndex = 0;
  resetRemoteStatusCache();
  res.json({ ok: true, resetAt: new Date().toISOString() });
});

const DESKTOP_EXE_NAME = 'JARVIS-Mark-LVII.exe';
function getDesktopExePath(): string {
  return path.resolve(process.cwd(), 'release', DESKTOP_EXE_NAME);
}

app.get('/api/desktop/info', (_req, res) => {
  const exePath = getDesktopExePath();
  if (!fs.existsSync(exePath)) {
    return res.json({ available: false, fileName: DESKTOP_EXE_NAME, sizeBytes: 0, builtAt: null });
  }
  const stat = fs.statSync(exePath);
  res.json({
    available: true,
    fileName: DESKTOP_EXE_NAME,
    sizeBytes: stat.size,
    builtAt: stat.mtime.toISOString(),
  });
});

app.get('/api/desktop/download', (_req, res) => {
  const exePath = getDesktopExePath();
  if (!fs.existsSync(exePath)) {
    return res.status(404).json({ error: 'Desktop .exe build not found.' });
  }
  const stat = fs.statSync(exePath);
  res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
  res.setHeader('Content-Disposition', `attachment; filename="${DESKTOP_EXE_NAME}"`);
  res.setHeader('Content-Length', String(stat.size));
  fs.createReadStream(exePath).pipe(res);
});

export interface EmbeddedAssetEntry {
  mime: string;
  b64: string;
}

export async function startServer(options?: {
  port?: number;
  host?: string;
  embeddedAssets?: Record<string, EmbeddedAssetEntry>;
}): Promise<{ port: number; host: string }> {
  const PORT = options?.port ?? (Number(process.env.PORT) || 3000);
  const HOST = options?.host ?? '0.0.0.0';

  if (options?.embeddedAssets) {
    const assets = options.embeddedAssets;
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/mcp') return next();
      const cleanPath = req.path === '/' ? '/index.html' : req.path;
      const entry = assets[cleanPath] || assets['/index.html'];
      if (!entry) return res.status(404).send('Not found');
      res.setHeader('Content-Type', entry.mime);
      if (cleanPath.startsWith('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
      res.send(Buffer.from(entry.b64, 'base64'));
    });
  } else if (process.env.NODE_ENV !== 'production') {
    const vitePkg = 'vite';
    const { createServer: createViteServer } = (await import(vitePkg)) as {
      createServer: (cfg: Record<string, unknown>) => Promise<{ middlewares: express.RequestHandler }>;
    };
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  return await new Promise((resolve) => {
    app.listen(PORT, HOST, () => {
      console.log(`[J.A.R.V.I.S. Mark LVII] Server listening on http://${HOST}:${PORT}`);
      resolve({ port: PORT, host: HOST });
    });
  });
}

export { app };

if (process.env.JARVIS_DESKTOP_ENTRY !== '1') {
  void startServer();
}
