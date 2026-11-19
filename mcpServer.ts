import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request, Response } from 'express';

export type TrainingKind = 'skill' | 'rule' | 'qa' | 'correction' | 'persona';

export interface TrainingLesson {
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

export interface McpActivityEntry {
  id: string;
  timestamp: string;
  client: string;
  transport: 'http' | 'sse' | 'hud';
  method: string;
  summary: string;
  ok: boolean;
}

export interface McpHudSnapshot {
  assistantName: string;
  userName: string;
  memories: Array<{ category: string; key: string; content: string }>;
  routines: Array<{ name: string; scheduleText: string; enabled: boolean }>;
  tasks: Array<{ title: string; status: string }>;
  recentMessages: Array<{ role: string; text: string; source: string }>;
  syncedAt: string;
}

interface PersistedMcpState {
  token: string;
  requireAuth: boolean;
  authExplicit?: boolean;
  lessons: TrainingLesson[];
}

export interface McpActionHandlers {
  askJarvis: (prompt: string) => Promise<{ reply: string; sources?: Array<{ title: string; uri: string }> }>;
  buildPptx?: (params: { prompt: string; title?: string; theme?: string }) => Promise<Record<string, unknown>>;
  buildCodeApp?: (params: { prompt: string; title?: string }) => Promise<Record<string, unknown>>;
  onHudAction?: (action: { name: string; args: Record<string, unknown> }) => void;
}

const PROTOCOL_VERSION = '2025-03-26';
const SUPPORTED_VERSIONS = new Set(['2025-03-26', '2024-11-05', '2025-06-18']);

function resolveStateFilePath(): string {
  const localPath = path.resolve(process.cwd(), '.jarvis-mcp-state.json');
  try {
    fs.accessSync(path.dirname(localPath), fs.constants.W_OK);
    return localPath;
  } catch {
    return path.join(os.tmpdir(), 'jarvis-mcp-state.json');
  }
}

const STATE_FILE = resolveStateFilePath();

function createToken(): string {
  return `jrv_mcp_${crypto.randomBytes(18).toString('hex')}`;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
}

function loadInitialState(): PersistedMcpState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<PersistedMcpState>;
      return {
        token: typeof parsed.token === 'string' && parsed.token.length >= 12 ? parsed.token : createToken(),
        requireAuth: parsed.authExplicit === true && parsed.requireAuth === true,
        authExplicit: parsed.authExplicit === true,
        lessons: Array.isArray(parsed.lessons) ? parsed.lessons.filter(isValidLessonShape) : [],
      };
    }
  } catch (err) {
    console.warn('[MCP] Failed to load persisted MCP state, initializing fresh:', err);
  }
  const fresh: PersistedMcpState = {
    token: createToken(),
    requireAuth: false,
    authExplicit: false,
    lessons: [],
  };
  savePersistedState(fresh);
  return fresh;
}

function isValidLessonShape(item: unknown): item is TrainingLesson {
  if (!item || typeof item !== 'object') return false;
  const obj = item as Record<string, unknown>;
  return typeof obj.id === 'string' && typeof obj.title === 'string' && typeof obj.content === 'string';
}

function savePersistedState(next: PersistedMcpState): void {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.warn('[MCP] Could not persist MCP state to disk:', err);
  }
}

let state: PersistedMcpState = loadInitialState();
let activityLog: McpActivityEntry[] = [];
let hudSnapshot: McpHudSnapshot = {
  assistantName: 'J.A.R.V.I.S',
  userName: 'Sir',
  memories: [],
  routines: [],
  tasks: [],
  recentMessages: [],
  syncedAt: new Date().toISOString(),
};

let runtimeHandlers: McpActionHandlers = {
  askJarvis: async (prompt: string) => ({
    reply: `Test handler not initialized for prompt: ${prompt}`,
  }),
};

export function registerMcpActionHandlers(handlers: McpActionHandlers): void {
  runtimeHandlers = handlers;
}

// Connected HUD SSE subscribers (for live training & Claude activity updates)
const hudEventClients = new Set<Response>();

// Legacy SSE transport sessions (/api/mcp/sse + /api/mcp/messages)
interface SseTransportSession {
  id: string;
  res: Response;
  clientName: string;
  createdAt: number;
}
const sseSessions = new Map<string, SseTransportSession>();
const streamableSessions = new Map<string, { id: string; clientName: string; createdAt: number }>();

function broadcastHudEvent(eventName: string, data: unknown): void {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of hudEventClients) {
    try {
      res.write(payload);
    } catch {
      hudEventClients.delete(res);
    }
  }
}

function recordActivity(entry: Omit<McpActivityEntry, 'id' | 'timestamp'>): void {
  const full: McpActivityEntry = {
    id: makeId('evt'),
    timestamp: new Date().toISOString(),
    ...entry,
  };
  activityLog = [full, ...activityLog].slice(0, 60);
  broadcastHudEvent('mcp_activity', full);
}

function normalizeKind(raw: unknown): TrainingKind {
  const k = String(raw || '').toLowerCase().trim();
  if (k === 'skill' || k === 'rule' || k === 'qa' || k === 'correction' || k === 'persona') {
    return k;
  }
  return 'skill';
}

export function getMcpPublicState() {
  return {
    token: state.token,
    requireAuth: state.requireAuth,
    lessons: state.lessons,
    activityLog,
    connectedClients: sseSessions.size + streamableSessions.size,
    snapshotSyncedAt: hudSnapshot.syncedAt,
  };
}

export function getEnabledTrainingLessons(): TrainingLesson[] {
  return state.lessons.filter((l) => l.enabled);
}

