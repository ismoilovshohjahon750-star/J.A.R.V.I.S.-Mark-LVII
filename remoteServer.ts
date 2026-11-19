import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import WebSocket from 'ws';

export interface RemoteServerConfig {
  url: string;
  username: string;
  password: string;
}

export interface RemoteProcessInfo {
  name: string;
  pid: number;
  memMB: number;
}

export interface RemoteServerStatus {
  online: boolean;
  configured: boolean;
  url: string;
  checkedAt: string;
  latencyMs: number;
  platform: 'windows' | 'linux' | 'unknown';
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
  topProcesses: RemoteProcessInfo[];
  deployedApp?: {
    exists: boolean;
    path: string;
    built: boolean;
    running: boolean;
    port: number;
  };
  error?: string;
}

const CONFIG_PATH = path.resolve(process.cwd(), '.server-config.json');

let cachedStatus: { ts: number; data: RemoteServerStatus } | null = null;
let inFlightQuery: Promise<RemoteServerStatus> | null = null;

function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

export function loadRemoteServerConfig(): RemoteServerConfig | null {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Partial<RemoteServerConfig>;
      if (parsed.url) {
        return {
          url: normalizeBaseUrl(parsed.url),
          username: String(parsed.username || ''),
          password: String(parsed.password || ''),
        };
      }
    }
  } catch {
    // Fall back to env vars
  }

  const envUrl = normalizeBaseUrl(process.env.REMOTE_SERVER_URL || '');
  if (!envUrl) return null;
  return {
    url: envUrl,
    username: String(process.env.REMOTE_SERVER_USER || ''),
    password: String(process.env.REMOTE_SERVER_PASS || ''),
  };
}

export function getRemoteServerPublicConfig() {
  const cfg = loadRemoteServerConfig();
  return {
    configured: Boolean(cfg?.url),
    url: cfg?.url || '',
    username: cfg?.username || '',
    hasPassword: Boolean(cfg?.password),
  };
}

export function saveRemoteServerConfig(input: {
  url: string;
  username?: string;
  password?: string;
}) {
  const existing = loadRemoteServerConfig();
  const normalizedUrl = normalizeBaseUrl(input.url);
  if (!normalizedUrl) {
    throw new Error('Server URL is required.');
  }
  const next: RemoteServerConfig = {
    url: normalizedUrl,
    username: (input.username ?? existing?.username ?? '').trim(),
    password:
      input.password !== undefined && input.password !== ''
        ? input.password
        : existing?.password || '',
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  cachedStatus = null;
  return getRemoteServerPublicConfig();
}

function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[=>]/g, '')
    .replace(/\r/g, '');
}

