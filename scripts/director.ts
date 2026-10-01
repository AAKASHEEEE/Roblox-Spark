#!/usr/bin/env node
// Offline-first script-to-BeatSheet CLI. No rendering/MP4 work occurs here.
//
// node scripts/director.ts --script script.txt --duration 30 --seed 7 --provider offline \
//   --out out/script.beats.json --report out/script.director-report.json
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { directScript } from '../packages/director/src/pipeline.ts';
import { DIRECTOR_ALGORITHM_VERSION, DIRECTOR_EDIT_PLAN_POLICY, normalizeDirectorRequest, type DirectorMode } from '../packages/director/src/offline.ts';
import { normalizeFreeModelList } from '../packages/director/src/openrouter.ts';
import { NodeDirectorCache, shouldCacheDirectorResult, type DirectorCacheDescriptor } from '../packages/director/node/cache.ts';

const USAGE = `Usage:
  node scripts/director.ts --script <file|-> --duration <seconds> --seed <integer> \\
    --provider <offline|openrouter|auto> --out <beat-sheet.json> --report <report.json> \\
    [--models <model-a:free,model-b:free>] [--timeout-ms <ms>] [--cache-dir <dir>|--no-cache]

Environment:
  OPENROUTER_API_KEY   Required only for --provider openrouter; auto falls back offline.
  OPENROUTER_MODELS    Optional comma-separated free-only model list (default: openrouter/free).
`;

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(USAGE); process.exit(0); }
const allowed = new Set(['--script', '--duration', '--seed', '--provider', '--out', '--report', '--models', '--timeout-ms', '--cache-dir', '--no-cache']);
for (const arg of argv) if (arg.startsWith('-') && !allowed.has(arg) && arg !== '-') fail(`unknown option ${arg}`);
function option(name: string, required = false): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) { if (required) fail(`missing --${name}\n\n${USAGE}`); return undefined; }
  const value = argv[index + 1];
  if (value === undefined || (value.startsWith('--') && value !== '-')) fail(`--${name} requires a value`);
  return value;
}
function numeric(name: string, integer = false): number {
  const raw = option(name, true)!;
  const value = Number(raw);
  if (!Number.isFinite(value) || (integer && !Number.isInteger(value))) fail(`--${name} must be ${integer ? 'an integer' : 'a number'}`);
  return value;
}

const scriptArg = option('script', true)!;
const provider = option('provider', true)! as DirectorMode;
if (!['offline', 'openrouter', 'auto'].includes(provider)) fail('--provider must be offline, openrouter, or auto');
const duration = numeric('duration'), seed = numeric('seed', true);
const outputPath = resolve(option('out', true)!);
const reportPath = resolve(option('report', true)!);
const scriptText = scriptArg === '-' ? readFileSync(0, 'utf8') : readFileSync(resolve(scriptArg), 'utf8');
const request = normalizeDirectorRequest({ script: scriptText, duration, seed });
const key = process.env.OPENROUTER_API_KEY?.trim();
if (provider === 'openrouter' && !key) fail('OPENROUTER_API_KEY is not set');
if (outputPath === reportPath) fail('--out and --report must be different files');
const modelSetting = option('models') ?? process.env.OPENROUTER_MODELS;
const models = provider === 'openrouter' || (provider === 'auto' && Boolean(key)) ? safeModels(modelSetting) : [];
const timeoutMs = option('timeout-ms') ? numeric('timeout-ms', true) : 12_000;
const planningKey = {
  editPlan: {
    version: DIRECTOR_EDIT_PLAN_POLICY.version,
    minimumSegmentSeconds: DIRECTOR_EDIT_PLAN_POLICY.minimumSegmentSeconds,
    targetAverageSeconds: DIRECTOR_EDIT_PLAN_POLICY.targetAverageSeconds,
    maximumSubShots: DIRECTOR_EDIT_PLAN_POLICY.maximumSubShots,
  },
  coverage: { version: DIRECTOR_EDIT_PLAN_POLICY.coverageVersion },
} as const;
const descriptor: DirectorCacheDescriptor & typeof planningKey = {
  algorithmVersion: DIRECTOR_ALGORITHM_VERSION,
  request,
  provider,
  models,
  timeoutMs: provider === 'offline' ? null : timeoutMs,
  openRouterConfigured: provider !== 'offline' && Boolean(key),
  ...planningKey,
};

try {
  const cache = argv.includes('--no-cache') ? null : new NodeDirectorCache(resolve(option('cache-dir') ?? 'out/director-cache'));
  const cached = cache?.get(descriptor) ?? null;
  const result = cached?.value ?? await directScript({ script: request.lines, duration: request.duration, seed: request.seed }, {
    provider,
    ...(provider === 'offline' ? {} : { openrouter: { apiKey: key, models, timeoutMs } }),
  });
  const cacheable = Boolean(cache && shouldCacheDirectorResult(descriptor, result));
  const digest = cached?.digest ?? (cacheable ? cache!.put(descriptor, result) : undefined);
  const cacheReport = { enabled: Boolean(cache), hit: Boolean(cached), stored: Boolean(digest), keyMetadata: planningKey, ...(digest ? { digest } : {}) };
  writeAtomic(outputPath, `${JSON.stringify(result.sheet, null, 2)}\n`);
  writeAtomic(reportPath, `${JSON.stringify({ ...result.report, cache: cacheReport, input: { script: scriptArg, duration, seed, lineCount: request.lines.length } }, null, 2)}\n`);
  const cacheStatus = !cache ? 'disabled' : cached ? 'hit' : cacheable ? 'miss' : 'miss (transient fallback not stored)';
  process.stdout.write(`Director ${result.report.provider.used}: ${result.sheet.beats.length} beat(s), cache ${cacheStatus}\n`);
  process.stdout.write(`BeatSheet: ${outputPath}\nReport: ${reportPath}\n`);
} catch (error) {
  const raw = error instanceof Error ? error.message : 'Director failed';
  const safe = key ? raw.split(key).join('[redacted]') : raw;
  fail(safe);
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  const fd = openSync(temp, 'w', 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
}
function safeModels(setting: string | undefined): string[] {
  try { return normalizeFreeModelList(setting?.split(',')); }
  catch (error) { fail(error instanceof Error ? error.message : 'invalid OpenRouter model list'); }
}
function fail(message: string): never { process.stderr.write(`director: ${message}\n`); process.exit(1); }