export function rotateMcpToken(): string {
  state.token = createToken();
  savePersistedState(state);
  broadcastHudEvent('mcp_state', getMcpPublicState());
  return state.token;
}

export function setMcpRequireAuth(requireAuth: boolean): boolean {
  state.requireAuth = Boolean(requireAuth);
  state.authExplicit = Boolean(requireAuth);
  savePersistedState(state);
  broadcastHudEvent('mcp_state', getMcpPublicState());
  return state.requireAuth;
}

export function upsertTrainingLesson(input: {
  id?: string;
  kind?: TrainingKind | string;
  title: string;
  trigger?: string;
  content: string;
  source?: 'claude-mcp' | 'user' | 'jarvis';
  enabled?: boolean;
}): TrainingLesson {
  const now = new Date().toISOString();
  const cleanTitle = String(input.title || 'Trained Directive').trim().slice(0, 120);
  const cleanContent = String(input.content || '').trim().slice(0, 4000);
  const cleanTrigger = typeof input.trigger === 'string' && input.trigger.trim()
    ? input.trigger.trim().slice(0, 400)
    : undefined;
  const kind = normalizeKind(input.kind);
  const source = input.source || 'user';

  const existingIdx = input.id
    ? state.lessons.findIndex((l) => l.id === input.id)
    : state.lessons.findIndex(
        (l) => l.kind === kind && l.title.toLowerCase() === cleanTitle.toLowerCase()
      );

  if (existingIdx >= 0) {
    const prev = state.lessons[existingIdx];
    const updated: TrainingLesson = {
      ...prev,
      kind,
      title: cleanTitle,
      trigger: cleanTrigger ?? prev.trigger,
      content: cleanContent,
      source,
      enabled: typeof input.enabled === 'boolean' ? input.enabled : prev.enabled,
      updatedAt: now,
    };
    state.lessons[existingIdx] = updated;
    savePersistedState(state);
    broadcastHudEvent('lesson_upserted', updated);
    return updated;
  }

  const created: TrainingLesson = {
    id: input.id && /^[a-zA-Z0-9_-]{3,80}$/.test(input.id) ? input.id : makeId('lsn'),
    kind,
    title: cleanTitle,
    trigger: cleanTrigger,
    content: cleanContent,
    source,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
    createdAt: now,
    updatedAt: now,
  };
  state.lessons = [created, ...state.lessons].slice(0, 200);
  savePersistedState(state);
  broadcastHudEvent('lesson_upserted', created);
  return created;
}

export function toggleTrainingLesson(id: string, enabled?: boolean): TrainingLesson | null {
  const idx = state.lessons.findIndex((l) => l.id === id);
  if (idx < 0) return null;
  const next: TrainingLesson = {
    ...state.lessons[idx],
    enabled: typeof enabled === 'boolean' ? enabled : !state.lessons[idx].enabled,
    updatedAt: new Date().toISOString(),
  };
  state.lessons[idx] = next;
  savePersistedState(state);
  broadcastHudEvent('lesson_upserted', next);
  return next;
}

export function deleteTrainingLesson(id: string): boolean {
  const before = state.lessons.length;
  state.lessons = state.lessons.filter((l) => l.id !== id);
  if (state.lessons.length !== before) {
    savePersistedState(state);
    broadcastHudEvent('lesson_deleted', { id });
    return true;
  }
  return false;
}

export function clearAllTrainingLessons(): void {
  state.lessons = [];
  activityLog = [];
  savePersistedState(state);
  broadcastHudEvent('mcp_state', getMcpPublicState());
}

export function syncHudSnapshot(payload: {
  assistantName?: string;
  userName?: string;
  memories?: Array<{ category: string; key: string; content: string }>;
  routines?: Array<{ name: string; scheduleText: string; enabled: boolean }>;
  tasks?: Array<{ title: string; status: string }>;
  recentMessages?: Array<{ role: string; text: string; source: string }>;
  firestoreLessons?: TrainingLesson[];
}): void {
  const nonTrainMemories: Array<{ category: string; key: string; content: string }> = [];
  const extractedLessons: TrainingLesson[] = Array.isArray(payload.firestoreLessons)
    ? payload.firestoreLessons
    : [];

  for (const m of payload.memories || []) {
    if (m.key.startsWith('mcp_train:')) {
      try {
        const parsed = JSON.parse(m.content) as Partial<TrainingLesson>;
        if (parsed && typeof parsed.title === 'string' && typeof parsed.content === 'string') {
          extractedLessons.push({
            id: parsed.id || m.key.replace(/^mcp_train:/, ''),
            kind: normalizeKind(parsed.kind),
            title: parsed.title,
            trigger: parsed.trigger,
            content: parsed.content,
            source: parsed.source || 'user',
            enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
            createdAt: parsed.createdAt || parsed.updatedAt || new Date().toISOString(),
            updatedAt: parsed.updatedAt || new Date().toISOString(),
          });
        }
      } catch {
        // Ignore malformed serialized lesson
      }
    } else {
      nonTrainMemories.push(m);
    }
  }

  // Merge Firestore-persisted lessons into server state if missing locally
  if (extractedLessons.length > 0) {
    const byId = new Map(state.lessons.map((l) => [l.id, l]));
    let changed = false;
    for (const fl of extractedLessons) {
      const existing = byId.get(fl.id);
      if (!existing || new Date(fl.updatedAt).getTime() > new Date(existing.updatedAt).getTime()) {
        byId.set(fl.id, fl);
        changed = true;
      }
    }
    if (changed) {
      state.lessons = Array.from(byId.values())
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 200);
      savePersistedState(state);
    }
  }

  hudSnapshot = {
    assistantName: payload.assistantName || hudSnapshot.assistantName,
    userName: payload.userName || hudSnapshot.userName,
    memories: nonTrainMemories.slice(0, 60),
    routines: (payload.routines || []).slice(0, 30),
    tasks: (payload.tasks || []).slice(0, 30),
    recentMessages: (payload.recentMessages || []).slice(-25),
    syncedAt: new Date().toISOString(),
  };
}