async function fetchTtydToken(cfg: RemoteServerConfig): Promise<{ token: string; authHeader?: string }> {
  const headers: Record<string, string> = {};
  let authHeader: string | undefined;
  if (cfg.username || cfg.password) {
    const encoded = Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64');
    authHeader = `Basic ${encoded}`;
    headers.Authorization = authHeader;
  }
  const res = await fetch(`${cfg.url}/token`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} while authenticating with ${cfg.url}`);
  }
  const json = (await res.json()) as { token?: string };
  return { token: String(json.token || ''), authHeader };
}

export async function runTtydSession<T>(
  cfg: RemoteServerConfig,
  handler: (ctx: {
    platform: 'windows' | 'linux';
    sendLine: (cmd: string) => void;
    waitForMarker: (marker: string, timeoutMs?: number) => Promise<string>;
    getCleanBuffer: () => string;
  }) => Promise<T>,
  connectTimeoutMs = 10000,
  sessionTimeoutMs = 30000
): Promise<T> {
  const { token, authHeader } = await fetchTtydToken(cfg);
  const wsUrl = `${cfg.url.replace(/^http/i, 'ws')}/ws`;

  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, 'tty', {
      headers: authHeader ? { Authorization: authHeader } : undefined,
      handshakeTimeout: connectTimeoutMs,
    });

    let rawBuf = '';
    let settled = false;
    let started = false;

    const cleanup = () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };

    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const timer = setTimeout(
      () => fail(new Error('Remote terminal session timed out.')),
      connectTimeoutMs + sessionTimeoutMs
    );

    const listeners: Array<() => void> = [];

    ws.on('open', () => {
      ws.send(JSON.stringify({ AuthToken: token, columns: 220, rows: 48 }));
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      fail(err);
    });

    ws.on('close', () => {
      if (!settled) {
        clearTimeout(timer);
        fail(new Error('Remote terminal WebSocket closed unexpectedly.'));
      }
    });

    ws.on('message', (data: WebSocket.RawData) => {
      const u8 = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);
      if (u8.length > 0 && u8[0] === 48) {
        rawBuf += u8.subarray(1).toString('utf8');
        for (const fn of [...listeners]) fn();

        if (!started) {
          const clean = stripAnsi(rawBuf);
          const isWin = clean.includes('Microsoft Windows') || /[A-Za-z]:\\/.test(clean);
          const isPromptReady = isWin
            ? /[A-Za-z]:\\[^>]*>\s*$/.test(clean)
            : /[$#]\s*$/.test(clean);

          if (isPromptReady) {
            started = true;
            const platform: 'windows' | 'linux' = isWin ? 'windows' : 'linux';

            const ctx = {
              platform,
              sendLine: (cmd: string) => {
                const eol = platform === 'windows' ? '\r' : '\n';
                ws.send('0' + cmd + eol);
              },
              getCleanBuffer: () => stripAnsi(rawBuf),
              waitForMarker: (marker: string, waitMs = 14000) =>
                new Promise<string>((resWait, rejWait) => {
                  const check = () => {
                    const text = stripAnsi(rawBuf);
                    const idx = text.indexOf(marker);
                    if (idx !== -1) {
                      const pos = listeners.indexOf(check);
                      if (pos !== -1) listeners.splice(pos, 1);
                      clearTimeout(t);
                      resWait(text);
                    }
                  };
                  const t = setTimeout(() => {
                    const pos = listeners.indexOf(check);
                    if (pos !== -1) listeners.splice(pos, 1);
                    rejWait(new Error(`Timed out waiting for marker ${marker}`));
                  }, waitMs);
                  listeners.push(check);
                  check();
                }),
            };

            handler(ctx)
              .then((result) => {
                if (!settled) {
                  settled = true;
                  clearTimeout(timer);
                  cleanup();
                  resolve(result);
                }
              })
              .catch((err) => {
                clearTimeout(timer);
                fail(err);
              });
          }
        }
      }
    });
  });
}

export async function queryRemoteServer(options?: {
  force?: boolean;
  includeProcesses?: boolean;
}): Promise<RemoteServerStatus> {
  const cfg = loadRemoteServerConfig();
  if (!cfg) {
    return {
      online: false,
      configured: false,
      url: '',
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
      platform: 'unknown',
      hostname: 'Unconfigured',
      os: 'Unknown',
      cpuName: 'Unknown',
      cpuPct: 0,
      totalMemMB: 0,
      usedMemMB: 0,
      freeMemMB: 0,
      memPct: 0,
      diskUsedGB: 0,
      diskFreeGB: 0,
      diskPct: 0,
      uptimeMinutes: 0,
      topProcesses: [],
      error: 'No remote server configured.',
    };
  }

  const now = Date.now();
  if (!options?.force && cachedStatus && now - cachedStatus.ts < 8000) {
    return cachedStatus.data;
  }
  if (!options?.force && inFlightQuery) {
    return inFlightQuery;
  }

  const run = (async (): Promise<RemoteServerStatus> => {
    const startMs = Date.now();
    try {
      const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
      const startTag = `__JS_${rand}__`;
      const endTag = `__JE_${rand}__`;

      const status = await runTtydSession(cfg, async (ctx) => {
        if (ctx.platform === 'windows') {
          const psScript = [
            `$o=Get-CimInstance Win32_OperatingSystem`,
            `$c=Get-CimInstance Win32_Processor | Select-Object -First 1`,
            `$d=Get-PSDrive C`,
            `$tot=[math]::Round($o.TotalVisibleMemorySize/1024)`,
            `$free=[math]::Round($o.FreePhysicalMemory/1024)`,
            `$used=[math]::Max(0,$tot-$free)`,
            `$dUsed=[math]::Round($d.Used/1GB,1)`,
            `$dFree=[math]::Round($d.Free/1GB,1)`,
            `$dTot=[math]::Max(0.1,$dUsed+$dFree)`,
            `$procs=@(Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 6 | ForEach-Object {@{name=$_.ProcessName;pid=$_.Id;memMB=[math]::Round($_.WorkingSet64/1MB)}})`,
            `$nv=(node -v 2>$null); if(-not $nv){$nv=''}`,
            `$appDir=Join-Path (Get-Location).Path 'jarvis-mark-lvii'`,
            `$appExists=Test-Path $appDir`,
            `$appBuilt=Test-Path (Join-Path $appDir 'dist\\index.html')`,
            `$portUp=[bool](Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)`,
            `$res=@{host=$env:COMPUTERNAME;os=$o.Caption;cpuName=$c.Name;cpuPct=[int]$c.LoadPercentage;totalMemMB=$tot;usedMemMB=$used;freeMemMB=$free;memPct=[math]::Round(($used/[math]::Max(1,$tot))*100);diskUsedGB=$dUsed;diskFreeGB=$dFree;diskPct=[math]::Round(($dUsed/$dTot)*100);uptimeMin=[math]::Round(((Get-Date)-$o.LastBootUpTime).TotalMinutes);nodeVersion="$nv";topProcesses=$procs;deployedApp=@{exists=$appExists;path=$appDir;built=$appBuilt;running=$portUp;port=3000}}`,
            `Write-Output ('__JS_'+'${rand}__')`,
            `Write-Output ($res | ConvertTo-Json -Depth 4 -Compress)`,
            `Write-Output ('__JE_'+'${rand}__')`,
          ].join(';');

          ctx.sendLine(`powershell -NoProfile -Command "${psScript}"`);
        } else {
          const shCmd = [
            `printf '__JS_%s__\\n' '${rand}'`,
            `node -e "const os=require('os'),fs=require('fs'),{execSync}=require('child_process');let dUsed=0,dFree=0;try{const df=execSync('df -BG / | tail -1').toString().trim().split(/\\s+/);dUsed=parseFloat(df[2])||0;dFree=parseFloat(df[3])||0;}catch{};let procs=[];try{procs=execSync('ps -eo comm,pid,rss --sort=-rss | head -7').toString().trim().split('\\n').slice(1).map(l=>{const p=l.trim().split(/\\s+/);return{name:p[0],pid:Number(p[1]),memMB:Math.round((Number(p[2])||0)/1024)}})}catch{};const tot=Math.round(os.totalmem()/1048576),free=Math.round(os.freemem()/1048576),used=tot-free;console.log(JSON.stringify({host:os.hostname(),os:os.type()+' '+os.release(),cpuName:(os.cpus()[0]||{}).model||'CPU',cpuPct:Math.min(100,Math.round((os.loadavg()[0]/Math.max(1,os.cpus().length))*100)),totalMemMB:tot,usedMemMB:used,freeMemMB:free,memPct:Math.round((used/Math.max(1,tot))*100),diskUsedGB:dUsed,diskFreeGB:dFree,diskPct:Math.round((dUsed/Math.max(1,dUsed+dFree))*100),uptimeMin:Math.round(os.uptime()/60),nodeVersion:process.version,topProcesses:procs}));"`,
            `printf '__JE_%s__\\n' '${rand}'`,
          ].join('; ');
          ctx.sendLine(shCmd);
        }

        const out = await ctx.waitForMarker(endTag, 15000);
        const sIdx = out.indexOf(startTag);
        const eIdx = out.indexOf(endTag);
        const slice = sIdx !== -1 && eIdx > sIdx ? out.slice(sIdx + startTag.length, eIdx) : out;
        const jsonMatch = slice.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('Could not parse server telemetry JSON output.');
        }
        const parsed = JSON.parse(jsonMatch[0]) as {
          host?: string;
          os?: string;
          cpuName?: string;
          cpuPct?: number;
          totalMemMB?: number;
          usedMemMB?: number;
          freeMemMB?: number;
          memPct?: number;
          diskUsedGB?: number;
          diskFreeGB?: number;
          diskPct?: number;
          uptimeMin?: number;
          nodeVersion?: string;
          topProcesses?: RemoteProcessInfo[];
          deployedApp?: {
            exists: boolean;
            path: string;
            built: boolean;
            running: boolean;
            port: number;
          };
        };

        return {
          online: true,
          configured: true,
          url: cfg.url,
          checkedAt: new Date().toISOString(),
          latencyMs: Date.now() - startMs,
          platform: ctx.platform,
          hostname: parsed.host || 'Remote Host',
          os: parsed.os || ctx.platform,
          cpuName: (parsed.cpuName || 'CPU').trim(),
          cpuPct: Number(parsed.cpuPct ?? 0),
          totalMemMB: Number(parsed.totalMemMB ?? 0),
          usedMemMB: Number(parsed.usedMemMB ?? 0),
          freeMemMB: Number(parsed.freeMemMB ?? 0),
          memPct: Number(parsed.memPct ?? 0),
          diskUsedGB: Number(parsed.diskUsedGB ?? 0),
          diskFreeGB: Number(parsed.diskFreeGB ?? 0),
          diskPct: Number(parsed.diskPct ?? 0),
          uptimeMinutes: Number(parsed.uptimeMin ?? 0),
          nodeVersion: parsed.nodeVersion || undefined,
          topProcesses: Array.isArray(parsed.topProcesses) ? parsed.topProcesses : [],
          deployedApp: parsed.deployedApp,
        };
      }, 10000);

      cachedStatus = { ts: Date.now(), data: status };
      return status;
    } catch (err) {
      const offline: RemoteServerStatus = {
        online: false,
        configured: true,
        url: cfg.url,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startMs,
        platform: 'unknown',
        hostname: 'Unreachable',
        os: 'Unknown',
        cpuName: 'Unknown',
        cpuPct: 0,
        totalMemMB: 0,
        usedMemMB: 0,
        freeMemMB: 0,
        memPct: 0,
        diskUsedGB: 0,
        diskFreeGB: 0,
        diskPct: 0,
        uptimeMinutes: 0,
        topProcesses: [],
        error: err instanceof Error ? err.message : String(err),
      };
      return offline;
    }
  })();

  inFlightQuery = run;
  try {
    return await run;
  } finally {
    inFlightQuery = null;
  }
}

export async function deployAppToRemoteServer(): Promise<{
  ok: boolean;
  targetPath: string;
  built: boolean;
  running: boolean;
  port: number;
  message: string;
}> {
  const cfg = loadRemoteServerConfig();
  if (!cfg) {
    throw new Error('No remote server configured.');
  }

  const tmpArchive = path.join('/tmp', `jarvis-deploy-${Date.now()}.tar.gz`);
  try {
    execSync(
      `tar --exclude='node_modules' --exclude='dist' --exclude='.git' --exclude='.env*' --exclude='.server-config.json' --exclude='*.log' --exclude='*.tar.gz' -czf "${tmpArchive}" .`,
      { cwd: process.cwd(), stdio: 'pipe' }
    );
    const b64 = fs.readFileSync(tmpArchive).toString('base64');
    const chunkSize = 1800;
    const chunks: string[] = [];
    for (let i = 0; i < b64.length; i += chunkSize) {
      chunks.push(b64.slice(i, i + chunkSize));
    }

    const encodePs = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

    const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
    const res = await runTtydSession(
      cfg,
      async (ctx) => {
        if (ctx.platform !== 'windows') {
          throw new Error('Automated deploy helper currently targets Windows ttyd host.');
        }

        const initTag = `__INIT_${rand}__`;
        const initPs = encodePs(
          `$d=Join-Path (Get-Location).Path 'jarvis-mark-lvii'; New-Item -ItemType Directory -Force -Path $d | Out-Null; if(Test-Path jarvis.b64){Remove-Item jarvis.b64 -Force}; Write-Output '${initTag}'`
        );
        ctx.sendLine(`powershell -NoProfile -EncodedCommand ${initPs}`);
        await ctx.waitForMarker(initTag, 15000);

        for (let i = 0; i < chunks.length; i += 3) {
          const batch = chunks.slice(i, i + 3);
          const appendCmd = batch.map((c) => `echo ${c}>>jarvis.b64`).join(' & ');
          ctx.sendLine(appendCmd);
          await new Promise((r) => setTimeout(r, 85));
        }

        const uploadTag = `__UP_${rand}__`;
        ctx.sendLine(`echo __UP_^${rand}__`);
        await ctx.waitForMarker(uploadTag, 25000);

        const doneTag = `__DEPLOY_DONE_${rand}__`;
        const finishScript = [
          `$ErrorActionPreference = 'Stop'`,
          `$root = (Get-Location).Path`,
          `$b64 = (Get-Content (Join-Path $root 'jarvis.b64') -Raw) -replace '\\s',''`,
          `$tgz = Join-Path $root 'jarvis.tar.gz'`,
          `[IO.File]::WriteAllBytes($tgz, [Convert]::FromBase64String($b64))`,
          `Remove-Item (Join-Path $root 'jarvis.b64') -Force -ErrorAction SilentlyContinue`,
          `$appDir = Join-Path $root 'jarvis-mark-lvii'`,
          `tar -xzf $tgz -C $appDir`,
          `Remove-Item $tgz -Force -ErrorAction SilentlyContinue`,
          `$localNpm = Join-Path $root 'npm'`,
          `$npmCli = Join-Path $localNpm 'bin\\npm-cli.js'`,
          `if (-not (Test-Path $npmCli)) {`,
          `  cmd /c "robocopy C:\\nvm4w\\nodejs\\node_modules\\npm \`"$localNpm\`" /E /NFL /NDL /NJH /NJS >nul"`,
          `}`,
          `$env:HOME = $appDir`,
          `$env:USERPROFILE = $appDir`,
          `$env:APPDATA = Join-Path $appDir '.appdata'`,
          `$env:LOCALAPPDATA = Join-Path $appDir '.localappdata'`,
          `$env:npm_config_cache = Join-Path $appDir '.npm-cache'`,
          `New-Item -ItemType Directory -Force -Path $env:APPDATA,$env:LOCALAPPDATA,$env:npm_config_cache | Out-Null`,
          `$envFile = Join-Path $appDir '.env'`,
          `if (-not (Test-Path $envFile)) {`,
          `  Set-Content -Path $envFile -Value @('NODE_ENV=production','PORT=3000','GEMINI_API_KEY=')`,
          `}`,
          `Set-Location $appDir`,
          `$ErrorActionPreference = 'Continue'`,
          `cmd /c "node \`"$npmCli\`" install --legacy-peer-deps --no-audit --no-fund > deploy.log 2>&1"`,
          `$viteJs = Join-Path $appDir 'node_modules\\vite\\bin\\vite.js'`,
          `if (Test-Path $viteJs) { cmd /c "node \`"$viteJs\`" build >> deploy.log 2>&1" }`,
          `$built = Test-Path (Join-Path $appDir 'dist\\index.html')`,
          `$old = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess`,
          `if ($old) { Stop-Process -Id $old -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 600 }`,
          `if ($built) {`,
          `  $env:NODE_ENV = 'production'`,
          `  $tsxCli = Join-Path $appDir 'node_modules\\tsx\\dist\\cli.mjs'`,
          `  $entry = if (Test-Path $tsxCli) { "node \`"$tsxCli\`" server.ts" } else { "node server.ts" }`,
          `  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c',"$entry >> server.out.log 2>> server.err.log" -WorkingDirectory $appDir -WindowStyle Hidden`,
          `  for ($i = 0; $i -lt 12; $i++) {`,
          `    Start-Sleep -Seconds 1`,
          `    if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { break }`,
          `  }`,
          `}`,
          `$up = [bool](Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)`,
          `Write-Output '${doneTag}'`,
          `Write-Output (@{targetPath=$appDir;built=$built;running=$up;port=3000}|ConvertTo-Json -Compress)`,
        ].join('\n');

        ctx.sendLine(`powershell -NoProfile -EncodedCommand ${encodePs(finishScript)}`);
        const out = await ctx.waitForMarker(doneTag, 210000);
        await new Promise((r) => setTimeout(r, 1200));
        const tail = ctx.getCleanBuffer().slice(out.indexOf(doneTag));
        const jsonMatch = tail.match(/\{[^\n]*\}/);
        const parsed = jsonMatch
          ? (JSON.parse(jsonMatch[0]) as { targetPath: string; built: boolean; running: boolean; port: number })
          : { targetPath: 'jarvis-mark-lvii', built: false, running: false, port: 3000 };

        cachedStatus = null;
        return {
          ok: parsed.built && parsed.running,
          targetPath: parsed.targetPath,
          built: parsed.built,
          running: parsed.running,
          port: parsed.port,
          message: parsed.running
            ? `Deployed, built, and running on port ${parsed.port} (${parsed.targetPath}).`
            : `Files extracted (built=${parsed.built}, running=${parsed.running}). Check ${parsed.targetPath}\\deploy.log if needed.`,
        };
      },
      15000,
      240000
    );

    return res;
  } finally {
    if (fs.existsSync(tmpArchive)) {
      fs.unlinkSync(tmpArchive);
    }
  }
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: string;
}

