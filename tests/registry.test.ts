// Action registration + capabilities: every schema action has an engine implementation, character locks only use
// known actions, templates only offer available actions, and the registry is derived (not hand-maintained twice).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACTIONS } from '../packages/schema/src/episode.ts';
import { ACTION_DEFS, IMPLEMENTED_ACTIONS } from '../packages/engine/src/animation/actions.ts';
import { buildRegistry, ACTION_CAPS } from '../packages/story/src/registry.ts';
import { SLOT_SPECS } from '../packages/story/src/templates.ts';
import { lib } from './helpers.ts';

test('every schema action is implemented by the engine (29/29) and nothing else is', () => {
  assert.equal(ACTIONS.length, 29);
  for (const a of ACTIONS) assert.ok(ACTION_DEFS[a], `${a} not implemented`);
  assert.deepEqual([...IMPLEMENTED_ACTIONS].sort(), [...ACTIONS].sort());
});

test('every action has a capability entry; character locks only allow known actions', () => {
  for (const a of ACTIONS) assert.ok(ACTION_CAPS[a], `${a} has no capability entry`);
  for (const c of Object.values(lib.characters)) for (const a of c.allowedActions) assert.ok((ACTIONS as readonly string[]).includes(a), `${c.id}@${c.version}: ${a}`);
});

test('templates only offer actions that are available to the generator', () => {
  const reg = buildRegistry(lib);
  for (const [slot, spec] of Object.entries(SLOT_SPECS)) for (const a of spec.allowedActions) if (a !== 'none') assert.equal(reg.actions[a]?.availability.status, 'available', `${slot}: ${a}`);
  for (const [slot, spec] of Object.entries(SLOT_SPECS)) if (spec.defaultAction !== 'none') assert.ok(spec.allowedActions.includes(spec.defaultAction), slot);
});

test('registry ids.actions is exactly the available set', () => {
  const reg = buildRegistry(lib);
  assert.deepEqual([...reg.ids.actions].sort(), Object.entries(reg.actions).filter(([, c]) => c.availability.status === 'available').map(([k]) => k).sort());
  assert.equal(reg.ids.actions.length, 23); // 29 implemented - 5 hand actions - hover
});
