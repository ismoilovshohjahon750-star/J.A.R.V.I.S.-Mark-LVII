import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import dotenv from 'dotenv';

process.env.JARVIS_DESKTOP_ENTRY = '1';
process.env.NODE_ENV = 'production';

function getExeDirectory(): string {
  const execDir = path.dirname(process.execPath);
  if (execDir && !execDir.includes('$bunfs') && fs.existsSync(execDir)) {
    return execDir;
  }
  return process.cwd();
}

function loadDesktopEnv(exeDir: string) {
  const appDataDir = process.env.APPDATA
    ? path.join(process.env.APPDATA, 'JARVIS-Mark-LVII')
    : '';

  const candidates = [
    path.join(exeDir, '.env.local'),
    path.join(exeDir, '.env'),
    ...(appDataDir ? [path.join(appDataDir, '.env.local'), path.join(appDataDir, '.env')] : []),
    path.join(process.cwd(), '.env.local'),
    path.join(process.cwd(), '.env'),
  ];

  for (const envFile of candidates) {
    if (fs.existsSync(envFile)) {
      dotenv.config({ path: envFile, override: false });
    }
  }

  const hasLocalEnv =
    fs.existsSync(path.join(exeDir, '.env')) ||
    fs.existsSync(path.join(exeDir, '.env.local')) ||
    Boolean(appDataDir && fs.existsSync(path.join(appDataDir, '.env')));

  if (!hasLocalEnv && process.platform === 'win32') {
    const examplePath = path.join(exeDir, '.env.example');
    if (!fs.existsSync(examplePath)) {
      try {
        fs.writeFileSync(
          examplePath,
          [
            '# J.A.R.V.I.S. Mark LVII Desktop Configuration',
            '# Rename this file to .env and paste your Gemini API key below:',
            'GEMINI_API_KEY=',
            'GEMINI_API_KEY_2=',
            'GROQ_API_KEY=',
            'REMOTE_SERVER_URL=',
            'REMOTE_SERVER_USER=',
            'REMOTE_SERVER_PASS=',
            '',
          ].join('\r\n'),
          'utf8'
        );
      } catch {
        // Ignore read-only folder errors
      }
    }
  }
}

async function isPortFree(port: number, host: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, host);
  });
}

async function findAvailablePort(startPort = 3000, host = 'localhost'): Promise<number> {
  for (let p = startPort; p < startPort + 25; p++) {
    if (await isPortFree(p, host)) return p;
  }
  return 0;
}

function openDesktopWindow(url: string) {
  if (process.platform !== 'win32') {
    console.log(`[J.A.R.V.I.S. Desktop] Ready at ${url}`);
    return;
  }

  const localAppData = process.env.LOCALAPPDATA || '';
  const browserCandidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ...(localAppData
      ? [
          path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ]
      : []),
  ];

  const appBrowser = browserCandidates.find((p) => fs.existsSync(p));
  if (appBrowser) {
    try {
      const child = spawn(
        appBrowser,
        [`--app=${url}`, '--window-size=1366,860', '--disable-features=Translate'],
        {
          detached: true,
          stdio: 'ignore',
        }
      );
      child.unref();
      return;
    } catch {
      // Fall through to default browser
    }
  }

  try {
    const child = spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch {
    console.log(`[J.A.R.V.I.S. Desktop] Open manually in your browser: ${url}`);
  }
}

async function bootDesktop() {
  const exeDir = getExeDirectory();
  try {
    if (process.platform === 'win32' && exeDir !== process.cwd()) {
      process.chdir(exeDir);
    }
  } catch {
    // Keep existing cwd if chdir is not allowed
  }

  loadDesktopEnv(exeDir);

  const preferredPort = Number(process.env.PORT) || 3000;
  const host = 'localhost';
  const port = await findAvailablePort(preferredPort, host);

  const [{ startServer }, { EMBEDDED_ASSETS }] = await Promise.all([
    import('../server.ts'),
    import('./embeddedAssets.generated.ts'),
  ]);

  const started = await startServer({
    port,
    host,
    embeddedAssets: EMBEDDED_ASSETS,
  });

  const appUrl = `http://${host}:${started.port}`;

  console.log('');
  console.log('==========================================================');
  console.log('   J.A.R.V.I.S. — MARK LVII DESKTOP TERMINAL');
  console.log('==========================================================');
  console.log(`   HUD URL : ${appUrl}`);
  console.log(`   Folder  : ${exeDir}`);
  console.log(
    `   Gemini  : ${process.env.GEMINI_API_KEY ? 'Configured' : 'Missing (create .env with GEMINI_API_KEY=...)'}`
  );
  console.log('   Status  : ONLINE — Keep this window open while using HUD');
  console.log('==========================================================');
  console.log('');

  if (process.env.JARVIS_NO_BROWSER !== '1') {
    openDesktopWindow(appUrl);
  }
}

bootDesktop().catch((err) => {
  console.error('[J.A.R.V.I.S. Desktop] Startup error:', err);
  process.exit(1);
});