export interface RemoteFileListResult {
  cwd: string;
  parent: string | null;
  drives: string[];
  entries: RemoteFileEntry[];
}

const encodePowerShell = (script: string) => Buffer.from(script, 'utf16le').toString('base64');

export async function listRemoteFiles(dirPath?: string): Promise<RemoteFileListResult> {
  const cfg = loadRemoteServerConfig();
  if (!cfg) throw new Error('No remote server configured.');

  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  const startTag = `__FLS_${rand}__`;
  const endTag = `__FLE_${rand}__`;
  const targetB64 = Buffer.from(String(dirPath || '').trim(), 'utf8').toString('base64');

  return runTtydSession(
    cfg,
    async (ctx) => {
      if (ctx.platform === 'windows') {
        const ps = [
          `$ErrorActionPreference = 'Stop'`,
          `$raw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${targetB64}')).Trim()`,
          `if (-not $raw -or $raw -eq 'HOME') { $target = $env:USERPROFILE }`,
          `elseif ($raw -eq 'DESKTOP') { $target = [Environment]::GetFolderPath('Desktop') }`,
          `elseif ($raw -eq 'DOCUMENTS') { $target = [Environment]::GetFolderPath('MyDocuments') }`,
          `elseif ($raw -eq 'DOWNLOADS') { $target = Join-Path $env:USERPROFILE 'Downloads' }`,
          `else { $target = $raw }`,
          `$resolved = (Resolve-Path -LiteralPath $target).Path`,
          `$parent = Split-Path -Path $resolved -Parent`,
          `if ([string]::IsNullOrWhiteSpace($parent)) { $parent = $null }`,
          `$drives = @([IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady } | ForEach-Object { $_.Name })`,
          `$items = @(Get-ChildItem -LiteralPath $resolved -Force -ErrorAction SilentlyContinue | Sort-Object @{Expression={-not $_.PSIsContainer}}, Name | Select-Object -First 250 | ForEach-Object {`,
          `  @{ name = $_.Name; path = $_.FullName; isDir = [bool]$_.PSIsContainer; size = if ($_.PSIsContainer) { 0 } else { [int64]$_.Length }; modifiedAt = $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm') }`,
          `})`,
          `Write-Output ('__FLS_' + '${rand}__')`,
          `Write-Output (@{ cwd = $resolved; parent = $parent; drives = $drives; entries = $items } | ConvertTo-Json -Depth 4 -Compress)`,
          `Write-Output ('__FLE_' + '${rand}__')`,
        ].join('\n');
        ctx.sendLine(`powershell -NoProfile -EncodedCommand ${encodePowerShell(ps)}`);
      } else {
        const js = `const fs=require('fs'),path=require('path'),os=require('os');let t=Buffer.from('${targetB64}','base64').toString('utf8').trim();if(!t||t==='HOME')t=os.homedir();else if(t==='DESKTOP')t=path.join(os.homedir(),'Desktop');else if(t==='DOCUMENTS')t=path.join(os.homedir(),'Documents');else if(t==='DOWNLOADS')t=path.join(os.homedir(),'Downloads');const r=path.resolve(t);const p=path.dirname(r)===r?null:path.dirname(r);const entries=fs.readdirSync(r,{withFileTypes:true}).slice(0,250).map(d=>{const fp=path.join(r,d.name);let st={size:0,mtime:new Date()};try{st=fs.statSync(fp)}catch{};return{name:d.name,path:fp,isDir:d.isDirectory(),size:d.isDirectory()?0:st.size,modifiedAt:st.mtime.toISOString().slice(0,16).replace('T',' ')}}).sort((a,b)=>(b.isDir-a.isDir)||a.name.localeCompare(b.name));console.log(JSON.stringify({cwd:r,parent:p,drives:['/'],entries}));`;
        ctx.sendLine(`printf '${startTag}\\n'; node -e ${JSON.stringify(js)}; printf '${endTag}\\n'`);
      }

      const out = await ctx.waitForMarker(endTag, 20000);
      const sIdx = out.indexOf(startTag);
      const eIdx = out.indexOf(endTag);
      const slice = sIdx !== -1 && eIdx > sIdx ? out.slice(sIdx + startTag.length, eIdx) : out;
      const jsonMatch = slice.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to list remote directory.');
      }
      const parsed = JSON.parse(jsonMatch[0]) as RemoteFileListResult;
      return {
        cwd: parsed.cwd || '',
        parent: parsed.parent ?? null,
        drives: Array.isArray(parsed.drives) ? parsed.drives : [],
        entries: Array.isArray(parsed.entries) ? parsed.entries : [],
      };
    },
    10000,
    25000
  );
}

