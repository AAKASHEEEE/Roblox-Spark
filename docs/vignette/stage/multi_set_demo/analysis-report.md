# Vignette staging analysis: Multi-set staging demo: hallway -> classroom -> playground

Sheet `multi_set_demo`: 4 beats, 16.00 s, 3 set(s).

**Verdict: PASS**

| Check | Result |
|---|---|
| Beat sheet validation | ok; 3 planned IDs |
| Staging contracts | 0 error(s), 0 warning(s); contracts: look_at x7, remain_still x2, move_to x2, confident_pose x1, jump x1 |
| Cameras | 4 recipe, 0 safety fallback, 0 blocked |
| Script coverage | 100.0% (15/15 visual items; threshold 90.0%; 8 audio-only cues not counted) |
| Placeholders | 0 (grey labelled blocks / labelled fallbacks) |

## Sets

| Set | Built from | Origin | Marks | Doors | Notes |
|---|---|---|---|---|---|
| school_hallway | school_hallway@1.0.0 | [0, 0, 0] | 7 | hall_door | - |
| classroom | classroom@1.2.0 | [40, 0, 0] | 29 | classroom_door | - |
| playground | playground@1.0.0 | [80, 0, 0] | 6 | - | - |

## Beats

| Beat | Set | Recipe | Intent | Camera | Min score | Coverage | Missing | Still |
|---|---|---|---|---|---|---|---|---|
| p01 | school_hallway | establishing_wide | wide | recipe `y-15_s1_h16_f56` | 0.925 | 100.0% (3/3) | - | ![p01](stills/p01.png) |
| p02 | school_hallway | establishing_wide | wide | recipe `y30_s1_h16_f56` | 0.586 | 100.0% (3/3) | - | ![p02](stills/p02.png) |
| p03 | classroom | wide_environment | wide | recipe `y0_s1_h6_f44` | 0.936 | 100.0% (6/6) | - | ![p03](stills/p03.png) |
| p04 | playground | wide_environment | wide | recipe `y-30_s1_h6_f52` | 0.838 | 100.0% (3/3) | - | ![p04](stills/p04.png) |

## Staging per beat

**p01** (school_hallway, day)

- zapp @ hall_center: walk, face determined
- kira @ lockers: idle, face smug
- prop backpack @ kira (closed) [0, 0, 0]

**p02** (school_hallway, day)

- zapp @ exit:hall_door: run, face happy->curious, moves 4.355-7 s, exits 7 s
- kira @ lockers: shrug, face skeptical
- prop backpack @ kira (closed) [0, 0, 0]

**p03** (classroom, morning)

- zapp @ enter:classroom_door: walk, face curious, moves 8.6-10.064 s, enters 8.6 s
- kira @ kira_desk: arms_crossed, face smug
- prop door @ classroom_door (closed) [42.5, 0, -3.95]
- prop suspicious_button @ button_desk (idle) [39.9, 0.76, -0.12]

**p04** (playground, day)

- zapp @ slide: jump, face happy->curious
- kira @ swings: wave, face laughing
- prop ball @ sandpit (idle) [83, 0, 3.55]

## Staging issues

None.

## Placeholders and fallbacks

| Kind | ID | Status | Rendered as |
|---|---|---|---|
| music | bed_upbeat | planned | planned (S7); not drawn |
| sfx | bell | planned | planned (S7); not drawn |
| sfx | door_open | planned | planned (S7); not drawn |
| sfx | sfx_tada | available | assets/audio/sfx_tada@1.0.0.json |
| expression_fallback | zapp | p02 | zapp: zapp has no "happy" face; nearest drawable "curious" |
| expression_fallback | zapp | p04 | zapp: zapp has no "happy" face; nearest drawable "curious" |
| look_at_camera | zapp | p04 | zapp looks at the camera: body turned to the audience side (the engine has no camera look target) |

## Coverage misses

| Beat | Item | Seen / samples | Note |
|---|---|---|---|
