import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import type { Request, Response } from 'express';

export interface CodeFile {
  path: string;
  language: string;
  content: string;
}

export interface CodeProject {
  id: string;
  title: string;
  projectName: string;
  entryFile: string;
  files: CodeFile[];
  status: 'stopped' | 'starting' | 'running' | 'error';
  port: number | null;
  logs: string[];
  error?: string;
  updatedAt: string;
}

const SANDBOX_ROOT = '/tmp/jarvis-sandbox';

let activeChild: ChildProcess | null = null;
let activeProject: CodeProject | null = null;

function pushLog(project: CodeProject, line: string) {
  const clean = line.replace(/\r/g, '');
  for (const part of clean.split('\n')) {
    if (!part.trim()) continue;
    project.logs.push(part);
    if (project.logs.length > 200) {
      project.logs.shift();
    }
  }
}

function sanitizeRelativePath(rawPath: string): string | null {
  const normalized = String(rawPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .trim();
  if (!normalized || normalized.includes('..') || normalized.startsWith('node_modules')) {
    return null;
  }
  return normalized;
}

function inferLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'javascript';
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.html') return 'html';
  if (ext === '.css') return 'css';
  if (ext === '.json') return 'json';
  return 'text';
}

function stripOuterCodeFences(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
  return match ? match[1] : content;
}

export function parseCodeProjectJson(
  rawText: string,
  fallbackTitle = 'Node.js Full-Stack App'
): {
  title: string;
  projectName: string;
  entryFile: string;
  files: CodeFile[];
} {
  let cleaned = String(rawText || '').trim();
  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    cleaned = fenced[1].trim();
  } else {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }
  }

  const parsed = JSON.parse(cleaned) as {
    title?: string;
    projectName?: string;
    entryFile?: string;
    files?: Array<{ path?: string; language?: string; content?: string }>;
  };

  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error('Generated project contained no files.');
  }

  const files: CodeFile[] = [];
  const seen = new Set<string>();
  for (const item of parsed.files) {
    const safePath = sanitizeRelativePath(item?.path || '');
    if (!safePath || seen.has(safePath)) continue;
    seen.add(safePath);
    files.push({
      path: safePath,
      language: item?.language ? String(item.language) : inferLanguage(safePath),
      content: stripOuterCodeFences(String(item?.content || '')),
    });
  }

  if (files.length === 0) {
    throw new Error('No valid files found in generated project.');
  }

  const entryCandidate = sanitizeRelativePath(parsed.entryFile || 'server.js') || 'server.js';
  const entryFile =
    files.find((f) => f.path === entryCandidate)?.path ||
    files.find((f) => /^(server|index|app)\.(js|mjs|cjs)$/.test(f.path))?.path ||
    files.find((f) => f.path.endsWith('.js'))?.path ||
    files[0].path;

  const title = String(parsed.title || fallbackTitle).trim().slice(0, 80) || fallbackTitle;
  const projectName =
    String(parsed.projectName || title)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'jarvis-node-app';

  return { title, projectName, entryFile, files };
}

async function findFreeSandboxPort(start = 4210, end = 4290): Promise<number> {
  for (let p = start; p <= end; p++) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(p, '127.0.0.1');
    });
    if (ok) return p;
  }
  throw new Error('No available sandbox port.');
}

async function waitForPortReady(port: number, child: ChildProcess, timeoutMs = 4500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    const connected = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
      sock.setTimeout(350, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (connected) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return false;
}

export async function stopCodeSandbox(): Promise<void> {
  const child = activeChild;
  activeChild = null;
  if (child && child.exitCode === null) {
    try {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 250));
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    } catch {
      // Ignore already exited child
    }
  }
  if (activeProject) {
    activeProject.status = 'stopped';
    activeProject.port = null;
  }
}

export function getCodeSandboxState(): CodeProject | null {
  return activeProject;
}