export async function downloadRemoteFile(filePath: string): Promise<{
  fileName: string;
  size: number;
  buffer: Buffer;
}> {
  const cfg = loadRemoteServerConfig();
  if (!cfg) throw new Error('No remote server configured.');
  if (!filePath || !filePath.trim()) throw new Error('File path is required.');

  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  const startTag = `__FDS_${rand}__`;
  const endTag = `__FDE_${rand}__`;
  const pathB64 = Buffer.from(filePath.trim(), 'utf8').toString('base64');

  return runTtydSession(
    cfg,
    async (ctx) => {
      if (ctx.platform === 'windows') {
        const ps = [
          `$ErrorActionPreference = 'Stop'`,
          `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathB64}'))`,
          `if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "File not found: $p" }`,
          `$fi = Get-Item -LiteralPath $p`,
          `if ($fi.Length -gt 15728640) { throw "File exceeds 15 MB transfer limit ($($fi.Length) bytes)." }`,
          `$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($fi.FullName))`,
          `$meta = (@{ name = $fi.Name; size = [int64]$fi.Length } | ConvertTo-Json -Compress)`,
          `Write-Output ('__FDS_' + '${rand}__')`,
          `Write-Output $meta`,
          `Write-Output ('__FDB_' + '${rand}__')`,
          `for ($i = 0; $i -lt $b64.Length; $i += 4000) { Write-Output $b64.Substring($i, [Math]::Min(4000, $b64.Length - $i)) }`,
          `Write-Output ('__FDE_' + '${rand}__')`,
        ].join('\n');
        ctx.sendLine(`powershell -NoProfile -EncodedCommand ${encodePowerShell(ps)}`);
      } else {
        const js = `const fs=require('fs'),path=require('path');const p=Buffer.from('${pathB64}','base64').toString('utf8');const st=fs.statSync(p);if(!st.isFile())throw new Error('Not a file');if(st.size>15728640)throw new Error('Exceeds 15 MB limit');console.log(JSON.stringify({name:path.basename(p),size:st.size}));console.log('__FDB_${rand}__');console.log(fs.readFileSync(p).toString('base64'));`;
        ctx.sendLine(`printf '${startTag}\\n'; node -e ${JSON.stringify(js)}; printf '${endTag}\\n'`);
      }

      const out = await ctx.waitForMarker(endTag, 90000);
      const sIdx = out.indexOf(startTag);
      const bIdx = out.indexOf(`__FDB_${rand}__`);
      const eIdx = out.indexOf(endTag);
      if (sIdx === -1 || bIdx === -1 || eIdx === -1 || bIdx <= sIdx || eIdx <= bIdx) {
        throw new Error('Could not read file payload from remote host.');
      }
      const metaRaw = out.slice(sIdx + startTag.length, bIdx);
      const metaMatch = metaRaw.match(/\{[^\n]*\}/);
      const meta = metaMatch ? (JSON.parse(metaMatch[0]) as { name: string; size: number }) : { name: path.basename(filePath), size: 0 };
      const b64Payload = out
        .slice(bIdx + `__FDB_${rand}__`.length, eIdx)
        .replace(/[^A-Za-z0-9+/=]/g, '');
      const buffer = Buffer.from(b64Payload, 'base64');
      return {
        fileName: meta.name || path.basename(filePath),
        size: buffer.length,
        buffer,
      };
    },
    10000,
    95000
  );
}