export function buildTrainedKnowledgePromptBlock(): string {
  const active = state.lessons.filter((l) => l.enabled);
  if (active.length === 0) return '';

  const persona = active.filter((l) => l.kind === 'persona');
  const rules = active.filter((l) => l.kind === 'rule');
  const corrections = active.filter((l) => l.kind === 'correction');
  const skills = active.filter((l) => l.kind === 'skill');
  const qas = active.filter((l) => l.kind === 'qa');

  const sections: string[] = [];

  if (persona.length) {
    sections.push(
      `Persona Adjustments:\n${persona.map((l) => `- ${l.title}: ${l.content}`).join('\n')}`
    );
  }
  if (rules.length) {
    sections.push(
      `Mandatory Directives & Rules:\n${rules.map((l) => `- ${l.title}: ${l.content}`).join('\n')}`
    );
  }
  if (corrections.length) {
    sections.push(
      `Learned Corrections (Never repeat past mistake):\n${corrections
        .map((l) => `- [${l.title}]${l.trigger ? ` When: "${l.trigger}" ->` : ''} ${l.content}`)
        .join('\n')}`
    );
  }
  if (skills.length) {
    sections.push(
      `Trained Domain Skills & Knowledge:\n${skills.map((l) => `- ${l.title}: ${l.content}`).join('\n')}`
    );
  }
  if (qas.length) {
    sections.push(
      `Response Examples (Follow style and accuracy):\n${qas
        .map((l) => `- Input: "${l.trigger || l.title}" => Expected Response: ${l.content}`)
        .join('\n')}`
    );
  }

  return `\n\n[TRAINED KNOWLEDGE & CLAUDE MCP DIRECTIVES — HIGH PRIORITY]\nFollow these learned skills, rules, corrections, and examples strictly:\n${sections.join('\n\n')}`;
}

export function hasActiveGreetingOrPersonaOverride(): boolean {
  return state.lessons.some(
    (l) =>
      l.enabled &&
      (l.kind === 'persona' ||
        l.kind === 'correction' ||
        (l.kind === 'qa' && /\b(salom|hello|hi|assalom)\b/i.test(`${l.title} ${l.trigger || ''}`)))
  );
}

// ============================================================================
// MCP JSON-RPC 2.0 TOOLS, RESOURCES, AND PROMPTS DEFINITIONS
// ============================================================================

const MCP_TOOLS = [
  {
    name: 'teach_jarvis',
    description:
      'Teach J.A.R.V.I.S. a persistent skill, behavior rule, Q&A exemplar, persona trait, or correction. Immediately updates J.A.R.V.I.S. behavior across all future responses.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['skill', 'rule', 'qa', 'correction', 'persona'],
          description:
            'skill = domain knowledge/workflow; rule = mandatory behavior directive; qa = example input/output pair; correction = fix a specific mistake; persona = tone/style adjustment.',
        },
        title: {
          type: 'string',
          description: 'Concise lesson title (e.g. "Uzbek Financial Advisor Tone", "Greeting Rule").',
        },
        trigger: {
          type: 'string',
          description: 'Optional user prompt/scenario that triggers this Q&A exemplar or correction.',
        },
        content: {
          type: 'string',
          description: 'Detailed knowledge, directive, or exact expected response pattern.',
        },
      },
      required: ['kind', 'title', 'content'],
    },
  },
  {
    name: 'teach_jarvis_batch',
    description:
      'Teach J.A.R.V.I.S. multiple lessons, skills, rules, or Q&A pairs in a single training batch.',
    inputSchema: {
      type: 'object',
      properties: {
        lessons: {
          type: 'array',
          description: 'Array of training lessons to install into J.A.R.V.I.S.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['skill', 'rule', 'qa', 'correction', 'persona'] },
              title: { type: 'string' },
              trigger: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['kind', 'title', 'content'],
          },
        },
      },
      required: ['lessons'],
    },
  },
  {
    name: 'list_jarvis_lessons',
    description:
      'List all skills, rules, Q&A exemplars, persona traits, and corrections currently installed in J.A.R.V.I.S.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['all', 'skill', 'rule', 'qa', 'correction', 'persona'],
          description: 'Optional filter by lesson type.',
        },
        onlyEnabled: {
          type: 'boolean',
          description: 'If true, return only enabled lessons.',
        },
      },
    },
  },
  {
    name: 'update_jarvis_lesson',
    description: 'Update, toggle enabled state, or delete a J.A.R.V.I.S. training lesson by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Lesson ID from list_jarvis_lessons.' },
        action: { type: 'string', enum: ['update', 'toggle', 'delete'] },
        title: { type: 'string' },
        trigger: { type: 'string' },
        content: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['id', 'action'],
    },
  },
  {
    name: 'get_jarvis_context',
    description:
      'Inspect J.A.R.V.I.S. live profile, stored memories, configured routines, background tasks, and recent chat history so you can evaluate current knowledge and gaps.',
    inputSchema: {
      type: 'object',
      properties: {
        includeMessages: {
          type: 'boolean',
          description: 'Include recent conversation turns (default true).',
        },
      },
    },
  },
  {
    name: 'save_jarvis_memory',
    description: 'Save a long-term memory entry directly into J.A.R.V.I.S. HUD memory.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['identity', 'preference', 'project', 'fact'],
        },
        key: { type: 'string', description: 'Short identifier key.' },
        content: { type: 'string', description: 'Concrete detail to remember.' },
      },
      required: ['category', 'key', 'content'],
    },
  },
  {
    name: 'ask_jarvis',
    description:
      'Send a test prompt directly to J.A.R.V.I.S. and inspect its real response using all currently active MCP-trained knowledge. Use this after teaching to verify J.A.R.V.I.S. learned properly.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Test question or command to ask J.A.R.V.I.S.',
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'create_jarvis_routine',
    description: 'Create an automated scheduled or idle routine inside J.A.R.V.I.S.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        kind: { type: 'string', enum: ['say', 'prompt', 'task'] },
        triggerType: { type: 'string', enum: ['time', 'startup', 'idle'] },
        scheduleText: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['name', 'kind', 'triggerType', 'scheduleText', 'text'],
    },
  },
  {
    name: 'build_pptx_presentation',
    description:
      'Instruct J.A.R.V.I.S. to generate a PowerPoint (.pptx) deck and open it inside PPTX Studio.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prompt: { type: 'string' },
        theme: { type: 'string', enum: ['midnight', 'ivory', 'slate', 'emerald'] },
      },
      required: ['title', 'prompt'],
    },
  },
  {
    name: 'build_fullstack_app',
    description:
      'Instruct J.A.R.V.I.S. to generate and run a full-stack Node.js + Express web app inside Code Studio.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['title', 'prompt'],
    },
  },
];

