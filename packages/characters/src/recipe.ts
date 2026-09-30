// Profile -> modular recipe. Every slot must resolve to a REGISTERED component; unavailable components are reported,
// never invented, and a substitute is only used when the profile carries an explicit approval for that exact swap.
import { suggestAlternatives, type Catalog, type ComponentCategory, type RegisteredComponent } from './catalog.ts';
import { err, warn, type CharacterProfile, type Finding } from './schema.ts';

export interface RecipeEntry { ref: string; hash: string; palette: Record<string, string>; substitutedFrom?: string }
export interface ResolvedRecipe {
  rig: string;
  body: RecipeEntry;
  head: RecipeEntry;
  hair: RecipeEntry;
  clothing: (RecipeEntry & { slot: string })[];
  shoes: RecipeEntry;
  accessories: (RecipeEntry & { anchor: string })[];
  faceSet: RecipeEntry;
  motion: RecipeEntry;
  proportions: CharacterProfile['proportions'];
  expressions: string[];
}
export interface RecipeResult { recipe?: ResolvedRecipe; errors: Finding[]; warnings: Finding[]; components: Record<string, RegisteredComponent> }

const sortedPalette = (p: Record<string, string>) => Object.fromEntries(Object.entries(p).sort(([a], [b]) => (a < b ? -1 : 1)));

export function resolveRecipe(profile: CharacterProfile, catalog: Catalog): RecipeResult {
  const errors: Finding[] = [], warnings: Finding[] = [];
  const components: Record<string, RegisteredComponent> = {};
  const subs = profile.substitutions ?? [];
  const usedSubs = new Set<number>();

  const resolve = (requested: string, category: ComponentCategory, path: string, palette: Record<string, string> = {}, filter?: (c: RegisteredComponent) => boolean): RecipeEntry | undefined => {
    let comp = catalog.get(requested);
    let substitutedFrom: string | undefined;
    if (comp && comp.category !== category) {
      errors.push(err('COMPONENT_CATEGORY_MISMATCH', path, `${requested} is a ${comp.category}, not a ${category}`));
      return;
    }
    if (!comp) {
      const si = subs.findIndex((s) => s.requested === requested);
      const sub = si >= 0 ? catalog.get(subs[si].substitute) : undefined;
      if (sub && sub.category === category && (!filter || filter(sub))) {
        usedSubs.add(si);
        comp = sub; substitutedFrom = requested;
        warnings.push(warn('COMPONENT_SUBSTITUTED', path, `${requested} is unavailable; using approved substitute ${sub.ref} (approved by ${subs[si].approvedBy})`));
      } else {
        if (si >= 0) { usedSubs.add(si); errors.push(err('SUBSTITUTION_INVALID', `$.substitutions[${si}]`, `approved substitute ${subs[si].substitute} is not a registered ${category}`)); }
        errors.push(err('ASSET_COMPONENT_UNAVAILABLE', path, `${requested} is not a registered ${category}; no mesh will be invented`, {
          suggestion: { category, candidates: suggestAlternatives(catalog, category, requested, filter), requiresApproval: true },
        }));
        return;
      }
    }
    for (const k of Object.keys(palette)) if (!Object.hasOwn(comp.palette, k)) errors.push(err('PALETTE_SLOT_UNKNOWN', `${path}.palette.${k}`, `${comp.ref} has no palette slot "${k}" (slots: ${Object.keys(comp.palette).join(', ') || 'none'})`));
    components[comp.ref] = comp;
    const entry: RecipeEntry = { ref: comp.ref, hash: comp.hash, palette: sortedPalette({ ...comp.palette, ...palette }) };
    if (substitutedFrom) entry.substitutedFrom = substitutedFrom;
    return entry;
  };

  const a = profile.appearance;
  const body = resolve(profile.bodyPreset, 'body', '$.bodyPreset');
  const head = resolve(a.head.preset, 'head', '$.appearance.head', a.head.palette);
  const hair = resolve(a.hair.assetId, 'hair', '$.appearance.hair', a.hair.palette);
  const clothing = a.clothing.map((cl, i) => {
    const e = resolve(cl.assetId, 'clothing', `$.appearance.clothing[${i}]`, cl.palette, (x) => x.slot === cl.slot);
    const comp = e && components[e.ref];
    if (comp && comp.slot !== cl.slot) errors.push(err('CLOTHING_SLOT_MISMATCH', `$.appearance.clothing[${i}].slot`, `${comp.ref} is worn as "${comp.slot}", not "${cl.slot}"`));
    return e && { ...e, slot: cl.slot };
  });
  const shoes = resolve(a.shoes.assetId, 'shoes', '$.appearance.shoes', a.shoes.palette);
  const accessories = a.accessories.map((ac, i) => {
    const e = resolve(ac.assetId, 'accessory', `$.appearance.accessories[${i}]`, ac.palette);
    return e && { ...e, anchor: ac.anchor };
  });
  const faceSet = resolve(a.faceStyle, 'face_set', '$.appearance.faceStyle');
  const motion = resolve(profile.motionProfile, 'motion', '$.motionProfile');
  subs.forEach((s, i) => { if (!usedSubs.has(i)) warnings.push(warn('SUBSTITUTION_UNUSED', `$.substitutions[${i}]`, `${s.requested} resolved without substitution; approval is unused`)); });

  if (errors.length || !body || !head || !hair || !shoes || !faceSet || !motion || clothing.some((x) => !x) || accessories.some((x) => !x)) return { errors, warnings, components };
  return {
    errors, warnings, components,
    recipe: {
      rig: components[body.ref].rigs[0], body, head, hair, shoes, faceSet, motion,
      clothing: clothing as ResolvedRecipe['clothing'], accessories: accessories as ResolvedRecipe['accessories'],
      proportions: { ...profile.proportions }, expressions: [...profile.expressions],
    },
  };
}
