// Compact, untrusted staging intent returned by a remote Director provider.
// The provider suggests plain catalog ids/tags only; the deterministic matcher remains authoritative.
import { v, toJsonSchema, type Issue, type SchemaT } from '../../schema/src/v.ts';

const query = () => v.string({ max: 64 });

export const DirectorIntentSchema = v.object({
  set: query(),
  characters: v.array(query(), { max: 8 }),
  beats: v.array(v.object({
    line: v.int({ min: 0, max: 199 }),
    action: query(),
    props: v.array(query(), { max: 16 }),
  }), { min: 1, max: 200 }),
});

export type DirectorIntent = SchemaT<typeof DirectorIntentSchema>;
export interface IntentValidation {
  ok: boolean;
  issues: Issue[];
  value?: DirectorIntent;
}

/** Strict structural validation plus exactly one ordered intent row per script line. */
export function validateDirectorIntent(input: unknown, lineCount: number): IntentValidation {
  const parsed = DirectorIntentSchema.parse(input);
  if (!parsed.ok) return { ok: false, issues: parsed.issues };
  const issues: Issue[] = [];
  if (parsed.value.beats.length !== lineCount) {
    issues.push({ path: '$.beats', message: `expected exactly ${lineCount} beat intents` });
  }
  for (let i = 0; i < parsed.value.beats.length; i++) {
    if (parsed.value.beats[i].line !== i) {
      issues.push({ path: `$.beats[${i}].line`, message: `expected ordered line index ${i}` });
    }
  }
  return issues.length ? { ok: false, issues } : { ok: true, issues: [], value: parsed.value };
}

/** Strict JSON Schema sent to OpenAI-compatible structured-output endpoints. */
export const directorIntentJsonSchema = (): Record<string, unknown> => toJsonSchema(DirectorIntentSchema, true);