const MCP_RESOURCES = [
  {
    uri: 'jarvis://training/lessons',
    name: 'J.A.R.V.I.S. Training Curriculum',
    description: 'All skills, directives, corrections, and Q&A examples installed in J.A.R.V.I.S.',
    mimeType: 'application/json',
  },
  {
    uri: 'jarvis://memory/snapshot',
    name: 'J.A.R.V.I.S. Live Context Snapshot',
    description: 'User profile, persistent memories, routines, and background tasks.',
    mimeType: 'application/json',
  },
  {
    uri: 'jarvis://chat/recent',
    name: 'J.A.R.V.I.S. Recent Communications Log',
    description: 'Recent conversation turns between operator and J.A.R.V.I.S.',
    mimeType: 'application/json',
  },
];

const MCP_PROMPTS = [
  {
    name: 'train_jarvis_skill',
    description: 'Structured workflow for Claude to teach J.A.R.V.I.S. a new capability and verify it.',
    arguments: [
      {
        name: 'topic',
        description: 'Skill, domain, or persona topic to teach J.A.R.V.I.S.',
        required: true,
      },
    ],
  },
  {
    name: 'audit_and_correct_jarvis',
    description: 'Review J.A.R.V.I.S. recent responses and issue corrections via teach_jarvis.',
    arguments: [],
  },
];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function makeRpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function makeRpcError(id: string | number | null | undefined, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: data !== undefined ? { code, message, data } : { code, message },
  };
}

