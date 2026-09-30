import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionAt, drawCaption, drawUiPopup } from '../packages/vignette/src/captions.ts';

const beat: any = {
  captions: [
    { start: 1, end: 2, text: 'door CLOSES', highlight: 'CLOSES' },
    { start: 2, end: 3, text: 'Zapp celebrates' },
  ],
  events: [{ event: { type: 'text_graphic', at: 1.2, duration: 0.8, textStyleId: 'ui_popup', text: '+1 COIN', target: 'coin' } }],
};

function fakeContext() {
  const calls: Array<{ kind: string; text?: string; fill?: string }> = [];
  const g: any = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 0, textAlign: '', textBaseline: '', lineJoin: '', miterLimit: 0,
    measureText: (text: string) => ({ width: text.length * 18 }),
    save() {}, restore() {}, translate() {}, scale() {}, beginPath() {}, roundRect() {}, fill() {}, stroke() {},
    strokeText(text: string) { calls.push({ kind: 'stroke', text }); },
    fillText(text: string) { calls.push({ kind: 'fill', text, fill: this.fillStyle }); },
  };
  return { g, calls };
}

test('vignette captions use inclusive start and exclusive end boundaries', () => {
  assert.equal(captionAt(beat, 0.999), null);
  assert.equal(captionAt(beat, 1)?.text, 'door CLOSES');
  assert.equal(captionAt(beat, 1.999)?.text, 'door CLOSES');
  assert.equal(captionAt(beat, 2)?.text, 'Zapp celebrates');
  assert.equal(captionAt(beat, 3), null);
});

test('caption renderer draws the highlighted word yellow and leaves gaps empty', () => {
  const { g, calls } = fakeContext();
  assert.equal(drawCaption(g, beat, 1.4, 540, 960), true);
  assert.ok(calls.some((x) => x.kind === 'fill' && x.text === 'CLOSES' && x.fill === '#ffe600'));
  assert.ok(calls.some((x) => x.kind === 'fill' && x.text === 'door' && x.fill === '#ffffff'));
  assert.equal(drawCaption(g, beat, 4, 540, 960), false);
});

test('ui popup renderer is active only inside its exact event interval', () => {
  assert.equal(drawUiPopup(fakeContext().g, beat, 1.19, 540, 960), false);
  assert.equal(drawUiPopup(fakeContext().g, beat, 1.2, 540, 960), true);
  assert.equal(drawUiPopup(fakeContext().g, beat, 1.999, 540, 960), true);
  assert.equal(drawUiPopup(fakeContext().g, beat, 2, 540, 960), false);
});
