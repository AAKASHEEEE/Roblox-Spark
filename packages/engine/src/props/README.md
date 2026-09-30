# Props library (S4)

This folder holds 25 block-style props: the `planned` S4 ids in `packages/library/src/ids.ts`. It also has 1.1.0 revisions of `spark_coin`, `student_desk` and `suspicious_button`. The revisions add the shared anchors and change nothing else, and 1.0.0 stays locked.

| File | Role |
|---|---|
| `kit.ts` | Authoring helpers, conventions and palette |
| `catalog-*.ts`, `catalog.ts` | The manifests. `assets/props/*.json` is generated from these |
| `rigs.ts`, `rig.ts` | Pivots, named states, screens, lit parts and decals. Implements `PropBuilder` (`index.ts`) |
| `door.ts` | Door placement, marks and wall cutout for sets |
| `car.ts` | `rollWheels(distance)` and `steer(deg)` |
| `check.ts` | Self-check: schema, anchors, geometry vs dimensions, scale vs Zapp, rigs, library ids |
| `preview.ts`, `font.ts`, `screens.ts` | QA stills renderer, 5x7 block font, procedural screen and label art |

Tooling: `node scripts/props.ts write|check|sheet`. After `write`, run `npm run assets:lock`. Published manifests are immutable, so to change one, bump its version. The stills are in `assets/props/stills/`:

- `prop-sheet.png`: every prop next to Zapp.
- `prop-states.png`: every state.
- `prop-anchors.png`: G = grip, S = surface, F = floor.

## Conventions

- Units are meters and +y is up. The prop's front faces +z. A character's left is +x, so `_l` names sit at +x.
- The prop origin is the floor contact point. The coin is the exception: it is centred.
- Scale follows Zapp: 1.93 m tall (2.12 m to the hair spikes), hip 0.80, knee 0.40, shoulder 1.32, hand 0.13 wide.
  - Seats are at 0.45 and tables at 0.76.
  - Counters are at 0.92.
  - The door opening is 1.1 × 2.4.
  - The fridge is 2.0 tall.
  - The car roof is at 1.54.

  The bands and their reasons are in `SCALE_REF`, which `check.ts` enforces.

## Anchor contract (every prop)

- `grips.grip`: the primary hand grip. Extra grips are named `grip_*`.
- `anchors.surface`: the top or placement surface: a seat, a table top, a screen face, a lid top. Use it as the `parent` anchor for props placed on props.
- `anchors.floor`: the floor contact point.

Props also carry floor spots for characters where they make sense, for example `use_front`, `sit_front`, `get_in`, `read_spot` and `watch_spot`.

## States

`applyState(p, state, u, from?)` is pure in its arguments. It writes pivots, screens and lit parts to the rig's nodes, because `PropState` has no field for them. It returns only numeric `PropState` fields, such as the button's `capDepth`. Props without moving parts have one state, `default`.

| Prop | States |
|---|---|
| door | `closed` (default), `ajar` (30°), `open` (90° toward +z). The handles and `surface` ride the hinge |
| phone | `screen_off` (default), `screen_on` |
| laptop | `open` (default, lid at 102°, screen on), `closed` |
| fridge | `door_closed` (default), `door_open` (105°, interior light on) |
| tv | `off` (default, red standby LED), `on` |
| car | `parked` (default), `driving` (headlights on, wheels roll 2 turns over u). Four wheel pivots, with front steering pivots. Use `rollWheels` and `steer` for real motion |
| lamp, stove | `off`, `on` |
| gift_box, trash_can | `closed`, `open` |
| pizza | `whole`, `slice` (a hand-held slice at `grip_slice`) |
| sign_board | `default`. The text is set per instance with `build(id, { seed, text })` |

## Doors in sets

1. Declare `SetDoor { propId: 'door' }` in the set.
2. Place the prop with `doorPlacement(setDoor)`. The prop's +z follows `facingDeg`, so the leaf swings into the room.
3. Build the wall with `doorwayWall({ length, height, thickness <= 0.16, doorX, color })`. It returns environment pieces.
4. Get the floor marks with `doorMarks(setDoor, manifest.anchors)`: `enter_back` → `threshold` → `enter_front` for walking in, plus `use_front` and `use_back`.
5. Keep the swing arc clear. It is `DOOR.swingRadius` (1.1 m) from the hinge.

## Known limits

- `Production.propAnchor()` reads static manifest anchors. Use `anchorLocal(rig, name)` for anchors on moving parts, such as a door handle when the door is open.
- A flat `buildProp()` renders the authored pose. That is the default state for everything except the laptop (authored upright, a little past its open angle) and the pizza (whole pie and slice overlap).
