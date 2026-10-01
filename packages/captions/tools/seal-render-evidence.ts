// Hash and seal an already-rendered competitor-v2 artifact. This tool never renders or rewrites media.
import { writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildEvidenceReport } from './verify-render-v2.ts';
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
const evidence = buildEvidenceReport({
  root: ROOT,
  inputManifestPath: fromRoot(values.manifest!),
  outputPath: fromRoot(values.output!),
  evidenceDir,
});
writeFileSync(reportPath, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ status: 'sealed', report: values.report, manifestSha256: evidence.inputManifest.sha256, outputSha256: evidence.output.sha256, mediaSha256: evidence.media.sha256, evidenceFiles: evidence.evidence.length }, null, 2));
