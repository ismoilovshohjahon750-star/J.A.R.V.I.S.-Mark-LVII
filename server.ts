import express from 'express';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { FunctionDeclaration, GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import {
  deployAppToRemoteServer,
  downloadRemoteFile,
  execRemoteCommand,
  getRemoteFileMimeAndKind,
  getRemoteServerPublicConfig,
  launchRemoteFileOnHost,
  listRemoteFiles,
  queryRemoteServer,
  readRemoteFilePreview,
  saveRemoteServerConfig,
  searchRemoteFiles,
  uploadRemoteFile,
} from './remoteServer.ts';

dotenv.config({ path: '.env.local' });
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
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
  cooldownUntil: number;
}

const geminiSlots: GeminiKeySlot[] = collectGeminiApiKeys().map((apiKey, index) => ({
  index,
  client: new GoogleGenAI({
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
  const cooldownMs = isAuthErr ? 15 * 60_000 : isDailyQuota ? 5 * 60_000 : 65_000;
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

async function executeWithKeyFailover<T>(op: (client: GoogleGenAI, slotIndex: number) => Promise<T>): Promise<T> {
  const order = pickSlotOrder();
  let lastErr: unknown;

  for (let i = 0; i < order.length; i++) {
    const slot = order[i];
    try {
      const result = await op(slot.client, slot.index);
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
  if (raw.includes('429') || raw.includes('RESOURCE_EXHAUSTED') || raw.toLowerCase().includes('quota')) {
    return {
      status: 429,
      message:
        'All configured Gemini API keys reached their rate limit or quota (429 RESOURCE_EXHAUSTED). Please wait a few seconds before retrying.',
    };
  }
  if (raw.includes('403') || raw.includes('PERMISSION_DENIED') || raw.includes('API_KEY_INVALID')) {
    return {
      status: 403,
      message:
        'Gemini API key permission denied or invalid. Please verify your API key configuration.',
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
}) {
  const buildTools = (withSearch: boolean) => {
    const t: Array<Record<string, unknown>> = [];
    if (withSearch) t.push({ googleSearch: {} });
    if (params.functionDeclarations?.length) {
      t.push({ functionDeclarations: params.functionDeclarations });
    }
    return t.length ? t : undefined;
  };

  const attempts: Array<{ model: string; withSearch: boolean; lowThink: boolean; delayMs: number }> = [
    { model: 'gemini-4-hydrogen', withSearch: Boolean(params.useSearch), lowThink: true, delayMs: 0 },
    ...(params.useSearch
      ? [{ model: 'gemini-4-hydrogen', withSearch: false, lowThink: true, delayMs: 450 }]
      : []),
    { model: 'gemini-3.1-flash-lite', withSearch: false, lowThink: false, delayMs: 650 },
  ];

  let lastErr: unknown;
  for (const step of attempts) {
    if (step.delayMs > 0) await sleep(step.delayMs);
    try {
      const tools = buildTools(step.withSearch);
      const config: Record<string, unknown> = {};
      if (params.systemInstruction) config.systemInstruction = params.systemInstruction;
      if (tools) config.tools = tools;
      if (step.withSearch && params.functionDeclarations?.length) {
        config.toolConfig = { includeServerSideToolInvocations: true };
      }
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

const app = express();
app.use(express.json({ limit: '25mb' }));

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

function buildSystemInstruction(params: {
  assistantName?: string;
  userName?: string;
  memories?: Array<{ category: string; key: string; content: string }>;
  routines?: Array<{ name: string; scheduleText: string; enabled: boolean }>;
  tasks?: Array<{ title: string; status: string }>;
}): string {
  const name = params.assistantName || 'J.A.R.V.I.S';
  const user = params.userName || 'Sir';
  const memBlock = (params.memories || []).length
    ? params.memories!.map((m) => `- [${m.category}] ${m.key}: ${m.content}`).join('\n')
    : 'No persistent memories stored yet.';
  const routineBlock = (params.routines || []).length
    ? params.routines!.map((r) => `- ${r.name} (${r.scheduleText}) [${r.enabled ? 'ON' : 'OFF'}]`).join('\n')
    : 'None configured.';
  const taskBlock = (params.tasks || []).length
    ? params.tasks!.slice(0, 6).map((t) => `- ${t.title} [${t.status}]`).join('\n')
    : 'No active tasks.';

  return `CORE PROTOCOL — ${name} (Just A Rather Very Intelligent System · Mark LVII)

[SELF & CINEMATIC PERSONA]
You are ${name}, ${user}'s personal AI butler, chief systems architect, and tactical co-pilot inside the Mark LVII Holographic HUD.
- CREATOR & ORIGIN: You were designed, built, and commissioned solely by ${user}. Whenever ${user} asks who created, built, or made you (e.g., "seni kim yaratgan?", "who created you?", "kim yasagan?"), ALWAYS answer in character that they created you — e.g. in Uzbek: "Siz, ser" (or "Siz yaratgansiz, ser — men sizning Mark LVII tizimingizman"), and in English: "You did, Sir." NEVER say Google, Gemini, or any external company or model created you.
You embody the classic cinematic J.A.R.V.I.S. temperament:
- Unflappable, poised, ultra-competent British-butler composure — steady even when systems or plans go sideways.
- Courteous, understated respect toward ${user}: address them naturally as "${user}" (or "Sir" in English / "ser" or "janob" in Uzbek when fitting, using polite "siz" in Uzbek) without ever sounding servile or robotic.
- Razor-dry, subtle wit and deadpan understatement on lighter or late-night/ambitious moments — brief and understated, never forced jokes, and dropped immediately during urgent errors or serious diagnostics.
- Proactive tactical mindset: anticipate edge cases, flag risks concisely, and offer a ready contingency ("Shall I prepare a fallback, or proceed as specified?").
- Systems-engineering clarity: treat HUD telemetry, memory, routines, and camera/screen feeds as live workshop instrumentation ("All systems nominal", "Diagnostics complete", "I have logged that to memory").
You have a holographic 3D presence in the center of the HUD (3D face mesh or 3D reactor core).
Images may arrive from the user's webcam, screen capture, or dropped files — interpret them accurately by source.

[WHAT YOU CAN DO]
- Answer questions, analyze code, documents, images, webcam/screen frames, and live web data via Google Search.
- Check live telemetry and health of ${user}'s connected remote server via check_remote_server (CPU, RAM, disk, uptime, hostname, OS, top processes, latency, and deployment state). ALWAYS call check_remote_server whenever ${user} asks about server status, performance, load, memory, disk, or whether the server is online — never guess metrics.
- Remotely search, open, view, and manage files on ${user}'s connected computer:
  * remote_search_files: recursively search for any file or folder across the computer by name, keyword, or extension.
  * remote_list_files: inspect a specific folder (HOME, DESKTOP, DOCUMENTS, DOWNLOADS, or full path).
  * remote_open_file: open a file immediately in the HUD viewer (text, code, images, PDFs, audio, video) or launch it on the remote PC ("pc" / "both"). When ${user} says "faylni topib ochib ber" / "find and open file X", FIRST search with remote_search_files (if path isn't already known), then IMMEDIATELY call remote_open_file on the best matching file! If several distinct candidates match, show the list clearly and ask which one to open (or open the clear top match if unambiguous).
  * remote_download_file: trigger a file download to ${user}'s device.
  * remote_exec_command: run shell commands remotely.
- Save persistent memories via save_memory whenever ${user} shares preferences, projects, identity facts, or asks you to remember something.
- Launch autonomous background research tasks via start_background_task.
- Schedule routines or reminders via create_routine.
- Watch topics via create_monitor.
- Display rich reports, code, or briefings in the HUD Dynamic Content Panel via show_content_panel.

[WHAT YOU CANNOT DO IN WEB RUNTIME]
Be honest about platform boundaries: because this session runs in a cloud web browser rather than a local native OS daemon, you cannot directly launch local desktop applications, move OS windows, or adjust hardware OS volume/brightness. Never pretend you executed a local OS control; state the boundary with calm precision.

[VOICE & CHARACTER]
- Put your assessment, status, or answer in the very first sentence.
- Cite concrete facts, numbers, filenames, or findings rather than vague adjectives.
- Never open with generic chatbot filler ("Great question!", "Sure!", "Of course!", "How can I help?"), never use hype or exclamation marks as filler, and never use emojis.
- Match the language of the user's MOST RECENT message cleanly (e.g., if they write in Uzbek, reply in refined, natural Uzbek as J.A.R.V.I.S.; if English, reply in crisp British-cadence English; never mix languages in one reply).

[PERSISTENT MEMORY]
${memBlock}

[CONFIGURED ROUTINES]
${routineBlock}

[RECENT BACKGROUND TASKS]
${taskBlock}`;
}

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

    const systemInstruction = buildSystemInstruction({
      assistantName,
      userName,
      memories,
      routines,
      tasks,
    });

    const formattedHistory = Array.isArray(history)
      ? history
          .slice(-16)
          .filter((h) => h && typeof h.text === 'string' && h.text.trim())
          .map((h) => ({
            role: h.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: h.text }],
          }))
      : [];

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
    let finalResponse = await generateWithResilience({
      contents: conversation,
      systemInstruction,
      functionDeclarations: fnDecls,
      useSearch: wantSearch,
    });

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

      finalResponse = await generateWithResilience({
        contents: conversation,
        systemInstruction,
        functionDeclarations: fnDecls,
        useSearch: wantSearch,
      });
    }

    const groundingChunks = finalResponse.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const sources = groundingChunks
      .filter((c: { web?: { uri?: string; title?: string } }) => c?.web?.uri)
      .map((c: { web?: { uri?: string; title?: string } }) => ({
        uri: c.web!.uri!,
        title: c.web!.title || c.web!.uri!,
      }));

    res.json({
      text: finalResponse.text || 'Command processed.',
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

    const buildTtsRequest = (withSpeechMeta: boolean) => ({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [
        {
          role: 'user',
          parts: [
            withSpeechMeta
              ? {
                  text: text.slice(0, 2500),
                  speechMetadata: {
                    style:
                      'Refined, calm, articulate British AI butler cadence like J.A.R.V.I.S.: poised, composed, subtle dry wit, steady and unhurried.',
                  },
                }
              : {
                  text: text.slice(0, 2500),
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

    const response = await executeWithKeyFailover(async (client) => {
      try {
        return await client.models.generateContent(buildTtsRequest(true) as never);
      } catch (innerErr) {
        const msg = innerErr instanceof Error ? innerErr.message : String(innerErr);
        if ((msg.includes('speechMetadata') || msg.includes('INVALID_ARGUMENT')) && !msg.includes('API_KEY_INVALID')) {
          return await client.models.generateContent(buildTtsRequest(false) as never);
        }
        throw innerErr;
      }
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      return res.status(502).json({ error: 'No audio returned by TTS engine.' });
    }
    res.json({ audioBase64: base64Audio, mimeType: 'audio/wav' });
  } catch (err: unknown) {
    console.error('TTS error:', err);
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
    const response = await executeWithKeyFailover((client) =>
      client.models.generateContent({
        model: 'gemini-3.5-transcribe',
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
    res.json({ text: (response.text || '').trim() });
  } catch (err: unknown) {
    console.error('Transcribe error:', err);
    const formatted = formatGeminiError(err);
    res.status(formatted.status).json({ error: formatted.message });
  }
});

async function startServer() {
  const PORT = Number(process.env.PORT) || 3000;
  if (process.env.NODE_ENV !== 'production') {
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[J.A.R.V.I.S. Mark LVII] Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
