export type VisualMode = 'vignette' | 'narrated';
export type RenderProfileId = 'review-vertical-540p' | 'production-vertical-1080p';
export type EvidenceProfileId = 'none' | 'competitor-v2';

export interface RenderProfile {
  id: RenderProfileId;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioBitrate: number;
  codec: 'avc1.64001f' | 'avc1.640028';
  durationRange: readonly [number, number];
}

export const RENDER_PROFILES: Readonly<Record<RenderProfileId, RenderProfile>> = {
  'review-vertical-540p': {
    id: 'review-vertical-540p', width: 540, height: 960, fps: 30,
    videoBitrate: 3_000_000, audioBitrate: 160_000, codec: 'avc1.64001f', durationRange: [0.1, 300],
  },
  'production-vertical-1080p': {
    id: 'production-vertical-1080p', width: 1080, height: 1920, fps: 30,
    videoBitrate: 8_000_000, audioBitrate: 192_000, codec: 'avc1.640028', durationRange: [0.1, 300],
  },
};

export const COMPETITOR_EVIDENCE_FILES = [
  'frame-teacher-exit.png',
  'frame-zapp-celebrate.png',
  'frame-button-press.png',
  'frame-coin-growth.png',
  'frame-impact.png',
  'frame-teacher-return.png',
  'frame-final-payoff.png',
  'comparison-sheet.jpg',
] as const;

export interface RenderSelectionInput {
  visual?: string;
  profile?: string;
  evidenceProfile?: string;
  width?: string;
  height?: string;
  fps?: string;
  bitrate?: string;
  audioBitrate?: string;
}

/** Generic renderer choice, immutable media profile, and fixture evidence policy are deliberately independent. */
export function resolveRenderSelection(input: RenderSelectionInput): {
  visual: VisualMode;
  profile: RenderProfile;
  evidenceProfile: EvidenceProfileId;
} {
  const visual = input.visual ?? 'vignette';
  if (visual !== 'vignette' && visual !== 'narrated') throw new Error(`--visual must be 'vignette' or 'narrated', got '${visual}'`);
  const profileId = input.profile ?? 'review-vertical-540p';
  if (!(profileId in RENDER_PROFILES)) throw new Error(`unknown --profile '${profileId}'`);
  const profile = RENDER_PROFILES[profileId as RenderProfileId];
  const evidenceProfile = input.evidenceProfile ?? 'none';
  if (evidenceProfile !== 'none' && evidenceProfile !== 'competitor-v2') throw new Error(`unknown --evidence-profile '${evidenceProfile}'`);
  if (evidenceProfile === 'competitor-v2' && visual !== 'vignette') throw new Error("--evidence-profile competitor-v2 requires --visual vignette");
  if (evidenceProfile === 'competitor-v2' && profile.id !== 'review-vertical-540p') throw new Error("the checked competitor-v2 evidence profile is review-vertical-540p; use a new evidence profile for final 1080p output");

  const exact: Array<[string, string | undefined, number]> = [
    ['width', input.width, profile.width], ['height', input.height, profile.height], ['fps', input.fps, profile.fps],
    ['bitrate', input.bitrate, profile.videoBitrate], ['audioBitrate', input.audioBitrate, profile.audioBitrate],
  ];
  for (const [name, raw, expected] of exact) {
    if (raw !== undefined && Number(raw) !== expected) throw new Error(`--${name}=${raw} conflicts with immutable profile ${profile.id} (${expected})`);
  }
  return { visual, profile, evidenceProfile };
}