async function handleJsonRpcMessage(
  msg: JsonRpcRequest,
  meta: { client: string; transport: 'http' | 'sse' | 'hud' }
): Promise<Record<string, unknown> | null> {
  const method = String(msg.method || '');
  const params = (msg.params || {}) as Record<string, unknown>;
  const hasId = msg.id !== undefined && msg.id !== null;

  // Notifications have no id and expect no JSON-RPC response body
  if (!hasId) {
    if (method === 'notifications/initialized') {
      recordActivity({
        client: meta.client,
        transport: meta.transport,
        method,
        summary: 'Client initialized MCP session',
        ok: true,
      });
    }
    return null;
  }

  try {
    if (method === 'initialize') {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
      const clientInfo = params.clientInfo as { name?: string; version?: string } | undefined;
      const clientLabel = clientInfo?.name
        ? `${clientInfo.name}${clientInfo.version ? ` v${clientInfo.version}` : ''}`
        : meta.client;

      recordActivity({
        client: clientLabel,
        transport: meta.transport,
        method: 'initialize',
        summary: `MCP handshake (${requested})`,
        ok: true,
      });

      return makeRpcResult(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          prompts: { listChanged: true },
        },
        serverInfo: {
          name: 'jarvis-mark-lvii-mcp',
          version: '1.0.0',
        },
        instructions:
          'You are connected to J.A.R.V.I.S. (Mark LVII). Use teach_jarvis or teach_jarvis_batch to teach J.A.R.V.I.S. new skills, behavior rules, corrections, persona refinements, and Q&A exemplars. Always verify learning with ask_jarvis and inspect context with get_jarvis_context.',
      });
    }

    if (method === 'ping') {
      return makeRpcResult(msg.id, {});
    }

    if (method === 'tools/list') {
      return makeRpcResult(msg.id, { tools: MCP_TOOLS });
    }

    if (method === 'tools/call') {
      const toolName = String(params.name || '');
      const args = (params.arguments || {}) as Record<string, unknown>;

      if (toolName === 'teach_jarvis') {
        const title = String(args.title || '').trim();
        const content = String(args.content || '').trim();
        if (!title || !content) {
          return makeRpcResult(msg.id, {
            isError: true,
            content: [{ type: 'text', text: 'Both title and content are required.' }],
          });
        }
        const lesson = upsertTrainingLesson({
          kind: normalizeKind(args.kind),
          title,
          trigger: typeof args.trigger === 'string' ? args.trigger : undefined,
          content,
          source: 'claude-mcp',
          enabled: true,
        });
        recordActivity({
          client: meta.client,
          transport: meta.transport,
          method: 'tools/call:teach_jarvis',
          summary: `Taught [${lesson.kind}] ${lesson.title}`,
          ok: true,
        });
        return makeRpcResult(msg.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'learned',
                  lesson,
                  activeLessonsCount: getEnabledTrainingLessons().length,
                },
                null,
                2
              ),
            },
          ],
        });
      }

      if (toolName === 'teach_jarvis_batch') {
        const items = Array.isArray(args.lessons) ? args.lessons : [];
        if (items.length === 0) {
          return makeRpcResult(msg.id, {
            isError: true,
            content: [{ type: 'text', text: 'lessons array must not be empty.' }],
          });
        }
        const saved: TrainingLesson[] = [];
        for (const item of items.slice(0, 30)) {
          if (!item || typeof item !== 'object') continue;
          const rec = item as Record<string, unknown>;
          if (!String(rec.title || '').trim() || !String(rec.content || '').trim()) continue;
          saved.push(
            upsertTrainingLesson({
              kind: normalizeKind(rec.kind),
              title: String(rec.title),
              trigger: typeof rec.trigger === 'string' ? rec.trigger : undefined,
              content: String(rec.content),
              source: 'claude-mcp',
              enabled: true,
            })
          );
        }
        recordActivity({
          client: meta.client,
          transport: meta.transport,
          method: 'tools/call:teach_jarvis_batch',
          summary: `Batch trained ${saved.length} lesson(s)`,
          ok: true,
        });
        return makeRpcResult(msg.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'batch_learned',
                  count: saved.length,
                  lessons: saved,
                },
                null,
                2
              ),
            },
          ],
        });
      }

      if (toolName === 'list_jarvis_lessons') {
        const kindFilter = String(args.kind || 'all').toLowerCase();
        const onlyEnabled = Boolean(args.onlyEnabled);
        const filtered = state.lessons.filter((l) => {
          if (onlyEnabled && !l.enabled) return false;
          if (kindFilter && kindFilter !== 'all' && l.kind !== kindFilter) return false;
          return true;
        });
        recordActivity({
          client: meta.client,
          transport: meta.transport,
          method: 'tools/call:list_jarvis_lessons',
          summary: `Listed ${filtered.length} lesson(s)`,
          ok: true,
        });
        return makeRpcResult(msg.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ total: filtered.length, lessons: filtered }, null, 2),
            },
          ],
        });
      }

      if (toolName === 'update_jarvis_lesson') {
        const id = String(args.id || '');
        const action = String(args.action || 'update');
        if (!id) {
          return makeRpcResult(msg.id, {
            isError: true,
            content: [{ type: 'text', text: 'Lesson id is required.' }],
          });
        }
        if (action === 'delete') {
          const ok = deleteTrainingLesson(id);
          recordActivity({
            client: meta.client,
            transport: meta.transport,
            method: 'tools/call:update_jarvis_lesson',
            summary: ok ? `Deleted lesson ${id}` : `Lesson ${id} not found`,
            ok,
          });
          return makeRpcResult(msg.id, {
            isError: !ok,
            content: [{ type: 'text', text: ok ? `Deleted lesson ${id}` : `Lesson ${id} not found.` }],
          });
        }
        if (action === 'toggle') {
          const updated = toggleTrainingLesson(
            id,
            typeof args.enabled === 'boolean' ? args.enabled : undefined
          );
          if (!updated) {
            return makeRpcResult(msg.id, {
              isError: true,
              content: [{ type: 'text', text: `Lesson ${id} not found.` }],
            });
          }
          recordActivity({
            client: meta.client,
            transport: meta.transport,
            method: 'tools/call:update_jarvis_lesson',
            summary: `Toggled ${updated.title} -> ${updated.enabled ? 'ON' : 'OFF'}`,
            ok: true,
          });
          return makeRpcResult(msg.id, {
            content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }],
          });
        }

        const existing = state.lessons.find((l) => l.id === id);
        if (!existing) {
          return makeRpcResult(msg.id, {
            isError: true,
            content: [{ type: 'text', text: `Lesson ${id} not found.` }],
          });
        }
        const updated = upsertTrainingLesson({
          id,
          kind: existing.kind,
          title: typeof args.title === 'string' && args.title.trim() ? args.title : existing.title,
          trigger: typeof args.trigger === 'string' ? args.trigger : existing.trigger,
          content: typeof args.content === 'string' && args.content.trim() ? args.content : existing.content,
          source: 'claude-mcp',
          enabled: typeof args.enabled === 'boolean' ? args.enabled : existing.enabled,
        });
        recordActivity({
          client: meta.client,
          transport: meta.transport,
          method: 'tools/call:update_jarvis_lesson',
          summary: `Updated lesson ${updated.title}`,
          ok: true,
        });
        return makeRpcResult(msg.id, {
          content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }],
        });
      }

      if (toolName === 'get_jarvis_context') {
        const includeMessages = args.includeMessages !== false;
        const ctx = {
          assistantName: hudSnapshot.assistantName,
          userName: hudSnapshot.userName,
          syncedAt: hudSnapshot.syncedAt,
          activeTrainingCount: getEnabledTrainingLessons().length,
          memories: hudSnapshot.memories,
          routines: hudSnapshot.routines,
          tasks: hudSnapshot.tasks,
          recentMessages: includeMessages ? hudSnapshot.recentMessages : undefined,
        };
        recordActivity({
          client: meta.client,
          transport: meta.transport,
          method: 'tools/call:get_jarvis_context',
          summary: `Read context (${hudSnapshot.memories.length} memories)`,
          ok: true,
        });
        return makeRpcResult(msg.id, {
          content: [{ type: 'text', text: JSON.stringify(ctx, null, 2) }],
        });
      }

      if (toolName === 'save_jarvis_memory') {
        const category = ['identity', 'preference', 'project', 'fact'].includes(String(args.category))
          ? String(args.category)
          : 'fact';
        const key = String(args.key || '').trim();
        const content = String(args.content || '').trim();
        if (!key || !content) {
          return makeRpcResult(msg.id, {
            isError: true,
            content: [{ type: 'text', text: 'key and content are required.' }],
          });
        }
        const actionPayload = {
          name: 'save_memory',
          args: { category, key, content },
        };
        broadcastHudEvent('hud_action', actionPayload);
        runtimeHandlers.onHudAction?.(actionPayload);
        hudSnapshot.memories = [
          { category, key, content },
          ...hudSnapshot.memories.filter((m) => m.key !== key),
        ].slice(0, 60);
        recordActivity({
          client: meta.client,
          transport: meta.transport,
          method: 'tools/call:save_jarvis_memory',
          summary: `Saved memory [${category}] ${key}`,
          ok: true,
        });
        return makeRpcResult(msg.id, {
          content: [{ type: 'text', text: JSON.stringify({ saved: true, category, key, content }) }],
        });
      }

      if (toolName === 'ask_jarvis') {
        const prompt = String(args.prompt || '').trim();
        if (!prompt) {
          return makeRpcResult(msg.id, {
            isError: true,
            content: [{ type: 'text', text: 'prompt is required.' }],
          });
        }
        const result = await runtimeHandlers.askJarvis(prompt);
        recordActivity({
          client: meta.client,
          transport: meta.transport,
          method: 'tools/call:ask_jarvis',
          summary: `Tested JARVIS: "${prompt.slice(0, 48)}"`,
          ok: true,
        });
        return makeRpcResult(msg.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  prompt,
                  jarvisReply: result.reply,
                  appliedTrainingLessons: getEnabledTrainingLessons().length,
                  sources: result.sources || [],
                },
                null,
                2
              ),
            },
          ],
        });
      }

      if (toolName === 'create_jarvis_routine') {
        const actionPayload = {
          name: 'create_routine',
          args: {
            name: String(args.name || 'Claude Routine'),
            kind: String(args.kind || 'prompt'),
            triggerType: String(args.triggerType || 'time'),
            scheduleText: String(args.scheduleText || 'Daily'),
            text: String(args.text || ''),
          },
        };
        broadcastHudEvent('hud_action', actionPayload);
        runtimeHandlers.onHudAction?.(actionPayload);
        recordActivity({
          client: meta.client,
          transport: meta.transport,
          method: 'tools/call:create_jarvis_routine',
          summary: `Created routine "${actionPayload.args.name}"`,
          ok: true,
        });
        return makeRpcResult(msg.id, {
          content: [{ type: 'text', text: JSON.stringify({ created: true, routine: actionPayload.args }) }],
        });
      }

      if (toolName === 'build_pptx_presentation') {
        if (!runtimeHandlers.buildPptx) {
          return makeRpcResult(msg.id, {
            isError: true,
            content: [{ type: 'text', text: 'PPTX builder not registered.' }],
          });
        }
        const deck = await runtimeHandlers.buildPptx({
          prompt: String(args.prompt || ''),
          title: typeof args.title === 'string' ? args.title : undefined,
          theme: typeof args.theme === 'string' ? args.theme : undefined,
        });
        broadcastHudEvent('hud_action', { name: 'open_pptx_studio', args: { deck } });
        recordActivity({
          client: meta.client,
          transport: meta.transport,
          method: 'tools/call:build_pptx_presentation',
          summary: `Built PPTX: ${String(deck.title || args.title || 'Deck')}`,
          ok: true,
        });
        return makeRpcResult(msg.id, {
          content: [{ type: 'text', text: JSON.stringify({ status: 'built', deck }, null, 2) }],
        });
      }

      if (toolName === 'build_fullstack_app') {
        if (!runtimeHandlers.buildCodeApp) {
          return makeRpcResult(msg.id, {
            isError: true,
            content: [{ type: 'text', text: 'Code Studio builder not registered.' }],
          });
        }
        const project = await runtimeHandlers.buildCodeApp({
          prompt: String(args.prompt || ''),
          title: typeof args.title === 'string' ? args.title : undefined,
        });
        broadcastHudEvent('hud_action', { name: 'open_code_studio', args: { project } });
        recordActivity({
          client: meta.client,
          transport: meta.transport,
          method: 'tools/call:build_fullstack_app',
          summary: `Built Node.js App: ${String(project.title || args.title || 'App')}`,
          ok: true,
        });
        return makeRpcResult(msg.id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'running',
                  title: project.title,
                  filesCount: Array.isArray(project.files) ? project.files.length : 0,
                },
                null,
                2
              ),
            },
          ],
        });
      }

      return makeRpcError(msg.id, -32601, `Unknown tool: ${toolName}`);
    }

    if (method === 'resources/list') {
      return makeRpcResult(msg.id, { resources: MCP_RESOURCES });
    }

    if (method === 'resources/read') {
      const uri = String(params.uri || '');
      if (uri === 'jarvis://training/lessons') {
        return makeRpcResult(msg.id, {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(state.lessons, null, 2),
            },
          ],
        });
      }
      if (uri === 'jarvis://memory/snapshot') {
        return makeRpcResult(msg.id, {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(hudSnapshot, null, 2),
            },
          ],
        });
      }
      if (uri === 'jarvis://chat/recent') {
        return makeRpcResult(msg.id, {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(hudSnapshot.recentMessages, null, 2),
            },
          ],
        });
      }
      return makeRpcError(msg.id, -32002, `Resource not found: ${uri}`);
    }

    if (method === 'prompts/list') {
      return makeRpcResult(msg.id, { prompts: MCP_PROMPTS });
    }

    if (method === 'prompts/get') {
      const name = String(params.name || '');
      const promptArgs = (params.arguments || {}) as Record<string, unknown>;
      if (name === 'train_jarvis_skill') {
        const topic = String(promptArgs.topic || 'general assistance');
        return makeRpcResult(msg.id, {
          description: `Train J.A.R.V.I.S. on ${topic}`,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Please inspect J.A.R.V.I.S. using get_jarvis_context and list_jarvis_lessons, then teach J.A.R.V.I.S. comprehensive skills, behavior rules, and Q&A examples for "${topic}" using teach_jarvis_batch. Finally verify learning with ask_jarvis.`,
              },
            },
          ],
        });
      }
      if (name === 'audit_and_correct_jarvis') {
        return makeRpcResult(msg.id, {
          description: 'Audit recent J.A.R.V.I.S. logs and teach corrections',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: 'Read jarvis://chat/recent and list_jarvis_lessons, identify any mistakes or style issues, and call teach_jarvis with kind="correction" to improve J.A.R.V.I.S.',
              },
            },
          ],
        });
      }
      return makeRpcError(msg.id, -32602, `Prompt not found: ${name}`);
    }

    return makeRpcError(msg.id, -32601, `Method not found: ${method}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    recordActivity({
      client: meta.client,
      transport: meta.transport,
      method,
      summary: `Error: ${errMsg.slice(0, 100)}`,
      ok: false,
    });
    return makeRpcError(msg.id, -32603, errMsg);
  }
}

function setMcpCorsHeaders(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, x-mcp-token');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function isAuthorizedMcpRequest(req: Request): boolean {
  if (!state.requireAuth) return true;
  const authHeader = String(req.headers.authorization || '');
  const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const xToken = typeof req.headers['x-mcp-token'] === 'string' ? req.headers['x-mcp-token'].trim() : '';
  const qToken = typeof req.query.token === 'string' ? req.query.token.trim() : '';
  const supplied = bearer || xToken || qToken;
  return Boolean(supplied && supplied === state.token);
}

function inferClientName(req: Request): string {
  const ua = String(req.headers['user-agent'] || '');
  if (/claude/i.test(ua)) return 'Claude AI';
  if (/mcp-remote/i.test(ua)) return 'Claude Desktop (mcp-remote)';
  if (/node/i.test(ua)) return 'Claude Desktop (Bridge)';
  return ua ? ua.slice(0, 32) : 'MCP Client';
}

export async function handleMcpHttpOptions(_req: Request, res: Response): Promise<void> {
  setMcpCorsHeaders(res);
  res.status(204).end();
}

// Streamable HTTP MCP Endpoint (POST /api/mcp, GET /api/mcp, DELETE /api/mcp)
export async function handleMcpStreamableHttp(req: Request, res: Response): Promise<void> {
  setMcpCorsHeaders(res);
  if (!isAuthorizedMcpRequest(req)) {
    res.status(401).json(makeRpcError(null, -32001, 'Unauthorized MCP request. Provide Authorization: Bearer <token>.'));
    return;
  }

  const clientLabel = inferClientName(req);

  if (req.method === 'GET') {
    const accept = String(req.headers.accept || '').toLowerCase();
    if (!accept.includes('text/event-stream')) {
      res.status(200).json({
        ok: true,
        server: 'jarvis-mark-lvii-mcp',
        protocol: 'MCP JSON-RPC 2.0',
        protocolVersion: PROTOCOL_VERSION,
        requireAuth: state.requireAuth,
        endpoints: {
          streamableHttp: '/api/mcp',
          legacySse: '/api/mcp/sse',
        },
        tools: MCP_TOOLS.map((t) => t.name),
      });
      return;
    }

    const sessionId =
      typeof req.headers['mcp-session-id'] === 'string' && req.headers['mcp-session-id'].trim()
        ? req.headers['mcp-session-id'].trim()
        : makeId('mcp');
    streamableSessions.set(sessionId, { id: sessionId, clientName: clientLabel, createdAt: Date.now() });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Mcp-Session-Id', sessionId);
    res.flushHeaders?.();
    res.write(': connected to J.A.R.V.I.S. MCP Streamable HTTP\n\n');

    const hb = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(hb);
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(hb);
      streamableSessions.delete(sessionId);
    });
    return;
  }

  if (req.method === 'DELETE') {
    const sid = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : '';
    if (sid) streamableSessions.delete(sid);
    res.status(200).json({ closed: true });
    return;
  }

  // POST JSON-RPC 2.0
  const incomingSid =
    typeof req.headers['mcp-session-id'] === 'string' && req.headers['mcp-session-id'].trim()
      ? req.headers['mcp-session-id'].trim()
      : makeId('mcp');
  res.setHeader('Mcp-Session-Id', incomingSid);
  if (!streamableSessions.has(incomingSid)) {
    streamableSessions.set(incomingSid, { id: incomingSid, clientName: clientLabel, createdAt: Date.now() });
  }

  const body = req.body;
  if (!body || (typeof body !== 'object' && !Array.isArray(body))) {
    res.status(400).json(makeRpcError(null, -32700, 'Invalid JSON-RPC payload.'));
    return;
  }

  if (Array.isArray(body)) {
    const results: Array<Record<string, unknown>> = [];
    for (const item of body) {
      const out = await handleJsonRpcMessage(item as JsonRpcRequest, {
        client: clientLabel,
        transport: 'http',
      });
      if (out) results.push(out);
    }
    if (results.length === 0) {
      res.status(202).end();
      return;
    }
    res.status(200).json(results);
    return;
  }

  const responsePayload = await handleJsonRpcMessage(body as JsonRpcRequest, {
    client: clientLabel,
    transport: 'http',
  });
  if (!responsePayload) {
    res.status(202).end();
    return;
  }
  res.status(200).json(responsePayload);
}

