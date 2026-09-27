// Tiny Zod-style validator (Zod is unavailable offline). Strict by default: unknown keys are errors.
// API is intentionally Zod-shaped so a later swap to Zod is mechanical.

export interface Issue { path: string; message: string }
export type Result<T> = { ok: true; value: T } | { ok: false; issues: Issue[] };

export abstract class Schema<T> {
  abstract check(v: unknown, path: string, issues: Issue[]): T | undefined;
  parse(v: unknown): Result<T> {
    const issues: Issue[] = [];
    const out = this.check(v, '$', issues);
    return issues.length ? { ok: false, issues } : { ok: true, value: out as T };
  }
  optional(): Schema<T | undefined> { return new Optional(this); }
  nullable(): Schema<T | null> { return new Nullable(this); }
  describe(d: string): this { (this as any)._desc = d; return this; }
  /** JSON Schema (draft 2020-12 subset). strictCompat: only keywords accepted by strict structured-output APIs. */
  abstract json(strictCompat: boolean): Record<string, unknown>;
}
class Nullable<T> extends Schema<T | null> {
  private inner: Schema<T>;
  constructor(inner: Schema<T>) { super(); this.inner = inner; }
  check(v: unknown, p: string, i: Issue[]) { return v === null ? null : this.inner.check(v, p, i); }
  json(s: boolean) { return { anyOf: [this.inner.json(s), { type: 'null' }] }; }
}
/** JSON Schema for any validator (used to enforce structured output at the model provider). */
export function toJsonSchema(schema: Schema<unknown>, strictCompat = false): Record<string, unknown> { return schema.json(strictCompat); }
class Optional<T> extends Schema<T | undefined> {
  private inner: Schema<T>;
  constructor(inner: Schema<T>) { super(); this.inner = inner; }
  isOptional = true;
  check(v: unknown, p: string, i: Issue[]) { return v === undefined ? undefined : this.inner.check(v, p, i); }
  json(s: boolean) { return this.inner.json(s); }
}