export async function uploadRemoteFile(
  targetDir: string,
  fileName: string,
  base64Data: string
): Promise<{ path: string; size: number }> {
  const cfg = loadRemoteServerConfig();
  if (!cfg) throw new Error('No remote server configured.');
  const cleanName = path.basename(String(fileName || '').trim()).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  if (!cleanName) throw new Error('Valid filename is required.');
  const cleanB64 = base64Data.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const byteSize = Math.floor((cleanB64.length * 3) / 4);
  if (byteSize > 15 * 1024 * 1024) {
    throw new Error('File exceeds 15 MB upload limit.');
  }

  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  const dirB64 = Buffer.from(String(targetDir || '').trim() || 'HOME', 'utf8').toString('base64');
  const nameB64 = Buffer.from(cleanName, 'utf8').toString('base64');
  const chunkSize = 1800;
  const chunks: string[] = [];
  for (let i = 0; i < cleanB64.length; i += chunkSize) {
    chunks.push(cleanB64.slice(i, i + chunkSize));
  }

  return runTtydSession(
    cfg,
    async (ctx) => {
      if (ctx.platform !== 'windows') {
        throw new Error('Upload helper currently targets Windows ttyd host.');
      }

      const tmpB64Name = `jarvis_up_${rand}.b64`;
      const initTag = `__UPI_${rand}__`;
      const initPs = [
        `$p = Join-Path $env:TEMP '${tmpB64Name}'`,
        `if (Test-Path $p) { Remove-Item $p -Force }`,
        `New-Item -ItemType File -Force -Path $p | Out-Null`,
        `Write-Output '${initTag}'`,
      ].join('\n');
      ctx.sendLine(`powershell -NoProfile -EncodedCommand ${encodePowerShell(initPs)}`);
      await ctx.waitForMarker(initTag, 15000);

      for (let i = 0; i < chunks.length; i += 3) {
        const batch = chunks.slice(i, i + 3);
        const cmd = batch.map((c) => `echo ${c}>>"%TEMP%\\${tmpB64Name}"`).join(' & ');
        ctx.sendLine(cmd);
        await new Promise((r) => setTimeout(r, 75));
      }

      const upTag = `__UPC_${rand}__`;
      ctx.sendLine(`echo __UPC_^${rand}__`);
      await ctx.waitForMarker(upTag, 25000);

      const doneTag = `__UPD_${rand}__`;
      const endTag = `__UPE_${rand}__`;
      const savePs = [
        `$ErrorActionPreference = 'Stop'`,
        `$dRaw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${dirB64}')).Trim()`,
        `if (-not $dRaw -or $dRaw -eq 'HOME') { $dRaw = $env:USERPROFILE }`,
        `elseif ($dRaw -eq 'DESKTOP') { $dRaw = [Environment]::GetFolderPath('Desktop') }`,
        `elseif ($dRaw -eq 'DOCUMENTS') { $dRaw = [Environment]::GetFolderPath('MyDocuments') }`,
        `elseif ($dRaw -eq 'DOWNLOADS') { $dRaw = Join-Path $env:USERPROFILE 'Downloads' }`,
        `$nRaw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${nameB64}'))`,
        `$tmp = Join-Path $env:TEMP '${tmpB64Name}'`,
        `$rawB64 = (Get-Content -LiteralPath $tmp -Raw) -replace '\\s',''`,
        `Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue`,
        `$bytes = [Convert]::FromBase64String($rawB64)`,
        `if (-not (Test-Path -LiteralPath $dRaw)) { New-Item -ItemType Directory -Force -Path $dRaw | Out-Null }`,
        `$dest = Join-Path (Resolve-Path -LiteralPath $dRaw).Path $nRaw`,
        `[IO.File]::WriteAllBytes($dest, $bytes)`,
        `Write-Output ('__UPD_' + '${rand}__')`,
        `Write-Output (@{ path = $dest; size = $bytes.Length } | ConvertTo-Json -Compress)`,
        `Write-Output ('__UPE_' + '${rand}__')`,
      ].join('\n');

      ctx.sendLine(`powershell -NoProfile -EncodedCommand ${encodePowerShell(savePs)}`);
      const out = await ctx.waitForMarker(endTag, 45000);
      const dIdx = out.indexOf(doneTag);
      const eIdx = out.indexOf(endTag);
      const tail = dIdx !== -1 && eIdx > dIdx ? out.slice(dIdx + doneTag.length, eIdx) : out;
      const jsonMatch = tail.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Upload completed but confirmation JSON was not received.');
      }
      return JSON.parse(jsonMatch[0]) as { path: string; size: number };
    },
    10000,
    120000
  );
}