export async function startCodeSandbox(input: {
  title: string;
  projectName: string;
  entryFile: string;
  files: CodeFile[];
}): Promise<CodeProject> {
  await stopCodeSandbox();

  const id = `app_${Date.now()}`;
  const projectDir = path.join(SANDBOX_ROOT, id);

  try {
    if (fs.existsSync(SANDBOX_ROOT)) {
      for (const old of fs.readdirSync(SANDBOX_ROOT)) {
        fs.rmSync(path.join(SANDBOX_ROOT, old), { recursive: true, force: true });
      }
    }
  } catch {
    // Ignore stale cleanup failures
  }

  fs.mkdirSync(projectDir, { recursive: true });

  const normalizedFiles: CodeFile[] = [];
  for (const f of input.files) {
    const rel = sanitizeRelativePath(f.path);
    if (!rel) continue;
    const abs = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, 'utf8');
    normalizedFiles.push({
      path: rel,
      language: f.language || inferLanguage(rel),
      content: f.content,
    });
  }

  const pkgPath = path.join(projectDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    const pkgJson = JSON.stringify(
      {
        name: input.projectName || 'jarvis-node-app',
        version: '1.0.0',
        main: input.entryFile,
        scripts: { start: `node ${input.entryFile}` },
        dependencies: { express: '^4.21.2' },
      },
      null,
      2
    );
    fs.writeFileSync(pkgPath, pkgJson, 'utf8');
    normalizedFiles.push({ path: 'package.json', language: 'json', content: pkgJson });
  }

  const hostNodeModules = path.join(process.cwd(), 'node_modules');
  const sandboxNodeModules = path.join(projectDir, 'node_modules');
  if (fs.existsSync(hostNodeModules) && !fs.existsSync(sandboxNodeModules)) {
    try {
      fs.symlinkSync(hostNodeModules, sandboxNodeModules, 'junction');
    } catch {
      // Ignore symlink errors if not supported
    }
  }

  const port = await findFreeSandboxPort();
  const project: CodeProject = {
    id,
    title: input.title,
    projectName: input.projectName,
    entryFile: input.entryFile,
    files: normalizedFiles,
    status: 'starting',
    port,
    logs: [`[Node.js ${process.version}] Starting ${input.entryFile} on port ${port}...`],
    updatedAt: new Date().toISOString(),
  };
  activeProject = project;

  const entryAbs = path.join(projectDir, input.entryFile);
  if (!fs.existsSync(entryAbs)) {
    project.status = 'error';
    project.error = `Entry file "${input.entryFile}" not found.`;
    pushLog(project, `ERROR: ${project.error}`);
    return project;
  }

  const child = spawn(process.execPath, [input.entryFile], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      NODE_PATH: hostNodeModules,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChild = child;

  child.stdout?.on('data', (chunk: Buffer) => {
    pushLog(project, chunk.toString('utf8'));
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    pushLog(project, chunk.toString('utf8'));
  });
  child.on('exit', (code, signal) => {
    if (activeChild === child) {
      activeChild = null;
      if (project.status === 'running' || project.status === 'starting') {
        project.status = code === 0 ? 'stopped' : 'error';
        project.error = code ? `Process exited with code ${code}` : signal ? `Signal ${signal}` : undefined;
      }
    }
    pushLog(project, `[Process exited: code=${code ?? 'null'} signal=${signal ?? 'none'}]`);
  });

  const ready = await waitForPortReady(port, child);
  if (ready) {
    project.status = 'running';
    pushLog(project, `[Ready] Live preview mounted at /api/code/preview/`);
  } else {
    project.status = 'error';
    project.error =
      project.logs.slice(-4).join(' | ') || `Server failed to bind port ${port}.`;
  }
  project.updatedAt = new Date().toISOString();
  return project;
}

const PREVIEW_SHIM = `<base href="/api/code/preview/">
<script>
(function(){
  var origFetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string' && input.startsWith('/') && !input.startsWith('//') && !input.startsWith('/api/code/preview')) {
      input = '/api/code/preview' + input;
    }
    return origFetch.call(this, input, init);
  };
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/api/code/preview')) {
      arguments[1] = '/api/code/preview' + url;
    }
    return origOpen.apply(this, arguments);
  };
})();
</script>`;

export function proxyCodeSandboxRequest(req: Request, res: Response) {
  if (!activeProject || activeProject.status !== 'running' || !activeProject.port) {
    return res
      .status(503)
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      .send(
        `<!doctype html><html><body style="margin:0;background:#070d16;color:#93c5fd;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;"><div>Node.js sandbox server is not running. Click Run to start.</div></body></html>`
      );
  }

  const rawOriginal = req.originalUrl || req.url || '/';
  let targetPath = rawOriginal.replace(/^\/api\/code\/preview/, '') || '/';
  if (!targetPath.startsWith('/')) targetPath = `/${targetPath}`;

  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  delete headers['accept-encoding'];

  const isJsonOrBody =
    req.method !== 'GET' &&
    req.method !== 'HEAD' &&
    req.body !== undefined &&
    Object.keys(req.body || {}).length > 0;

  let bodyBuf: Buffer | null = null;
  if (isJsonOrBody) {
    if (Buffer.isBuffer(req.body)) {
      bodyBuf = req.body;
    } else if (typeof req.body === 'string') {
      bodyBuf = Buffer.from(req.body, 'utf8');
    } else {
      bodyBuf = Buffer.from(JSON.stringify(req.body), 'utf8');
      headers['content-type'] = 'application/json';
    }
    headers['content-length'] = String(bodyBuf.length);
  }

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: activeProject.port,
      path: targetPath,
      method: req.method,
      headers,
      timeout: 12000,
    },
    (proxyRes) => {
      const contentType = String(proxyRes.headers['content-type'] || '');
      const status = proxyRes.statusCode || 200;

      if (contentType.includes('text/html')) {
        const chunks: Buffer[] = [];
        proxyRes.on('data', (c: Buffer) => chunks.push(c));
        proxyRes.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8');
          if (/<head[^>]*>/i.test(html)) {
            html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${PREVIEW_SHIM}`);
          } else {
            html = `${PREVIEW_SHIM}\n${html}`;
          }
          res.status(status);
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            const lk = k.toLowerCase();
            if (lk === 'content-length' || lk === 'content-encoding' || lk === 'transfer-encoding') continue;
            if (v !== undefined) res.setHeader(k, v);
          }
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.send(html);
        });
      } else {
        res.status(status);
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          const lk = k.toLowerCase();
          if (lk === 'transfer-encoding') continue;
          if (v !== undefined) res.setHeader(k, v);
        }
        proxyRes.pipe(res);
      }
    }
  );

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: `Preview proxy error: ${err.message}` });
    }
  });

  if (bodyBuf) {
    proxyReq.write(bodyBuf);
  }
  proxyReq.end();
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildProjectZipBuffer(project: CodeProject): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of project.files) {
    const nameBuf = Buffer.from(file.path, 'utf8');
    const dataBuf = Buffer.from(file.content, 'utf8');
    const crc = crc32(dataBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, dataBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + dataBuf.length;
  }

  const centralSize = centralParts.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(project.files.length, 8);
  eocd.writeUInt16LE(project.files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}
