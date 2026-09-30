// Beat sheet -> audio mix plan (S7). Voice-over plus one SFX per beat-sheet `sfx` event, nothing else.
// NO MUSIC: the beat sheet's `music` entries (beds, ambience) are never mixed and never replaced by planned music IDs;
// they are listed in `ignoredMusic` so the editor knows what the director suggested. Music is added later in editing.
import type { SfxCueIn } from './mix.ts';

export interface IgnoredMusic { musicId: string; start: number; end: number; reason: 'music_added_in_editing' }
export interface MixPlan { cues: SfxCueIn[]; ignoredMusic: IgnoredMusic[] }

export function mixPlanFromBeatSheet(sheet: { music?: ReadonlyArray<{ musicId: string; start: number; end: number }>; beats: ReadonlyArray<{ events: ReadonlyArray<{ type: string; at: number } & Record<string, unknown>> }> }, window?: { start: number; end: number }): MixPlan {
  const inWin = (t: number) => !window || (t >= window.start && t < window.end);
  const shift = window?.start ?? 0;
  const cues: SfxCueIn[] = [];
  for (const b of sheet.beats) for (const e of b.events) if (e.type === 'sfx' && inWin(e.at)) cues.push({ sfxId: String(e.sfxId), at: +(e.at - shift).toFixed(4), ...(typeof e.gainDb === 'number' ? { gainDb: e.gainDb } : {}) });
  cues.sort((a, b) => a.at - b.at || (a.sfxId < b.sfxId ? -1 : 1));
  const ignoredMusic = (sheet.music ?? []).map((m) => ({ musicId: m.musicId, start: m.start, end: m.end, reason: 'music_added_in_editing' as const }));
  return { cues, ignoredMusic };
}
