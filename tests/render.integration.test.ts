// Browser integration: the same engine used for final renders produces identical pixels for the same t,
// the press contact is exact, and the loop frame matches the opening. Skips if no Chromium is available.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { launchBrowser } from '../apps/render-worker/lib/browser.ts';
import { startServer } from '../apps/render-worker/lib/server.ts';
import { ensureWebBuild } from '../apps/render-worker/render.ts';
import { lib, sample } from './helpers.ts';

test('headless engine: deterministic stills, hand contact, loop match, no hard framing errors', { timeout: 180000 }, async () => {
  ensureWebBuild(() => {});
  const { server, url } = await startServer(0);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`${url}/apps/studio/render.html`);
    await page.waitForFunction(() => (window as any).__spark?.ready);
    const info = await page.evaluate(([e, l]: any) => (window as any).__spark.load(e, l, 270, 480), [sample(), lib]);
    const h = (d: string) => createHash('sha256').update(d).digest('hex');
    const a = await page.evaluate(() => (window as any).__spark.still(9.5));
    await page.evaluate(() => (window as any).__spark.still(3.0)); // disturb state
    const b = await page.evaluate(() => (window as any).__spark.still(9.5));
    assert.equal(h(a), h(b), 'random access render of t=9.5 must be identical');
    const c = await page.evaluate((ts: number[]) => (window as any).__spark.analyze(ts), info.contacts.map((x: any) => x.t));
    assert.ok(c[0].handErrors.zapp < 0.02, `hand-to-button ${c[0].handErrors.zapp}`);
    const times = Array.from({ length: 34 }, (_, i) => i * 0.5);
    const an = await page.evaluate((ts: number[]) => (window as any).__spark.analyze(ts), times);
    const hard = an.flatMap((x: any) => x.issues).filter((i: any) => ['SUBJECT_OUT_OF_FRAME', 'SUBJECT_BEHIND_CAMERA', 'FACE_OUT_OF_FRAME', 'FACE_OCCLUDED'].includes(i.code));
    assert.deepEqual(hard, []);
    const first = await page.evaluate(() => (window as any).__spark.analyze([0, 16.999]));
    const d = first[0].cam.map((v: number, i: number) => Math.abs(v - first[1].cam[i]));
    assert.ok(Math.max(...d) < 0.05, `loop camera mismatch ${d}`);
  } finally { await browser.close(); server.close(); }
});
