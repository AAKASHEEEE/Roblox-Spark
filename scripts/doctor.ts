// Environment check + build: `npm run setup`. Verifies Node, TypeScript, playwright-core, Chromium, WebGL2, H.264 + Opus WebCodecs.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadPlaywright, findChromium, launchBrowser } from '../apps/render-worker/lib/browser.ts';
import { startServer, ROOT } from '../apps/render-worker/lib/server.ts';
import { loadLibrary } from '../apps/render-worker/lib/library.ts';

let fail = false;
const ok = (m: string) => console.log('  ✔ ' + m);
const bad = (m: string) => { console.log('  ✘ ' + m); fail = true; };
console.log('RBLX SPARK doctor');
const [maj, min] = process.versions.node.split('.').map(Number);
(maj > 22 || (maj === 22 && min >= 18)) ? ok(`node ${process.version} (native TypeScript)`) : bad(`node ${process.version}: need >= 22.18`);
const tsc = existsSync(join(ROOT, 'node_modules/.bin/tsc')) ? join(ROOT, 'node_modules/.bin/tsc') : 'tsc';
try { ok('typescript ' + execFileSync(tsc, ['-v']).toString().trim()); execFileSync(tsc, ['-p', 'tsconfig.web.json'], { cwd: ROOT, stdio: 'inherit' }); ok('browser bundle built -> dist/'); } catch { bad('TypeScript >= 5.8 not found (npm install)'); }
try { loadPlaywright(); ok('playwright-core found'); } catch (e) { bad(String(e)); }
const chrome = findChromium();
chrome ? ok('chromium: ' + chrome) : console.log('  ! no Chromium found in known paths; run `npx playwright install chromium` (playwright default will be tried)');
const lib = loadLibrary();
lib.errors.length ? bad('asset library: ' + lib.errors.join('; ')) : ok(`asset library: ${Object.keys(lib.hashes).length} locked manifests`);
if (!fail) {
  const { server, url } = await startServer(0);
  const b = await launchBrowser();
  const p = await b.newPage();
  await p.goto(`${url}/apps/studio/blank.html`);
  const caps = await p.evaluate(async () => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const e = gl?.getExtension('WEBGL_debug_renderer_info');
    const v = typeof VideoEncoder !== 'undefined' && (await VideoEncoder.isConfigSupported({ codec: 'avc1.640028', width: 1080, height: 1920, bitrate: 8e6, framerate: 30 })).supported;
    const a = typeof AudioEncoder !== 'undefined' && (await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 })).supported;
    return { webgl2: !!gl, renderer: gl ? gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : null, h264: v, opus: a };
  });
  await b.close(); server.close();
  caps.webgl2 ? ok('WebGL2: ' + caps.renderer) : bad('WebGL2 unavailable in headless Chromium');
  caps.h264 ? ok('WebCodecs H.264 1080x1920 encoder') : bad('WebCodecs H.264 encoder unavailable');
  caps.opus ? ok('WebCodecs Opus encoder') : bad('WebCodecs Opus encoder unavailable');
}
console.log(fail ? '\nNOT READY' : '\nREADY — `npm start` (studio) or `npm run render:poc` (one-command MP4)');
process.exit(fail ? 1 : 0);
