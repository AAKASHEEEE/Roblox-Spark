# Legal and asset safety

This is an engineering risk assessment, not legal advice. Before commercial launch, a trademark lawyer should review the brand name and marketing.

## What the proof of concept uses
- **No third-party assets at all.**
  - All geometry is procedural primitives defined in JSON manifests.
  - All textures (posters, chalkboard, button label, coin emblem, faces) are drawn in code.
  - Text uses an in-house 5×7 pixel font.
  - Every sound is synthesised from math in `packages/audio/src/synth.ts`.
  - The engine loads no external mesh, image, font or audio file.
- **Every manifest carries `license`** (source, author, license, attribution flag, notes). The validator rejects any source outside `original-procedural | original-authored | commissioned | licensed-commercial | cc0`.
- **No Roblox or competitor material:** no avatars, ripped maps, logos, UI, sounds or footage, and no platform currency names.

## Risks
| Risk | Severity | Mitigation |
|---|---|---|
| **The product/channel name "RBLX SPARK".** "RBLX" is Roblox Corporation's stock ticker and closely tied to its brand. Using it in a product or channel name can suggest affiliation or endorsement (trademark and false-endorsement risk). | **High** | Rename before launch (e.g. "SPARK BLOCKS"). If kept, never pair it with Roblox logos or fonts, and always show a clear "not affiliated with Roblox Corporation" disclaimer. The code name is kept only internally. |
| Trade dress: blocky characters, avatar proportions, UI chrome and the classic studded look can evoke Roblox. | Medium | Our own proportions, bevelled matte heads, flat decal faces and a distinct palette. No studs, no "noob" colour scheme, no platform-style UI or chat bubbles. Keep a style guide and review new characters against it. |
| Titles or tags that use platform terms ("Robux", "free Robux") | Medium, and also a platform-policy issue | The validator blocks these terms (`BANNED_TERMS`). The coin is the fictional "Spark Coin". |
| Fake-currency or giveaway framing ("FREE COINS" button) | Low–Medium | The coins are in-world and fictional, with no call to action. `safety.realMoneyOrGiveawayClaims` must be `false` (the schema literal enforces this). |
| Future imported GLBs, sounds or music | Medium | Upload flow (MVP) requires licence metadata and a source URL or invoice before an asset can move from `draft` to `ready`. Only `ready` assets render. |
| AI-generated assets (if used later) | Medium | Record the tool, terms and prompt in `license.notes`. Avoid prompts that name protected IP. |
| Music | Low | The procedural music bed is original. No recognisable songs are ever scraped. |

## Operating rules
1. Do not describe the product as official, endorsed or "made with Roblox".
2. Keep all asset files in version control with licence metadata. The lock file makes provenance auditable.
3. Episodes are family-safe by schema: the `familySafe: true` literal plus the banned-term scan (gore, weapons, sexual terms, real-money). This is a keyword screen, not a moderation system, so a human should approve published episodes.
