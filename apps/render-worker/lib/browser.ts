// Locates playwright-core + a Chromium build without requiring network installs.
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

export function loadPlaywright(): any {
  const candidates = [
    process.env.PLAYWRIGHT_CORE_PATH,
    'playwright-core',
    'playwright',
    // globally installed tooling (e.g. @playwright/mcp) — used in offline sandboxes
    ...(process.env.NVM_BIN ? [join(process.env.NVM_BIN, '../lib/node_modules/@playwright/mcp/node_modules/playwright-core')] : []),
    join(process.execPath, '../../lib/node_modules/@playwright/mcp/node_modules/playwright-core'),
    join(process.execPath, '../../lib/node_modules/playwright-core'),
    join(process.execPath, '../../lib/node_modules/playwright'),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  throw new Error('playwright-core not found. Install with `npm i -D playwright-core` or set PLAYWRIGHT_CORE_PATH.');
}

export function findChromium(): string | undefined {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/playwright', join(process.env.HOME ?? '', '.cache/ms-playwright')].filter(Boolean) as string[];
  for (const r of roots) {
    if (!existsSync(r)) continue;
    // Full Chromium is required: headless-shell lacks nothing we need, but full build has proprietary codec playback for QA.
    for (const d of readdirSync(r).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      const p = join(r, d, 'chrome-linux64', 'chrome');
      if (existsSync(p)) return p;
      const p2 = join(r, d, 'chrome-linux', 'chrome');
      if (existsSync(p2)) return p2;
    }
  }
  return undefined; // let playwright pick its default
}

export interface LaunchOptions { gpu?: boolean }

export async function launchBrowser(opts: LaunchOptions = {}): Promise<any> {
  const pw = loadPlaywright();
  const args = opts.gpu
    ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=vulkan', '--enable-features=Vulkan']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  args.push('--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--force-color-profile=srgb', '--js-flags=--max-old-space-size=4096');
  return pw.chromium.launch({ executablePath: findChromium(), headless: true, args });
}