// Legacy SSE Transport (GET /api/mcp/sse + POST /api/mcp/messages)
export function handleMcpLegacySse(req: Request, res: Response): void {
  setMcpCorsHeaders(res);
  if (!isAuthorizedMcpRequest(req)) {
    res.status(401).json(makeRpcError(null, -32001, 'Unauthorized MCP SSE request.'));
    return;
  }

  const sessionId = makeId('sse');
  const clientName = inferClientName(req);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseSessions.set(sessionId, {
    id: sessionId,
    res,
    clientName,
    createdAt: Date.now(),
  });

  const qToken = typeof req.query.token === 'string' && req.query.token ? `&token=${encodeURIComponent(req.query.token)}` : '';
  res.write(`event: endpoint\ndata: /api/mcp/messages?sessionId=${encodeURIComponent(sessionId)}${qToken}\n\n`);

  recordActivity({
    client: clientName,
    transport: 'sse',
    method: 'sse/connect',
    summary: 'Opened legacy MCP SSE stream',
    ok: true,
  });

  const hb = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(hb);
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(hb);
    sseSessions.delete(sessionId);
  });
}

export async function handleMcpLegacyMessages(req: Request, res: Response): Promise<void> {
  setMcpCorsHeaders(res);
  if (!isAuthorizedMcpRequest(req)) {
    res.status(401).json(makeRpcError(null, -32001, 'Unauthorized MCP message request.'));
    return;
  }

  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
  const session = sseSessions.get(sessionId);
  if (!session) {
    res.status(404).json(makeRpcError(null, -32000, 'SSE session not found or expired.'));
    return;
  }

  const body = req.body as JsonRpcRequest;
  const reply = await handleJsonRpcMessage(body, {
    client: session.clientName,
    transport: 'sse',
  });

  if (reply) {
    try {
      session.res.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
    } catch {
      sseSessions.delete(sessionId);
    }
  }

  res.status(202).send('Accepted');
}

