# Narrated Story — Phase 2A results (draft render)

Scope: approved narrated storyboard (schema 1.1) + retained voice-over → deterministic 540×960 draft MP4 with burned-in captions. There is no full-resolution render. No new characters, environments, props, lip-sync, TTS or music were added.

## Implemented
- **Mode-specific limits:** `episodeSchema(limits)`. Visual Comedy keeps 14–22 s. Narrated drafts allow 35–75 s under validation profile `narrated-draft`: Visual Comedy story-structure checks do not apply, but the 3 s shot limit and all asset, reference, causality and safety checks do.
- **Approval** (`apps/studio/narrated-api.ts`):
  - content-addressed and written once;
  - bound to the audio content hash;
  - rechecked at render time (storyboard hash, stored-audio hash, optional client audio hash);
  - one job at a time; interrupted jobs need a manual retry.
- **Timeline compiler** (`packages/narrated/src/timeline.ts`):
  - caption chunks drive the cuts;
  - one main action per phrase near its start;
  - a physically ordered prop chain (press → spawn → stand/grow → hop to floor → grow → tip over → reset);
  - off-screen people get a door-direction look and a creak SFX cue, and are never instantiated;
  - locomotion is shown as an in-place jump (a declared warning);
  - the supporting character is framed only when the phrase names or pronoun-references them.
- **Audio** (`packages/narrated/src/mixdown.ts`):
  - the voice-over is resampled to 48 kHz and placed in both channels; it is padded to whole frames, never cut or stretched;
  - SFX are ducked 10 dB;
  - loudness is normalised per BS.1770 to −15 LUFS behind a −2 dBFS limiter;
  - true peak is estimated with 4× windowed-sinc oversampling.
- **Captions** (`packages/engine/src/capture.ts`): chunk-exact `[start, end)` timing, planned line breaks, white 800-weight system sans-serif with a dark outline, electric-yellow emphasis. Pictographs and format characters are stripped.
- **Render path** (`apps/render-worker/render.ts`): an optional `narrated` input replaces the episode mix and adds captions. The narrated gates (`apps/studio/narrated-draft.ts`) decide success.

## Real validation (69.146 s ElevenLabs MP3, exact 14-line script, comparison, Zapp + Kira, seed 17)
- 14 phrases, 26 caption chunks, 39 shots (average 1.77 s, 1.21–2.47 s), 17 actions, 13 prop events, 17 SFX cues, 3 off-screen teacher cues.
- MP4: 540×960, 30/1 fps, 2075 frames, H.264 High + AAC-LC 48 kHz stereo, 69.167 s (the voice-over padded to whole frames).
- Audio: −15.07 LUFS integrated, −1.85 dBTP (estimated), −2.0 dBFS sample peak.
- **18/18 narrated gates pass.**
- Render worker 279.7 s (123 ms/frame on 8 CPU cores, SwiftShader); job wall time 283 s.

## Limitations
- Draft motion: poses are held between phrases; there is no lip-sync; walking/running becomes in-place jumps.
- Some close and over-the-shoulder shots crop heads. Caption placement is fixed lower-middle and is not measured against the face position.
- The teacher is only implied: a door-direction look, a creak cue and the warnings.
- True peak is an oversampled estimate, not a certified meter.
- Uploaded audio is not cleaned up automatically.