class Str extends Schema<string> {
  private o: { min?: number; max?: number; pattern?: RegExp; oneOf?: readonly string[] };
  constructor(o: { min?: number; max?: number; pattern?: RegExp; oneOf?: readonly string[] } = {}) { super(); this.o = o; }
  check(v: unknown, p: string, i: Issue[]) {
    if (typeof v !== 'string') { i.push({ path: p, message: `expected string, got ${typeof v}` }); return; }
    if (this.o.min !== undefined && v.length < this.o.min) i.push({ path: p, message: `string shorter than ${this.o.min}` });
    if (this.o.max !== undefined && v.length > this.o.max) i.push({ path: p, message: `string longer than ${this.o.max}` });
    if (this.o.pattern && !this.o.pattern.test(v)) i.push({ path: p, message: `does not match ${this.o.pattern}` });
    if (this.o.oneOf && !this.o.oneOf.includes(v)) i.push({ path: p, message: `"${v}" not one of [${this.o.oneOf.join(', ')}]` });
    return v;
  }
  json(s: boolean) {
    const j: Record<string, unknown> = { type: 'string' };
    if (this.o.oneOf) j.enum = [...this.o.oneOf];
    if (!s) { if (this.o.min !== undefined) j.minLength = this.o.min; if (this.o.max !== undefined) j.maxLength = this.o.max; if (this.o.pattern) j.pattern = this.o.pattern.source; }
    return j;
  }
}
class Num extends Schema<number> {
  private o: { min?: number; max?: number; int?: boolean };
  constructor(o: { min?: number; max?: number; int?: boolean } = {}) { super(); this.o = o; }
  check(v: unknown, p: string, i: Issue[]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) { i.push({ path: p, message: `expected finite number` }); return; }
    if (this.o.int && !Number.isInteger(v)) i.push({ path: p, message: `expected integer` });
    if (this.o.min !== undefined && v < this.o.min) i.push({ path: p, message: `${v} < min ${this.o.min}` });
    if (this.o.max !== undefined && v > this.o.max) i.push({ path: p, message: `${v} > max ${this.o.max}` });
    return v;
  }
  json(s: boolean) { const j: Record<string, unknown> = { type: this.o.int ? 'integer' : 'number' }; if (!s) { if (this.o.min !== undefined) j.minimum = this.o.min; if (this.o.max !== undefined) j.maximum = this.o.max; } return j; }
}
class Bool extends Schema<boolean> {
  check(v: unknown, p: string, i: Issue[]) { if (typeof v !== 'boolean') { i.push({ path: p, message: 'expected boolean' }); return; } return v; }
  json() { return { type: 'boolean' }; }
}
class Lit<T extends string | number | boolean> extends Schema<T> {
  private val: T;
  constructor(val: T) { super(); this.val = val; }
  check(v: unknown, p: string, i: Issue[]) { if (v !== this.val) { i.push({ path: p, message: `expected ${JSON.stringify(this.val)}` }); return; } return v as T; }
  json() { return { type: typeof this.val === 'number' ? 'number' : typeof this.val, enum: [this.val] }; }
}
class Arr<T> extends Schema<T[]> {
  private item: Schema<T>;
  private o: { min?: number; max?: number; len?: number };
  constructor(item: Schema<T>, o: { min?: number; max?: number; len?: number } = {}) { super(); this.item = item; this.o = o; }
  check(v: unknown, p: string, i: Issue[]) {
    if (!Array.isArray(v)) { i.push({ path: p, message: 'expected array' }); return; }
    if (this.o.len !== undefined && v.length !== this.o.len) i.push({ path: p, message: `expected length ${this.o.len}` });
    if (this.o.min !== undefined && v.length < this.o.min) i.push({ path: p, message: `expected at least ${this.o.min} items` });
    if (this.o.max !== undefined && v.length > this.o.max) i.push({ path: p, message: `expected at most ${this.o.max} items` });
    return v.map((x, k) => this.item.check(x, `${p}[${k}]`, i)) as T[];
  }
  json(s: boolean) { const j: Record<string, unknown> = { type: 'array', items: this.item.json(s) }; if (!s) { if (this.o.min !== undefined) j.minItems = this.o.min; if (this.o.max !== undefined) j.maxItems = this.o.max; if (this.o.len !== undefined) { j.minItems = this.o.len; j.maxItems = this.o.len; } } return j; }
}
type Shape = Record<string, Schema<any>>;
type Infer<S extends Shape> = { [K in keyof S as undefined extends SchemaT<S[K]> ? never : K]: SchemaT<S[K]> } & { [K in keyof S as undefined extends SchemaT<S[K]> ? K : never]?: SchemaT<S[K]> };
export type SchemaT<S> = S extends Schema<infer T> ? T : never;
class Obj<S extends Shape> extends Schema<Infer<S>> {
  readonly shape: S;
  private strict;
  constructor(shape: S, strict = true) { super(); this.shape = shape; this.strict = strict; }
  check(v: unknown, p: string, i: Issue[]) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) { i.push({ path: p, message: 'expected object' }); return; }
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(this.shape)) {
      const s = this.shape[k];
      if (!(k in o) && !(s as any).isOptional) { i.push({ path: `${p}.${k}`, message: 'required' }); continue; }
      const r = s.check(o[k], `${p}.${k}`, i);
      if (r !== undefined) out[k] = r;
    }
    if (this.strict) for (const k of Object.keys(o)) if (!(k in this.shape)) i.push({ path: `${p}.${k}`, message: 'unknown key (strict schema)' });
    return out as Infer<S>;
  }
  json(s: boolean) {
    const props: Record<string, unknown> = {}, req: string[] = [];
    for (const [k, sch] of Object.entries(this.shape)) { props[k] = sch.json(s); if (!(sch as any).isOptional) req.push(k); }
    return { type: 'object', properties: props, required: req, additionalProperties: !this.strict };
  }
}
class Rec<T> extends Schema<Record<string, T>> {
  private val: Schema<T>;
  private keyPattern?: RegExp;
  constructor(val: Schema<T>, keyPattern?: RegExp) { super(); this.val = val; this.keyPattern = keyPattern; }
  check(v: unknown, p: string, i: Issue[]) {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) { i.push({ path: p, message: 'expected object map' }); return; }
    const out: Record<string, T> = {};
    for (const [k, x] of Object.entries(v)) {
      if (this.keyPattern && !this.keyPattern.test(k)) i.push({ path: `${p}.${k}`, message: `key does not match ${this.keyPattern}` });
      out[k] = this.val.check(x, `${p}.${k}`, i) as T;
    }
    return out;
  }
  json(s: boolean) { return { type: 'object', additionalProperties: this.val.json(s) }; }
}
class Tuple<T extends unknown[]> extends Schema<T> {
  private items: Schema<any>[];
  constructor(items: Schema<any>[]) { super(); this.items = items; }
  check(v: unknown, p: string, i: Issue[]) {
    if (!Array.isArray(v) || v.length !== this.items.length) { i.push({ path: p, message: `expected tuple of ${this.items.length}` }); return; }
    return v.map((x, k) => this.items[k].check(x, `${p}[${k}]`, i)) as T;
  }
  json(s: boolean) { return { type: 'array', prefixItems: this.items.map((x) => x.json(s)), minItems: this.items.length, maxItems: this.items.length }; }
}
class Union<T> extends Schema<T> {
  private opts: Schema<any>[];
  constructor(opts: Schema<any>[]) { super(); this.opts = opts; }
  check(v: unknown, p: string, i: Issue[]) {
    let best: Issue[] | null = null;
    for (const o of this.opts) {
      const local: Issue[] = [];
      const r = o.check(v, p, local);
      if (!local.length) return r;
      if (!best || local.length < best.length) best = local;
    }
    i.push(...(best ?? [{ path: p, message: 'no union member matched' }]));
    return undefined;
  }
  json(s: boolean) { return { anyOf: this.opts.map((x) => x.json(s)) }; }
}
/** Discriminated union on a string key -> precise error messages. */
class DUnion<T> extends Schema<T> {
  private key: string;
  private map: Record<string, Schema<any>>;
  constructor(key: string, map: Record<string, Schema<any>>) { super(); this.key = key; this.map = map; }
  check(v: unknown, p: string, i: Issue[]) {
    const k = (v as any)?.[this.key];
    const s = typeof k === 'string' ? this.map[k] : undefined;
    if (!s) { i.push({ path: `${p}.${this.key}`, message: `"${k}" not one of [${Object.keys(this.map).join(', ')}]` }); return; }
    return s.check(v, p, i);
  }
  json(st: boolean) { return { anyOf: Object.values(this.map).map((x) => x.json(st)) }; }
}

