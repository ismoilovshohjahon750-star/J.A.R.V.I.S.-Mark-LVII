import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';

const ROOT = process.cwd();
const DIST_DIR = path.join(ROOT, 'dist');
const DESKTOP_DIR = path.join(ROOT, 'desktop');
const RELEASE_DIR = path.join(ROOT, 'release');
const GENERATED_ASSETS_FILE = path.join(DESKTOP_DIR, 'embeddedAssets.generated.ts');
const ICON_FILE = path.join(DESKTOP_DIR, 'jarvis.ico');
const OUTPUT_EXE = path.join(RELEASE_DIR, 'JARVIS-Mark-LVII.exe');

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

function collectDistFiles(dir: string, base = dir): Array<{ route: string; absPath: string }> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: Array<{ route: string; absPath: string }> = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectDistFiles(full, base));
    } else if (entry.isFile()) {
      const rel = path.relative(base, full).split(path.sep).join('/');
      results.push({ route: `/${rel}`, absPath: full });
    }
  }
  return results;
}

function writeArcReactorIco(targetPath: string) {
  const size = 32;
  const headerSize = 6;
  const dirEntrySize = 16;
  const dibHeaderSize = 40;
  const pixelBytes = size * size * 4;
  const andMaskRowBytes = Math.ceil(size / 32) * 4;
  const andMaskBytes = andMaskRowBytes * size;
  const imageSize = dibHeaderSize + pixelBytes + andMaskBytes;

  const buf = Buffer.alloc(headerSize + dirEntrySize + imageSize);

  // ICONDIR
  buf.writeUInt16LE(0, 0);
  buf.writeUInt16LE(1, 2);
  buf.writeUInt16LE(1, 4);

  // ICONDIRENTRY
  buf.writeUInt8(size, 6);
  buf.writeUInt8(size, 7);
  buf.writeUInt8(0, 8);
  buf.writeUInt8(0, 9);
  buf.writeUInt16LE(1, 10);
  buf.writeUInt16LE(32, 12);
  buf.writeUInt32LE(imageSize, 14);
  buf.writeUInt32LE(headerSize + dirEntrySize, 18);

  // BITMAPINFOHEADER
  const dibOffset = headerSize + dirEntrySize;
  buf.writeUInt32LE(dibHeaderSize, dibOffset);
  buf.writeInt32LE(size, dibOffset + 4);
  buf.writeInt32LE(size * 2, dibOffset + 8);
  buf.writeUInt16LE(1, dibOffset + 12);
  buf.writeUInt16LE(32, dibOffset + 14);
  buf.writeUInt32LE(0, dibOffset + 16);
  buf.writeUInt32LE(pixelBytes + andMaskBytes, dibOffset + 20);

  // Draw glowing cyan Arc Reactor icon (bottom-up BGRA)
  const pixOffset = dibOffset + dibHeaderSize;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;

  for (let y = 0; y < size; y++) {
    const bmpY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = pixOffset + (bmpY * size + x) * 4;

      let r = 6;
      let g = 14;
      let b = 24;
      let a = 0;

      if (dist <= 15.2) {
        a = 255;
        // Dark metallic ring background
        r = 7;
        g = 16;
        b = 28;
        // Outer cyan ring
        if (dist >= 11.2 && dist <= 14.0) {
          r = 0;
          g = 212;
          b = 255;
        } else if (dist >= 7.2 && dist <= 9.2) {
          r = 40;
          g = 232;
          b = 255;
        } else if (dist <= 4.3) {
          r = 185;
          g = 248;
          b = 255;
        } else if (dist < 11.2 && dist > 9.2) {
          const angle = Math.atan2(dy, dx);
          const sector = Math.abs(Math.sin(angle * 4));
          if (sector > 0.72) {
            r = 0;
            g = 175;
            b = 225;
          }
        }
      }

      buf[idx] = b;
      buf[idx + 1] = g;
      buf[idx + 2] = r;
      buf[idx + 3] = a;
    }
  }

  fs.writeFileSync(targetPath, buf);
}

function main() {
  const linuxSmoke = process.argv.includes('--linux-smoke');

  console.log('[1/4] Building frontend production bundle (vite build)...');
  execSync('npm run build', { stdio: 'inherit', cwd: ROOT });

  if (!fs.existsSync(DIST_DIR)) {
    throw new Error('dist/ directory missing after vite build.');
  }

  console.log('[2/4] Embedding dist/ assets into desktop bundle...');
  fs.mkdirSync(DESKTOP_DIR, { recursive: true });
  fs.mkdirSync(RELEASE_DIR, { recursive: true });

  const files = collectDistFiles(DIST_DIR);
  const assetEntries: Record<string, { mime: string; b64: string }> = {};
  for (const f of files) {
    assetEntries[f.route] = {
      mime: getMimeType(f.absPath),
      b64: fs.readFileSync(f.absPath).toString('base64'),
    };
  }

  const tsOut = `// Auto-generated by scripts/build-exe.ts — do not edit manually\nexport const EMBEDDED_ASSETS: Record<string, { mime: string; b64: string }> = ${JSON.stringify(
    assetEntries
  )};\n`;
  fs.writeFileSync(GENERATED_ASSETS_FILE, tsOut, 'utf8');
  console.log(`Embedded ${files.length} frontend asset(s) cleanly.`);

  console.log('[3/4] Generating J.A.R.V.I.S. Windows icon...');
  writeArcReactorIco(ICON_FILE);

  console.log('[4/4] Compiling standalone Windows executable (.exe)...');
  const args = [
    'build',
    '--compile',
    '--target=bun-windows-x64',
    ...(process.platform === 'win32'
      ? [
          `--windows-icon=${ICON_FILE}`,
          '--windows-title=J.A.R.V.I.S. Mark LVII',
          '--windows-publisher=Mark LVII Systems',
          '--windows-version=57.0.0.0',
          '--windows-description=J.A.R.V.I.S. Mark LVII Holographic HUD Desktop',
        ]
      : []),
    path.join(DESKTOP_DIR, 'winLauncher.ts'),
    '--outfile',
    OUTPUT_EXE,
  ];

  const res = spawnSync('bun', args, { stdio: 'inherit', cwd: ROOT });
  if (res.status !== 0) {
    throw new Error(`bun build --compile failed with exit code ${res.status}`);
  }

  const stat = fs.statSync(OUTPUT_EXE);
  const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
  console.log(`SUCCESS: Built ${OUTPUT_EXE} (${sizeMB} MB)`);

  if (linuxSmoke) {
    const smokeBin = '/tmp/jarvis_desktop_smoke';
    console.log('[Smoke] Compiling Linux standalone binary for runtime verification...');
    const smokeRes = spawnSync(
      'bun',
      ['build', '--compile', path.join(DESKTOP_DIR, 'winLauncher.ts'), '--outfile', smokeBin],
      { stdio: 'inherit', cwd: ROOT }
    );
    if (smokeRes.status !== 0) {
      throw new Error('Linux smoke compile failed.');
    }
  }
}

main();