export async function execRemoteCommand(
  command: string,
  cwd?: string
): Promise<{ output: string; cwd: string }> {
  const cfg = loadRemoteServerConfig();
  if (!cfg) throw new Error('No remote server configured.');
  if (!command || !command.trim()) throw new Error('Command is required.');

  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  const startTag = `__EXS_${rand}__`;
  const endTag = `__EXE_${rand}__`;
  const cmdB64 = Buffer.from(command.trim(), 'utf8').toString('base64');
  const cwdB64 = Buffer.from(String(cwd || '').trim(), 'utf8').toString('base64');

  return runTtydSession(
    cfg,
    async (ctx) => {
      if (ctx.platform === 'windows') {
        const ps = [
          `$c = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${cmdB64}'))`,
          `$d = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${cwdB64}')).Trim()`,
          `if ($d -and (Test-Path -LiteralPath $d)) { Set-Location -LiteralPath $d }`,
          `Write-Output ('__EXS_' + '${rand}__')`,
          `$out = (& cmd.exe /c $c 2>&1 | Out-String)`,
          `$cur = (Get-Location).Path`,
          `Write-Output (@{ cwd = $cur; output = $out } | ConvertTo-Json -Compress)`,
          `Write-Output ('__EXE_' + '${rand}__')`,
        ].join('\n');
        ctx.sendLine(`powershell -NoProfile -EncodedCommand ${encodePowerShell(ps)}`);
      } else {
        const js = `const {execSync}=require('child_process');const c=Buffer.from('${cmdB64}','base64').toString('utf8');const d=Buffer.from('${cwdB64}','base64').toString('utf8').trim()||process.cwd();let o='';try{o=execSync(c,{cwd:d,encoding:'utf8',stdio:['ignore','pipe','pipe']})}catch(e){o=(e.stdout||'')+(e.stderr||e.message)};console.log(JSON.stringify({cwd:d,output:o}));`;
        ctx.sendLine(`printf '${startTag}\\n'; node -e ${JSON.stringify(js)}; printf '${endTag}\\n'`);
      }

      const out = await ctx.waitForMarker(endTag, 30000);
      const sIdx = out.indexOf(startTag);
      const eIdx = out.indexOf(endTag);
      const slice = sIdx !== -1 && eIdx > sIdx ? out.slice(sIdx + startTag.length, eIdx) : out;
      const jsonMatch = slice.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { output: slice.trim().slice(0, 16000), cwd: cwd || '' };
      }
      const parsed = JSON.parse(jsonMatch[0]) as { output?: string; cwd?: string };
      return {
        output: String(parsed.output || '').trim().slice(0, 16000),
        cwd: String(parsed.cwd || cwd || ''),
      };
    },
    10000,
    40000
  );
}

export interface RemoteFilePreviewResult {
  name: string;
  path: string;
  size: number;
  kind: 'text' | 'image' | 'pdf' | 'video' | 'audio' | 'other';
  mimeType: string;
  textContent?: string;
  viewUrl: string;
}

export function getRemoteFileMimeAndKind(filePath: string): {
  kind: RemoteFilePreviewResult['kind'];
  mimeType: string;
} {
  const ext = path.extname(filePath || '').toLowerCase();
  const textExts: Record<string, string> = {
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.ts': 'text/plain; charset=utf-8',
    '.tsx': 'text/plain; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.jsx': 'text/plain; charset=utf-8',
    '.py': 'text/plain; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.yml': 'text/plain; charset=utf-8',
    '.yaml': 'text/plain; charset=utf-8',
    '.ini': 'text/plain; charset=utf-8',
    '.conf': 'text/plain; charset=utf-8',
    '.env': 'text/plain; charset=utf-8',
    '.bat': 'text/plain; charset=utf-8',
    '.ps1': 'text/plain; charset=utf-8',
    '.sh': 'text/plain; charset=utf-8',
    '.sql': 'text/plain; charset=utf-8',
  };
  if (textExts[ext]) return { kind: 'text', mimeType: textExts[ext] };

  const imageExts: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
  };
  if (imageExts[ext]) return { kind: 'image', mimeType: imageExts[ext] };

  if (ext === '.pdf') return { kind: 'pdf', mimeType: 'application/pdf' };

  const videoExts: Record<string, string> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
  };
  if (videoExts[ext]) return { kind: 'video', mimeType: videoExts[ext] };

  const audioExts: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
  };
  if (audioExts[ext]) return { kind: 'audio', mimeType: audioExts[ext] };

  return { kind: 'other', mimeType: 'application/octet-stream' };
}