export const v = {
  string: (o?: ConstructorParameters<typeof Str>[0]) => new Str(o),
  enum: <const E extends readonly string[]>(vals: E) => new Str({ oneOf: vals }) as unknown as Schema<E[number]>,
  id: () => new Str({ pattern: /^[a-z][a-z0-9_]*(-[a-z0-9_]+)*$/, max: 64 }),
  semver: () => new Str({ pattern: /^\d+\.\d+\.\d+$/ }),
  hexColor: () => new Str({ pattern: /^#[0-9a-f]{6}$/ }),
  number: (o?: ConstructorParameters<typeof Num>[0]) => new Num(o),
  int: (o: { min?: number; max?: number } = {}) => new Num({ ...o, int: true }),
  boolean: () => new Bool(),
  literal: <T extends string | number | boolean>(x: T) => new Lit(x),
  array: <T>(s: Schema<T>, o?: ConstructorParameters<typeof Arr>[1]) => new Arr(s, o),
  object: <S extends Shape>(s: S) => new Obj(s, true),
  looseObject: <S extends Shape>(s: S) => new Obj(s, false),
  record: <T>(s: Schema<T>, keyPattern?: RegExp) => new Rec(s, keyPattern),
  tuple: <T extends unknown[]>(...s: Schema<any>[]) => new Tuple<T>(s),
  vec3: () => new Tuple<[number, number, number]>([new Num(), new Num(), new Num()]),
  union: <T>(...s: Schema<any>[]) => new Union<T>(s),
  discriminated: <T>(key: string, map: Record<string, Schema<any>>) => new DUnion<T>(key, map),
};
