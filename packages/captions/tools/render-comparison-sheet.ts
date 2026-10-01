// Worker-safe comparison-sheet builder. It consumes only the authenticated completed-output frame receipt and exact
// committed PNG bytes, then records the JPEG and authenticated runtime identity for finalization.
import { createRequire } from 'node:module';
import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalJson, hashDirectoryTree, hashFile, manifestDigest, readAuthenticatedFile, readBoundedFile, readInputManifest, RENDER_BYTE_LIMITS, sha256Bytes } from './render-manifest.ts';
import { COMPARISON_SHEET_RECEIPT_FILE, COMPARISON_SHEET_RECEIPT_SCHEMA, DECODED_FRAME_RECEIPT_FILE, readDecodedFrameReceipt, validateDecodedFrameClaims, type ComparisonSheetReceipt } from './verify-render-v2.ts';
import { isPathInside, policyRealpath, requireContainedPath, requireExecutable } from './render-paths.ts';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const requireFromHere = createRequire(import.meta.url);
const { values } = parseArgs({ options: {
  manifest: { type: 'string' }, authorizedManifestSha256: { type: 'string' }, evidenceDir: { type: 'string' },
  playwrightCore: { type: 'string' }, chromium: { type: 'string' },
} });
for (const option of ['manifest', 'authorizedManifestSha256', 'evidenceDir', 'playwrightCore', 'chromium'] as const) if (!values[option]) throw new Error(`--${option} is required`);
const fromRoot = (path: string): string => isAbsolute(path) ? resolve(path) : resolve(ROOT, path);
const manifestPath = requireContainedPath('input manifest', fromRoot(values.manifest!), [resolve(ROOT, 'out/render-authorizations')]);
const evidenceDir = requireContainedPath('evidence directory', fromRoot(values.evidenceDir!), [resolve(ROOT, 'out/render-jobs')]);
const playwrightCore = requireContainedPath('playwright-core', fromRoot(values.playwrightCore!), [resolve(ROOT, 'node_modules')]);
const chromium = requireExecutable('chromium', fromRoot(values.chromium!));
requireContainedPath('chromium', chromium, [resolve(ROOT, 'node_modules'), '/opt/playwright', resolve(process.env.HOME ?? ROOT, '.cache/ms-playwright')]);
const manifest = readInputManifest(manifestPath);
if (manifest.provenance !== 'pre-render-authorized' || manifest.job.workerSafe !== true) throw new Error('comparison builder requires a pre-render-authorized worker-safe manifest');
if (manifestDigest(manifest) !== values.authorizedManifestSha256) throw new Error('comparison builder manifest does not match the scheduler-authorized digest');
if (!manifest.runtime.playwrightTreeSha256 || hashDirectoryTree(playwrightCore) !== manifest.runtime.playwrightTreeSha256) throw new Error('comparison builder Playwright runtime does not match authorization');
if (!manifest.runtime.chromiumSha256 || hashFile(chromium).sha256 !== manifest.runtime.chromiumSha256) throw new Error('comparison builder Chromium runtime does not match authorization');
const outputPath = policyRealpath(resolve(ROOT, manifest.job.outputPath));
if (!isPathInside(evidenceDir, outputPath)) throw new Error('authorized MP4 is outside this worker evidence directory');
const decodedReceipt = readDecodedFrameReceipt(join(evidenceDir, DECODED_FRAME_RECEIPT_FILE));
readAuthenticatedFile(outputPath, { sha256: decodedReceipt.outputSha256 }, RENDER_BYTE_LIMITS.output, 'completed render output');
const claims = validateDecodedFrameClaims(decodedReceipt.outputSha256, decodedReceipt.frames.map((frame) => ({ ...frame, outputSha256: decodedReceipt.outputSha256 })));
const frames = [...claims.values()].sort((a, b) => a.timestampSec - b.timestampSec).map((claim) => {
  const path = policyRealpath(join(evidenceDir, claim.file));
  if (!isPathInside(evidenceDir, path)) throw new Error(`decoded frame ${claim.file} escapes the evidence directory`);
  const bytes = readAuthenticatedFile(path, claim, RENDER_BYTE_LIMITS.evidenceImage, `decoded frame ${claim.file}`);
  return { claim, dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` };
});
const comparisonPath = join(evidenceDir, 'comparison-sheet.jpg'), receiptPath = join(evidenceDir, COMPARISON_SHEET_RECEIPT_FILE);
if (existsSync(comparisonPath) || existsSync(receiptPath)) throw new Error('comparison sheet output/receipt already exists; worker-safe generation never overwrites evidence');
const playwright = requireFromHere(playwrightCore);
if (!playwright?.chromium?.launch) throw new Error('authorized Playwright runtime does not expose chromium.launch');
if (hashDirectoryTree(playwrightCore) !== manifest.runtime.playwrightTreeSha256 || hashFile(chromium).sha256 !== manifest.runtime.chromiumSha256) throw new Error('comparison builder runtime changed before launch');
const browser = await playwright.chromium.launch({ executablePath: chromium, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--force-color-profile=srgb'] });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1800 }, deviceScaleFactor: 1 });
  const cards = frames.map(({ claim, dataUrl }) => `<figure><img src="${dataUrl}"><figcaption>${claim.file} · ${claim.timestampSec.toFixed(2)}s · ${claim.sha256.slice(0, 16)}</figcaption></figure>`).join('');
  await page.setContent(`<style>html,body{margin:0;background:#10131a;color:#fff;font:20px system-ui}main{padding:30px;display:grid;grid-template-columns:1fr 1fr;gap:24px}h1{grid-column:1/-1}figure{margin:0;background:#1d2330;padding:14px;border-radius:12px}img{display:block;width:100%;height:auto}figcaption{padding-top:10px;font:14px ui-monospace}</style><main><h1>Completed MP4 decoded frames · ${decodedReceipt.outputSha256.slice(0, 20)}</h1>${cards}</main>`, { waitUntil: 'load' });
  await page.screenshot({ path: comparisonPath, type: 'jpeg', quality: 92, fullPage: true });
  await page.close();
} finally { await browser.close(); }
const comparisonBytes = readBoundedFile(comparisonPath, RENDER_BYTE_LIMITS.evidenceImage, 'comparison sheet');
const receipt: ComparisonSheetReceipt = {
  schema: COMPARISON_SHEET_RECEIPT_SCHEMA, outputSha256: decodedReceipt.outputSha256, frames: decodedReceipt.frames,
  comparison: { sha256: sha256Bytes(comparisonBytes), bytes: comparisonBytes.length },
  runtime: { playwrightTreeSha256: manifest.runtime.playwrightTreeSha256, chromiumSha256: manifest.runtime.chromiumSha256 },
};
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: 'comparison-sheet-built-from-authenticated-decoded-frames', outputSha256: receipt.outputSha256, framesSha256: sha256Bytes(canonicalJson(receipt.frames)), comparison: receipt.comparison, receipt: COMPARISON_SHEET_RECEIPT_FILE }, null, 2));