export async function searchRemoteFiles(
  query: string,
  rootPath?: string
): Promise<{ root: string; query: string; matches: RemoteFileEntry[] }> {
  const cfg = loadRemoteServerConfig();
  if (!cfg) throw new Error('No remote server configured.');
  const trimmedQ = String(query || '').trim();
  if (!trimmedQ) throw new Error('Search query is required.');

  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  const startTag = `__FSS_${rand}__`;
  const endTag = `__FSE_${rand}__`;
  const queryB64 = Buffer.from(trimmedQ, 'utf8').toString('base64');
  const rootB64 = Buffer.from(String(rootPath || '').trim(), 'utf8').toString('base64');

  return runTtydSession(
    cfg,
    async (ctx) => {
      if (ctx.platform === 'windows') {
        const ps = [
          `$ErrorActionPreference = 'Stop'`,
          `$q = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${queryB64}')).Trim()`,
          `$rRaw = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${rootB64}')).Trim()`,
          `if (-not $rRaw -or $rRaw -eq 'HOME') { $root = $env:USERPROFILE }`,
          `elseif ($rRaw -eq 'DESKTOP') { $root = [Environment]::GetFolderPath('Desktop') }`,
          `elseif ($rRaw -eq 'DOCUMENTS') { $root = [Environment]::GetFolderPath('MyDocuments') }`,
          `elseif ($rRaw -eq 'DOWNLOADS') { $root = Join-Path $env:USERPROFILE 'Downloads' }`,
          `else { $root = $rRaw }`,
          `$resolvedRoot = (Resolve-Path -LiteralPath $root).Path`,
          `$terms = @($q.ToLowerInvariant().Split(' ', [StringSplitOptions]::RemoveEmptyEntries))`,
          `$skipDirs = @('node_modules','.git','appdata','$recycle.bin','windows','programdata','program files','program files (x86)','system volume information','__pycache__','.cache','dist')`,
          `$allowAppData = $resolvedRoot.ToLowerInvariant().Contains('appdata')`,
          `$queue = [System.Collections.Generic.Queue[object]]::new()`,
          `$queue.Enqueue(@{ dir = $resolvedRoot; depth = 0 })`,
          `$matches = [System.Collections.Generic.List[object]]::new()`,
          `$scanned = 0`,
          `while ($queue.Count -gt 0 -and $matches.Count -lt 40 -and $scanned -lt 8000) {`,
          `  $cur = $queue.Dequeue()`,
          `  $entries = Get-ChildItem -LiteralPath $cur.dir -Force -ErrorAction SilentlyContinue`,
          `  foreach ($e in $entries) {`,
          `    $scanned++`,
          `    $lname = $e.Name.ToLowerInvariant()`,
          `    $isMatch = $true`,
          `    foreach ($t in $terms) { if (-not $lname.Contains($t)) { $isMatch = $false; break } }`,
          `    if ($isMatch) {`,
          `      $matches.Add(@{ name = $e.Name; path = $e.FullName; isDir = [bool]$e.PSIsContainer; size = if ($e.PSIsContainer) { 0 } else { [int64]$e.Length }; modifiedAt = $e.LastWriteTime.ToString('yyyy-MM-dd HH:mm') })`,
          `      if ($matches.Count -ge 40) { break }`,
          `    }`,
          `    if ($e.PSIsContainer -and $cur.depth -lt 5) {`,
          `      if (($skipDirs -contains $lname) -and -not ($lname -eq 'appdata' -and $allowAppData)) { continue }`,
          `      $queue.Enqueue(@{ dir = $e.FullName; depth = ($cur.depth + 1) })`,
          `    }`,
          `  }`,
          `}`,
          `Write-Output ('__FSS_' + '${rand}__')`,
          `Write-Output (@{ root = $resolvedRoot; query = $q; matches = @($matches) } | ConvertTo-Json -Depth 4 -Compress)`,
          `Write-Output ('__FSE_' + '${rand}__')`,
        ].join('\n');
        ctx.sendLine(`powershell -NoProfile -EncodedCommand ${encodePowerShell(ps)}`);
      } else {
        const js = `const fs=require('fs'),path=require('path'),os=require('os');const q=Buffer.from('${queryB64}','base64').toString('utf8').trim().toLowerCase();const terms=q.split(/\\s+/).filter(Boolean);let r=Buffer.from('${rootB64}','base64').toString('utf8').trim();if(!r||r==='HOME')r=os.homedir();else if(r==='DESKTOP')r=path.join(os.homedir(),'Desktop');else if(r==='DOCUMENTS')r=path.join(os.homedir(),'Documents');else if(r==='DOWNLOADS')r=path.join(os.homedir(),'Downloads');const root=path.resolve(r);const skip=new Set(['node_modules','.git','.cache','dist']);const queue=[[root,0]],matches=[];let scanned=0;while(queue.length&&matches.length<40&&scanned<8000){const[d,depth]=queue.shift();let list=[];try{list=fs.readdirSync(d,{withFileTypes:true})}catch{continue}for(const ent of list){scanned++;const ln=ent.name.toLowerCase();const fp=path.join(d,ent.name);if(terms.every(t=>ln.includes(t))){let st={size:0,mtime:new Date()};try{st=fs.statSync(fp)}catch{};matches.push({name:ent.name,path:fp,isDir:ent.isDirectory(),size:ent.isDirectory()?0:st.size,modifiedAt:st.mtime.toISOString().slice(0,16).replace('T',' ')});if(matches.length>=40)break}if(ent.isDirectory()&&depth<5&&!skip.has(ln))queue.push([fp,depth+1])}}console.log(JSON.stringify({root,query:q,matches}));`;
        ctx.sendLine(`printf '${startTag}\\n'; node -e ${JSON.stringify(js)}; printf '${endTag}\\n'`);
      }

      const out = await ctx.waitForMarker(endTag, 35000);
      const sIdx = out.indexOf(startTag);
      const eIdx = out.indexOf(endTag);
      const slice = sIdx !== -1 && eIdx > sIdx ? out.slice(sIdx + startTag.length, eIdx) : out;
      const jsonMatch = slice.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Failed to search remote files.');
      }
      const parsed = JSON.parse(jsonMatch[0]) as { root?: string; query?: string; matches?: RemoteFileEntry[] };
      return {
        root: parsed.root || '',
        query: parsed.query || trimmedQ,
        matches: Array.isArray(parsed.matches) ? parsed.matches : [],
      };
    },
    10000,
    45000
  );
}

export async function readRemoteFilePreview(filePath: string): Promise<RemoteFilePreviewResult> {
  const cfg = loadRemoteServerConfig();
  if (!cfg) throw new Error('No remote server configured.');
  if (!filePath || !filePath.trim()) throw new Error('File path is required.');

  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  const startTag = `__FPS_${rand}__`;
  const endTag = `__FPE_${rand}__`;
  const pathB64 = Buffer.from(filePath.trim(), 'utf8').toString('base64');

  const meta = await runTtydSession(
    cfg,
    async (ctx) => {
      if (ctx.platform === 'windows') {
        const ps = [
          `$ErrorActionPreference = 'Stop'`,
          `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathB64}'))`,
          `if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { throw "File not found: $p" }`,
          `$fi = Get-Item -LiteralPath $p`,
          `Write-Output ('__FPS_' + '${rand}__')`,
          `Write-Output (@{ name = $fi.Name; path = $fi.FullName; size = [int64]$fi.Length } | ConvertTo-Json -Compress)`,
          `Write-Output ('__FPE_' + '${rand}__')`,
        ].join('\n');
        ctx.sendLine(`powershell -NoProfile -EncodedCommand ${encodePowerShell(ps)}`);
      } else {
        const js = `const fs=require('fs'),path=require('path');const p=Buffer.from('${pathB64}','base64').toString('utf8');const st=fs.statSync(p);if(!st.isFile())throw new Error('Not a file');console.log(JSON.stringify({name:path.basename(p),path:path.resolve(p),size:st.size}));`;
        ctx.sendLine(`printf '${startTag}\\n'; node -e ${JSON.stringify(js)}; printf '${endTag}\\n'`);
      }

      const out = await ctx.waitForMarker(endTag, 20000);
      const sIdx = out.indexOf(startTag);
      const eIdx = out.indexOf(endTag);
      const slice = sIdx !== -1 && eIdx > sIdx ? out.slice(sIdx + startTag.length, eIdx) : out;
      const jsonMatch = slice.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Could not stat remote file.');
      return JSON.parse(jsonMatch[0]) as { name: string; path: string; size: number };
    },
    10000,
    25000
  );

  const { kind, mimeType } = getRemoteFileMimeAndKind(meta.path || meta.name);
  let textContent: string | undefined;
  if (kind === 'text' && meta.size <= 250_000) {
    const dl = await downloadRemoteFile(meta.path);
    textContent = dl.buffer.toString('utf8');
  }

  return {
    name: meta.name,
    path: meta.path,
    size: meta.size,
    kind,
    mimeType,
    textContent,
    viewUrl: `/api/server/files/view?path=${encodeURIComponent(meta.path)}`,
  };
}

