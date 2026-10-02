import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.ts';

interface CameraDeclaration {
  recipeId: string;
  subject: string;
  secondary?: string;
}

interface SubShot extends CameraDeclaration {
  from: number;
}

interface Beat {
  phraseId: string;
  start: number;
  end: number;
  text: string;
  camera: CameraDeclaration & { subShots?: SubShot[] };
  captions: Array<{ start: number; end: number; text: string }>;
}

const fixture = JSON.parse(readFileSync(join(ROOT, 'packages/director/fixtures/free-coins-classroom.beats.json'), 'utf8')) as { beats: Beat[] };
const narrated = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/narrated/approved-narrated-v0.1.json'), 'utf8')) as {
  script: { phrases: Array<{ id: string; start: number; end: number; text: string }> };
};

const beat = (phraseId: string): Beat => {
  const found = fixture.beats.find((candidate) => candidate.phraseId === phraseId);
  assert.ok(found, `missing fixture beat ${phraseId}`);
  return found;
};

const cameraAt = (phraseId: string, time: number): CameraDeclaration => {
  const current = beat(phraseId);
  assert.ok(time >= current.start && time < current.end, `${phraseId} does not contain ${time}`);
  return [current.camera, ...(current.camera.subShots ?? [])]
    .filter((camera) => !('from' in camera) || camera.from <= time + 1e-9)
    .at(-1)!;
};

const assertCamera = (
  phraseId: string,
  time: number,
  expected: CameraDeclaration,
  purpose: string,
): void => {
  const actual = cameraAt(phraseId, time);
  assert.deepEqual(
    { recipeId: actual.recipeId, subject: actual.subject, secondary: actual.secondary },
    { recipeId: expected.recipeId, subject: expected.subject, secondary: expected.secondary },
    `${purpose} (${phraseId} at ${time.toFixed(3)} s)`,
  );
};

test('approved narration words and phrase timing remain byte-for-byte authored', () => {
  assert.deepEqual(
    fixture.beats.map(({ phraseId: id, start, end, text }) => ({ id, start, end, text })),
    narrated.script.phrases.map(({ id, start, end, text }) => ({ id, start, end, text })),
  );
});

test('key narration windows select the intended semantic subject and composition', () => {
  const windows: Array<[string, number, CameraDeclaration, string]> = [
    ['p01', 2.45, { recipeId: 'wide_environment', subject: 'teacher', secondary: 'kira' }, 'hook holds teacher, doorway, and lead context'],
    ['p01', 3.20, { recipeId: 'wide_environment', subject: 'zapp', secondary: 'kira' }, 'hook hands focus to both leads while the teacher exits'],
    ['p05', 23.20, { recipeId: 'insert_prop', subject: 'suspicious_button' }, 'clean button reveal'],
    ['p07', 32.25, { recipeId: 'prop_ecu', subject: 'suspicious_button' }, 'button contact'],
    ['p07', 32.80, { recipeId: 'prop_ecu', subject: 'suspicious_button' }, 'coin spawns on the button contact surface'],
    ['p07', 33.20, { recipeId: 'prop_ecu', subject: 'suspicious_button' }, 'spawned coin holds in close contact context'],
    ['p07', 33.80, { recipeId: 'insert_prop', subject: 'spark_coin' }, 'coin insert readability'],
    ['p09', 42.20, { recipeId: 'final_loop', subject: 'spark_coin', secondary: 'zapp' }, 'growth onset'],
    ['p10', 45.00, { recipeId: 'final_loop', subject: 'spark_coin' }, 'coin-to-desk scale'],
    ['p10', 46.80, { recipeId: 'final_loop', subject: 'spark_coin', secondary: 'zapp' }, 'coin-to-Zapp width scale'],
    ['p10', 48.80, { recipeId: 'wide_environment', subject: 'spark_coin', secondary: 'kira' }, 'coin-to-room scale'],
    ['p12', 56.30, { recipeId: 'final_loop', subject: 'spark_coin', secondary: 'zapp' }, 'coin tip'],
    ['p12', 56.936, { recipeId: 'final_loop', subject: 'spark_coin', secondary: 'zapp' }, 'exact impact'],
    ['p12', 57.50, { recipeId: 'final_loop', subject: 'spark_coin', secondary: 'zapp' }, 'flattened Zapp result during matching words'],
    ['p12', 58.30, { recipeId: 'reaction_punch_in', subject: 'kira' }, 'Kira reaction only after the flatten line'],
    ['p12', 58.90, { recipeId: 'final_loop', subject: 'spark_coin', secondary: 'zapp' }, 'floor consequence'],
    ['p13', 60.80, { recipeId: 'wide_environment', subject: 'kira' }, 'doorway hold keeps Kira safe until the teacher enters'],
    ['p13', 62.40, { recipeId: 'wide_environment', subject: 'teacher', secondary: 'kira' }, 'teacher return and Kira reaction share the frame'],
    ['p13', 63.80, { recipeId: 'reaction_punch_in', subject: 'kira', secondary: 'teacher' }, 'Kira stillness reaction'],
    ['p14', 67.20, { recipeId: 'insert_prop', subject: 'suspicious_button' }, 'reset insert'],
    ['p14', 68.50, { recipeId: 'prop_ecu', subject: 'suspicious_button' }, 'readable loop-closing reset'],
  ];

  for (const [phraseId, time, expected, purpose] of windows) assertCamera(phraseId, time, expected, purpose);
});

test('the complete FLATTENS Zapp line never cuts to unrelated Kira coverage', () => {
  const current = beat('p12');
  const flatten = current.captions.find((caption) => /FLATTENS Zapp/.test(caption.text));
  assert.ok(flatten, 'p12 has an explicit flatten narration window');

  const cameras = [current.camera, ...(current.camera.subShots ?? [])];
  const cuts = [current.start, ...(current.camera.subShots ?? []).map(({ from }) => from), current.end];
  const overlapping = cameras
    .map((camera, index) => ({ camera, start: cuts[index], end: cuts[index + 1] }))
    .filter((composition) => composition.start < flatten.end && composition.end > flatten.start);

  assert.ok(overlapping.length > 0);
  for (const composition of overlapping) {
    assert.deepEqual(
      [composition.camera.subject, composition.camera.secondary],
      ['spark_coin', 'zapp'],
      `flatten line ${flatten.start}-${flatten.end} must stay on coin/Zapp, not Kira (${composition.start}-${composition.end})`,
    );
  }
  assert.ok((current.camera.subShots ?? []).every(({ from, subject, secondary }) =>
    from < flatten.start || from >= flatten.end || (subject !== 'kira' && secondary !== 'kira')),
  'no Kira cut starts inside the flatten line');
});

test('authored composition cadence remains in the 1.2-2.2 second average target', () => {
  const durations = fixture.beats.flatMap((current) => {
    const cuts = [current.start, ...(current.camera.subShots ?? []).map(({ from }) => from), current.end];
    return cuts.slice(0, -1).map((start, index) => cuts[index + 1] - start);
  });
  const average = durations.reduce((total, duration) => total + duration, 0) / durations.length;
  assert.equal(durations.length, 41, 'camera repair preserves the established composition count');
  assert.ok(average >= 1.2 && average <= 2.2, `average composition length ${average.toFixed(3)} s`);
});