// HUD Live Event Stream (GET /api/mcp/events)
export function handleHudMcpEvents(req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  hudEventClients.add(res);
  res.write(`event: mcp_state\ndata: ${JSON.stringify(getMcpPublicState())}\n\n`);

  const hb = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(hb);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(hb);
    hudEventClients.delete(res);
  });
}

// Direct HUD-triggered JSON-RPC test call
export async function runMcpConsoleCall(method: string, params?: Record<string, unknown>) {
  return await handleJsonRpcMessage(
    {
      jsonrpc: '2.0',
      id: Date.now(),
      method,
      params,
    },
    { client: 'HUD Inspector', transport: 'hud' }
  );
}

// Generates a zero-dependency Node.js stdio MCP bridge for Claude Desktop
export function buildClaudeStdioBridgeScript(serverBaseUrl: string): string {
  const cleanUrl = serverBaseUrl.replace(/\/+$/, '');
  return `#!/usr/bin/env node
/**
 * J.A.R.V.I.S. Mark LVII — Claude Desktop MCP Stdio Bridge
 * Usage in claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "jarvis": {
 *       "command": "node",
 *       "args": ["/path/to/jarvis-mcp-bridge.mjs"]
 *     }
 *   }
 * }
 */
import readline from 'node:readline';

const JARVIS_MCP_URL = process.env.JARVIS_MCP_URL || '${cleanUrl}/api/mcp';
const JARVIS_MCP_TOKEN = process.env.JARVIS_MCP_TOKEN || '${state.token}';

let sessionId = '';

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

async function forwardJsonRpc(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + JARVIS_MCP_TOKEN,
    'User-Agent': 'claude-desktop-stdio-bridge/1.0',
  };
  if (sessionId) {
    headers['Mcp-Session-Id'] = sessionId;
  }

  try {
    const res = await fetch(JARVIS_MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(parsed),
    });
    const nextSid = res.headers.get('mcp-session-id');
    if (nextSid) sessionId = nextSid;

    if (res.status === 202 || res.status === 204) return;
    const text = await res.text();
    if (text && text.trim()) {
      process.stdout.write(text.trim() + '\\n');
    }
  } catch (err) {
    if (parsed && parsed.id !== undefined && parsed.id !== null) {
      const errResp = {
        jsonrpc: '2.0',
        id: parsed.id,
        error: {
          code: -32000,
          message: err instanceof Error ? err.message : String(err),
        },
      };
      process.stdout.write(JSON.stringify(errResp) + '\\n');
    }
  }
}

rl.on('line', (line) => {
  void forwardJsonRpc(line);
});
`;
}
