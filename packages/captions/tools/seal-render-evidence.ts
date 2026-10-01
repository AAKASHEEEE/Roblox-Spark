// Hash an already-rendered competitor-v2 artifact. This tool never renders/rewrites media and can only create a
// local integrity report: it deliberately cannot mint the independently retained worker/scheduler attestation.
import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildEvidenceReport, COMPARISON_SHEET_RECEIPT_FILE, DECODED_FRAME_RECEIPT_FILE } from './verify-render-v2.ts';
import { isPathInside, policyRealpath } from './render-paths.ts';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const { values } = parseArgs({ options: {
  manifest: { type: 'string', default: 'packages/captions/full-render-v2/render-input-manifest.json' },
  output: { type: 'string', default: 'packages/captions/full-render-v2/zapp-vs-kira-competitor-performance-v2.mp4' },
  evidenceDir: { type: 'string', default: 'packages/captions/full-render-v2' },
  report: { type: 'string', default: 'packages/captions/full-render-v2/render-evidence.json' },
} });
const fromRoot = (path: string): string => isAbsolute(path) ? resolve(path) : resolve(ROOT, path);
const reportPath = policyRealpath(fromRoot(values.report!));
const evidenceDir = policyRealpath(fromRoot(values.evidenceDir!));
if (!isPathInside(ROOT, reportPath) || !isPathInside(evidenceDir, reportPath)) throw new Error('report path must be inside the repository evidence directory');
const receiptPath = join(evidenceDir, DECODED_FRAME_RECEIPT_FILE);
const comparisonReceiptPath = join(evidenceDir, COMPARISON_SHEET_RECEIPT_FILE);
const evidence = buildEvidenceReport({
  root: ROOT,
  inputManifestPath: fromRoot(values.manifest!),
  outputPath: fromRoot(values.output!),
  evidenceDir,
  ...(existsSync(receiptPath) ? { decodedFrameReceiptPath: receiptPath } : {}),
  ...(existsSync(comparisonReceiptPath) ? { comparisonSheetReceiptPath: comparisonReceiptPath } : {}),
});
writeFileSync(reportPath, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ status: 'integrity-sealed-untrusted', trusted: false, reason: 'a separately signed worker attestation and independently configured public key are required', report: values.report, manifestSha256: evidence.inputManifest.sha256, outputSha256: evidence.output.sha256, mediaSha256: evidence.media.sha256, evidenceFiles: evidence.evidence.length }, null, 2));