export async function launchRemoteFileOnHost(filePath: string): Promise<{
  launched: boolean;
  path: string;
  sessionId: number;
  note: string;
}> {
  const cfg = loadRemoteServerConfig();
  if (!cfg) throw new Error('No remote server configured.');
  if (!filePath || !filePath.trim()) throw new Error('File path is required.');

  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  const startTag = `__FLC_${rand}__`;
  const endTag = `__FLE_${rand}__`;
  const pathB64 = Buffer.from(filePath.trim(), 'utf8').toString('base64');

  return runTtydSession(
    cfg,
    async (ctx) => {
      if (ctx.platform !== 'windows') {
        throw new Error('Host GUI launch currently supports Windows remote server.');
      }
      const ps = [
        `$ErrorActionPreference = 'Stop'`,
        `$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathB64}'))`,
        `if (-not (Test-Path -LiteralPath $p)) { throw "Path not found: $p" }`,
        `$resolved = (Resolve-Path -LiteralPath $p).Path`,
        `$sid = (Get-Process -Id $PID).SessionId`,
        `Start-Process -FilePath $resolved`,
        `$note = if ($sid -eq 0) { 'Launched inside background service Session 0 (not visible on interactive desktop).' } else { 'Launched on active Windows desktop session.' }`,
        `Write-Output ('__FLC_' + '${rand}__')`,
        `Write-Output (@{ launched = $true; path = $resolved; sessionId = $sid; note = $note } | ConvertTo-Json -Compress)`,
        `Write-Output ('__FLE_' + '${rand}__')`,
      ].join('\n');
      ctx.sendLine(`powershell -NoProfile -EncodedCommand ${encodePowerShell(ps)}`);
      const out = await ctx.waitForMarker(endTag, 20000);
      const sIdx = out.indexOf(startTag);
      const eIdx = out.indexOf(endTag);
      const slice = sIdx !== -1 && eIdx > sIdx ? out.slice(sIdx + startTag.length, eIdx) : out;
      const jsonMatch = slice.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Launch status JSON not returned.');
      }
      return JSON.parse(jsonMatch[0]) as {
        launched: boolean;
        path: string;
        sessionId: number;
        note: string;
      };
    },
    10000,
    25000
  );
}

export async function captureRemoteScreenshot(): Promise<{ base64: string; mimeType: string }> {
  const cfg = loadRemoteServerConfig();
  if (!cfg) throw new Error('No remote server configured.');

  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  const startTag = `__SCRS_${rand}__`;
  const endTag = `__SCRE_${rand}__`;

  return runTtydSession(
    cfg,
    async (ctx) => {
      if (ctx.platform === 'windows') {
        const ps = [
          `$ErrorActionPreference = 'Stop'`,
          `Add-Type -AssemblyName System.Windows.Forms`,
          `Add-Type -AssemblyName System.Drawing`,
          `$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen`,
          `if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'No active display session available.' }`,
          `$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)`,
          `$g = [System.Drawing.Graphics]::FromImage($bmp)`,
          `$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)`,
          `$ms = New-Object System.IO.MemoryStream`,
          `$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1`,
          `$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)`,
          `$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 75L)`,
          `$bmp.Save($ms, $codec, $encParams)`,
          `$b64 = [Convert]::ToBase64String($ms.ToArray())`,
          `$g.Dispose(); $bmp.Dispose(); $ms.Dispose()`,
          `Write-Output ('__SCRS_' + '${rand}__')`,
          `Write-Output $b64`,
          `Write-Output ('__SCRE_' + '${rand}__')`,
        ].join('\n');
        ctx.sendLine(`powershell -NoProfile -EncodedCommand ${encodePowerShell(ps)}`);
      } else {
        const sh = [
          `TMPF="/tmp/jarvis_scr_${rand}.jpg"`,
          `if command -v scrot >/dev/null 2>&1; then DISPLAY=\${DISPLAY:-:0} scrot -q 75 "$TMPF";`,
          `elif command -v import >/dev/null 2>&1; then DISPLAY=\${DISPLAY:-:0} import -window root -quality 75 "$TMPF";`,
          `elif command -v gnome-screenshot >/dev/null 2>&1; then DISPLAY=\${DISPLAY:-:0} gnome-screenshot -f "$TMPF";`,
          `else echo "NO_SCREENSHOT_TOOL" >&2; exit 1; fi`,
          `printf '${startTag}\\n'; base64 -w 0 "$TMPF" 2>/dev/null || base64 "$TMPF"; printf '\\n${endTag}\\n'; rm -f "$TMPF"`,
        ].join(' ');
        ctx.sendLine(sh);
      }

      const out = await ctx.waitForMarker(endTag, 25000);
      const sIdx = out.indexOf(startTag);
      const eIdx = out.indexOf(endTag);
      if (sIdx === -1 || eIdx <= sIdx) {
        throw new Error('Remote desktop screenshot failed (display session may be headless or locked).');
      }
      const b64 = out.slice(sIdx + startTag.length, eIdx).replace(/[^A-Za-z0-9+/=]/g, '');
      if (b64.length < 100) {
        throw new Error('Remote screenshot returned empty image data.');
      }
      return { base64: b64, mimeType: 'image/jpeg' };
    },
    10000,
    30000
  );
}

export function resetRemoteStatusCache() {
  cachedStatus = null;
  inFlightQuery = null;
}



