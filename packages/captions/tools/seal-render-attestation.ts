// Trusted-worker finalization. Unlike seal-render-evidence.ts, this requires an externally injected Ed25519 key.
// The key must not be readable from the repository/job environment; the signed envelope must be retained by the
// scheduler/control plane and supplied independently to the verifier.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalJson, manifestDigest, parseJsonBytes, readBoundedFile, readInputManifest, RENDER_BYTE_LIMITS } from './render-manifest.ts';
import { buildEvidenceReport, COMPARISON_SHEET_RECEIPT_FILE, createSignedPostRenderAttestation, DECODED_FRAME_RECEIPT_FILE, parseEvidenceReport } from './verify-render-v2.ts';
import { isPathInside, policyRealpath } from './render-paths.ts';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const { values } = parseArgs({ options: {
  manifest: { type: 'string', default: 'out/render-authorizations/job-manifest.json' },
  output: { type: 'string' }, evidenceDir: { type: 'string' }, report: { type: 'string' },
  privateKey: { type: 'string' }, keyId: { type: 'string' }, attestationOut: { type: 'string' },
} });
for (const option of ['output', 'evidenceDir', 'report', 'privateKey', 'keyId', 'attestationOut'] as const) {
  if (!values[option]) throw new Error(`--${option} is required`);
}
const fromRoot = (path: string): string => isAbsolute(path) ? resolve(path) : resolve(ROOT, path);
const evidenceDir = policyRealpath(fromRoot(values.evidenceDir!));
const reportPath = policyRealpath(fromRoot(values.report!));
const receiptPath = join(evidenceDir, DECODED_FRAME_RECEIPT_FILE);
const comparisonReceiptPath = join(evidenceDir, COMPARISON_SHEET_RECEIPT_FILE);
if (!isPathInside(evidenceDir, reportPath)) throw new Error('evidence report must be inside the worker evidence directory');
if (!existsSync(receiptPath)) throw new Error('trusted-worker attestation requires the decoded-frame receipt from the completed MP4');
if (!existsSync(comparisonReceiptPath)) throw new Error('trusted-worker attestation requires the authenticated comparison-sheet builder receipt');
const manifestPath = fromRoot(values.manifest!);
const manifest = readInputManifest(manifestPath);
if (manifest.provenance !== 'pre-render-authorized' || manifest.job.workerSafe !== true) throw new Error('attestation requires a pre-render-authorized worker-safe manifest');
const suppliedReport = parseEvidenceReport(parseJsonBytes(readBoundedFile(reportPath, RENDER_BYTE_LIMITS.evidenceReport, 'evidence report'), 'evidence report'));
const rebuiltReport = buildEvidenceReport({
  root: ROOT, inputManifestPath: manifestPath, outputPath: fromRoot(values.output!), evidenceDir,
  decodedFrameReceiptPath: receiptPath, comparisonSheetReceiptPath: comparisonReceiptPath,
});
if (canonicalJson(suppliedReport) !== canonicalJson(rebuiltReport)) throw new Error('evidence report is stale; seal current output/evidence before worker attestation');
if (rebuiltReport.inputManifest.sha256 !== manifestDigest(manifest)) throw new Error('evidence report does not bind the authorized manifest');
const privateKeyPath = policyRealpath(fromRoot(values.privateKey!));
if (isPathInside(ROOT, privateKeyPath, true)) throw new Error('worker attestation private key must be injected from outside the repository/job filesystem');
const privateKey = readBoundedFile(privateKeyPath, RENDER_BYTE_LIMITS.attestationKey, 'worker attestation private key');
const attestation = createSignedPostRenderAttestation(manifest, rebuiltReport, privateKey, values.keyId!);
const attestationPath = policyRealpath(fromRoot(values.attestationOut!));
if (isPathInside(evidenceDir, attestationPath, true)) throw new Error('signed attestation must be retained outside the writable artifact directory');
mkdirSync(dirname(attestationPath), { recursive: true });
writeFileSync(attestationPath, JSON.stringify(attestation, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ status: 'signed-worker-attestation-created', trusted: false, reason: 'trust is decided only by an independent verifier with the configured public key', keyId: attestation.keyId, manifestSha256: rebuiltReport.inputManifest.sha256, outputSha256: rebuiltReport.output.sha256, attestation: values.attestationOut }, null, 2));
