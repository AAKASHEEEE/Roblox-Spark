# Vignette staging analysis: Zapp vs Kira When the Teacher Leaves

Sheet `free_coins_classroom`: 14 beats, 69.08 s, 1 set(s).

**Verdict: BLOCKED** (camera safety blocked 5 beat(s): p02, p03, p04, p10, p11; script coverage 74.7% < 90%)

| Check | Result |
|---|---|
| Beat sheet validation | ok; 32 planned IDs |
| Staging contracts | 0 error(s), 3 warning(s); contracts: move_to x9, remain_still x16, look_at x13, celebrate x3, warning x1, press_button x1, spawn_coin x1, grow_coin x4, confident_pose x1, tip_coin_onto x1, fall_prone x1, reset_button x1 |
| Cameras | 8 recipe, 1 safety fallback, 5 blocked |
| Script coverage | 74.7% (65/87 visual items; threshold 90.0%; 19 audio-only cues not counted) |
| Placeholders | 33 (grey labelled blocks / labelled fallbacks) |

## Sets

| Set | Built from | Origin | Marks | Doors | Notes |
|---|---|---|---|---|---|
| classroom | classroom@1.1.0 | [0, 0, 0] | 27 | classroom_door | - |

## Beats

| Beat | Set | Recipe | Intent | Camera | Min score | Coverage | Missing | Still |
|---|---|---|---|---|---|---|---|---|
| p01 | classroom | establishing_wide | wide | recipe `y-15_s1_h24_f46` | 0.649 | 100.0% (7/7) | - | ![p01](stills/p01.png) |
| p02 | classroom | slow_push_in | medium | **BLOCKED** (HEAD_CROPPED) | 0.912 | 50.0% (3/6) | door (closed), suspicious_button (idle), door_close classroom_door@4.9 | ![p02](stills/p02.png) |
| p03 | classroom | low_angle_hero | medium | **BLOCKED** (FACE_VISIBILITY_LOW, SCREEN_DIRECTION_REVERSED) | 0.142 | 100.0% (5/5) | - | ![p03](stills/p03.png) |
| p04 | classroom | two_shot | medium | **BLOCKED** (HEAD_CROPPED) | 0.909 | 75.0% (3/4) | door (closed) | ![p04](stills/p04.png) |
| p05 | classroom | insert_prop | prop | recipe `y-45_s0.44_h30_f38` | 0.992 | 66.7% (4/6) | kira (sit), door (closed) | ![p05](stills/p05.png) |
| p06 | classroom | two_shot | medium | recipe `aud_y-20_s1_h0.3_f34` | 0.908 | 75.0% (3/4) | door (closed) | ![p06](stills/p06.png) |
| p07 | classroom | over_shoulder | medium | fallback two_character_medium | 0.971 | 71.4% (5/7) | door (closed), spark_coin (spawned) | ![p07](stills/p07.png) |
| p08 | classroom | medium_single | medium | recipe `y20_s0.27_h-0.08_f38_w` | 0.989 | 57.1% (4/7) | door (closed), spark_coin (spawned), text ui_popup@36->spark_coin | ![p08](stills/p08.png) |
| p09 | classroom | reaction_punch_in | reaction | recipe `y0_s0.29_h0.15_f38` | 0.944 | 66.7% (4/6) | door (closed), spark_coin (growing) | ![p09](stills/p09.png) |
| p10 | classroom | low_angle_reveal | scale_reveal | **BLOCKED** (HEAD_CROPPED, SCALE_REVEAL_SILHOUETTE_LOW, SCALE_REVEAL_EMBLEM_HIDDEN) | 0.910 | 83.3% (5/6) | door (closed) | ![p10](stills/p10.png) |
| p11 | classroom | two_shot | medium | **BLOCKED** (FACE_VISIBILITY_LOW, HEAD_CROPPED, REQUIRED_SUBJECT_NOT_IN_FRAME) | 0.614 | 50.0% (3/6) | zapp (arms_crossed), spark_coin (giant), vfx emote_sweat@52.5->zapp | ![p11](stills/p11.png) |
| p12 | classroom | top_down | wide | recipe `y20_s1_h52_f62` | 0.810 | 100.0% (7/7) | - | ![p12](stills/p12.png) |
| p13 | classroom | over_shoulder | over_shoulder | recipe `s1_l0.8_b1.3_h0.35_f28` | 0.841 | 55.6% (5/9) | kira (sit), zapp (flattened), suspicious_button (idle), spark_coin (tipped) | ![p13](stills/p13.png) |
| p14 | classroom | final_loop | wide | recipe `ctx_y0_s1_h10_f46` | 0.850 | 100.0% (7/7) | - | ![p14](stills/p14.png) |

## Staging per beat

**p01** (classroom, morning)

- teacher @ exit:classroom_door: walk (played as move_to/idle), face strict, moves 0.11-3.912 s, exits 3.9 s
- zapp @ zapp_desk: sit (played as remain_still/idle), face neutral — label: ACTION sit
- kira @ kira_desk: sit (played as remain_still/idle), face calm->smug — label: ACTION sit / FACE calm
- prop door @ classroom_door (closed) [2.5, 0, -3.95]
- prop suspicious_button @ button_desk (idle) [-0.1, 0.76, -0.12]

**p02** (classroom, morning)

- zapp @ zapp_desk: look_around (played as look_at/look_at), face evil_grin->determined — label: ACTION look_around / FACE evil_grin
- kira @ kira_desk: sit (played as remain_still/idle), face calm->smug — label: ACTION sit / FACE calm
- prop door @ classroom_door (closed) [2.5, 0, -3.95]
- prop suspicious_button @ button_desk (idle) [-0.1, 0.76, -0.12]

**p03** (classroom, morning)

- zapp @ center_stage: celebrate (played as celebrate/victory_pose), face big_grin->curious, moves 9.63-12.578 s — label: ACTION celebrate / FACE big_grin
- kira @ kira_desk: sit (played as remain_still/idle), face skeptical — label: ACTION sit
- prop door @ classroom_door (closed) [2.5, 0, -3.95]
- prop suspicious_button @ button_desk (idle) [-0.1, 0.76, -0.12]

**p04** (classroom, morning)

- kira @ kira_desk: sit (played as remain_still/idle), face smug — label: ACTION sit
- zapp @ center_stage: dance (played as celebrate/victory_pose), face happy->curious — label: ACTION dance / FACE happy
- prop door @ classroom_door (closed) [2.5, 0, -3.95]
- prop suspicious_button @ button_desk (idle) [-0.1, 0.76, -0.12]

**p05** (classroom, morning)

- zapp @ center_stage: look_at, face suspicious->curious — label: FACE suspicious
- kira @ kira_desk: sit (played as remain_still/idle), face skeptical — label: ACTION sit
- prop door @ classroom_door (closed) [2.5, 0, -3.95]
- prop suspicious_button @ button_desk (idle) [-0.1, 0.76, -0.12]

**p06** (classroom, morning)

- kira @ kira_desk: head_shake, face strict->skeptical — label: FACE strict
- zapp @ press_spot: walk (played as move_to/idle), face evil_grin->determined, moves 25.99-28.971 s — label: FACE evil_grin
- prop door @ classroom_door (closed) [2.5, 0, -3.95]
- prop suspicious_button @ button_desk (idle) [-0.1, 0.76, -0.12]

**p07** (classroom, morning)

- zapp @ press_spot: press_button, face determined
- kira @ kira_desk: sit (played as remain_still/idle), face shock->surprised — label: ACTION sit / FACE shock
- prop door @ classroom_door (closed) [2.5, 0, -3.95]
- prop suspicious_button @ button_desk (pressed) [-0.1, 0.76, -0.12]
- prop spark_coin @ coin_spawn (spawned) [-1.7, 0, -1.2]

**p08** (classroom, morning)

- zapp @ press_spot: celebrate (played as celebrate/victory_pose), face laugh->neutral — label: ACTION celebrate / FACE laugh
- kira @ kira_desk: facepalm, face skeptical
- prop door @ classroom_door (closed) [2.5, 0, -3.95]
- prop suspicious_button @ button_desk (idle) [-0.1, 0.76, -0.12]
- prop spark_coin @ coin_spawn (spawned) [-1.7, 0, -1.2]

**p09** (classroom, morning)

- zapp @ press_spot: shock_recoil, face shocked->shock — label: FACE shocked
- kira @ kira_desk: sit (played as remain_still/idle), face scared->surprised — label: ACTION sit / FACE scared
- prop door @ classroom_door (closed) [2.5, 0, -3.95]
- prop suspicious_button @ button_desk (flashing) [-0.1, 0.76, -0.12]
- prop spark_coin @ coin_spawn (growing) [-1.7, 0, -1.2]

**p10** (classroom, morning)

- zapp @ press_spot: shock_recoil, face shocked->shock — label: FACE shocked
- kira @ kira_desk: stand_up (played as remain_still/idle), face scared->surprised — label: ACTION stand_up / FACE scared
- prop door @ classroom_door (closed) [2.5, 0, -3.95]
- prop suspicious_button @ button_desk (idle) [-0.1, 0.76, -0.12]
- prop spark_coin @ coin_spawn (giant) [-1.7, 0, -1.2]

**p11** (classroom, morning)

- zapp @ coin_front: arms_crossed, face smug->determined, moves 49.91-52.199 s — label: FACE smug
- kira @ kira_safe: walk (played as move_to/idle), face scared->surprised, moves 49.91-52.389 s — label: FACE scared
- prop door @ classroom_door (closed) [2.5, 0, -3.95]
- prop suspicious_button @ button_desk (idle) [-0.1, 0.76, -0.12]
- prop spark_coin @ coin_spawn (giant) [-1.7, 0, -1.2]

**p12** (classroom, morning)

- zapp @ zapp_impact: flattened (played as fall_prone/fall), face shocked->shock — label: ACTION flattened / FACE shocked
- kira @ kira_safe: shock_recoil, face shock->surprised — label: FACE shock
- prop door @ classroom_door (closed) [2.5, 0, -3.95]
- prop suspicious_button @ button_desk (idle) [-0.1, 0.76, -0.12]
- prop spark_coin @ giant_front (tipped) [-2, 0, -0.75]

**p13** (classroom, morning)

- teacher @ enter:classroom_door: walk (played as move_to/idle), face strict, moves 60.6-62.064 s, enters 60.6 s
- kira @ kira_desk: sit (played as remain_still/idle), face calm->smug, moves 59.91-61.993 s — label: ACTION sit / FACE calm
- zapp @ zapp_impact: flattened (played as fall_prone/fall), face regret — label: ACTION flattened
- prop door @ classroom_door (open) [2.5, 0, -3.95]
- prop suspicious_button @ button_desk (idle) [-0.1, 0.76, -0.12]
- prop spark_coin @ giant_front (tipped) [-2, 0, -0.75]

**p14** (classroom, morning)

- teacher @ center_stage: look_at, face strict, moves 65.35-70.382 s
- kira @ kira_desk: sit (played as remain_still/idle), face smug — label: ACTION sit
- zapp @ zapp_impact: flattened (played as fall_prone/fall), face regret — label: ACTION flattened
- prop door @ classroom_door (open) [2.5, 0, -3.95]
- prop suspicious_button @ button_desk (reset) [-0.1, 0.76, -0.12]
- prop spark_coin @ giant_front (tipped) [-2, 0, -0.75]

## Staging issues

| Severity | Code | Beat | Message |
|---|---|---|---|
| warning | CONTACT_OFF_CUE | p07 | zapp's press contact lands at 32.248 s, cue sfx_click at 32.2 |
| warning | CONTACT_OFF_CUE | p12 | coin/zapp contact at 56.3791 s, impact cue at 57 |
| warning | MOVE_OVERRUNS_BEAT | p14 | teacher reaches center_stage at 70.3822 s, 1.3022 s after the beat ends (69.08) |

## Placeholders and fallbacks

| Kind | ID | Status | Rendered as |
|---|---|---|---|
| characters | teacher | planned | grey placeholder block (planned (S3)) |
| props | door | planned | grey placeholder block (planned (S4)) |
| music | amb_classroom | available | assets/audio/amb_classroom@1.0.0.json |
| music | bed_upbeat | planned | planned (S7); not drawn |
| music | bed_suspense | planned | planned (S7); not drawn |
| music | bed_silly | planned | planned (S7); not drawn |
| sfx | footsteps | planned | planned (S7); not drawn |
| sfx | door_open | planned | planned (S7); not drawn |
| sfx | door_slam | planned | planned (S7); not drawn |
| vfx | emote_exclaim | planned | planned (S7); labelled placeholder |
| sfx | whoosh | planned | planned (S7); not drawn |
| sfx | sfx_tada | available | assets/audio/sfx_tada@1.0.0.json |
| sfx | sfx_beep | available | assets/audio/sfx_beep@1.0.0.json |
| sfx | sfx_blip_question | available | assets/audio/sfx_blip_question@1.0.0.json |
| sfx | sfx_click | available | assets/audio/sfx_click@1.0.0.json |
| vfx | zoom_punch | planned | planned (S7); labelled placeholder |
| sfx | sfx_coin_pop | available | assets/audio/sfx_coin_pop@1.0.0.json |
| textStyles | ui_popup | planned | planned (S7); labelled placeholder |
| sfx | sfx_boing | available | assets/audio/sfx_boing@1.0.0.json |
| sfx | sfx_rumble | available | assets/audio/sfx_rumble@1.0.0.json |
| vfx | emote_sweat | planned | planned (S7); labelled placeholder |
| sfx | sfx_creak | available | assets/audio/sfx_creak@1.0.0.json |
| sfx | sfx_thud_big | available | assets/audio/sfx_thud_big@1.0.0.json |
| vfx | emote_question | planned | planned (S7); labelled placeholder |
| sfx | sfx_ding_reset | available | assets/audio/sfx_ding_reset@1.0.0.json |
| action_placeholder | zapp | p01 | zapp: planned action (S5); played as remain_still/idle |
| action_placeholder | kira | p01 | kira: planned action (S5); played as remain_still/idle |
| expression_fallback | kira | p01 | kira: kira has no "calm" face; nearest drawable "smug" |
| action_placeholder | zapp | p02 | zapp: planned action (S5); played as look_at/look_at |
| expression_fallback | zapp | p02 | zapp: zapp has no "evil_grin" face; nearest drawable "determined" |
| action_placeholder | kira | p02 | kira: planned action (S5); played as remain_still/idle |
| expression_fallback | kira | p02 | kira: kira has no "calm" face; nearest drawable "smug" |
| action_placeholder | zapp | p03 | zapp: planned action (S5); played as celebrate/victory_pose |
| expression_fallback | zapp | p03 | zapp: zapp has no "big_grin" face; nearest drawable "curious" |
| action_placeholder | kira | p03 | kira: planned action (S5); played as remain_still/idle |
| look_at_camera | zapp | p03 | zapp looks at the camera: body turned to the audience side (the engine has no camera look target) |
| action_placeholder | kira | p04 | kira: planned action (S5); played as remain_still/idle |
| action_placeholder | zapp | p04 | zapp: planned action (S5); played as celebrate/victory_pose |
| expression_fallback | zapp | p04 | zapp: zapp has no "happy" face; nearest drawable "curious" |
| expression_fallback | zapp | p05 | zapp: zapp has no "suspicious" face; nearest drawable "curious" |
| action_placeholder | kira | p05 | kira: planned action (S5); played as remain_still/idle |
| expression_fallback | kira | p06 | kira: kira has no "strict" face; nearest drawable "skeptical" |
| expression_fallback | zapp | p06 | zapp: zapp has no "evil_grin" face; nearest drawable "determined" |
| action_placeholder | kira | p07 | kira: planned action (S5); played as remain_still/idle |
| expression_fallback | kira | p07 | kira: kira has no "shock" face; nearest drawable "surprised" |
| action_placeholder | zapp | p08 | zapp: planned action (S5); played as celebrate/victory_pose |
| expression_fallback | zapp | p08 | zapp: zapp has no "laugh" face; nearest drawable "neutral" |
| expression_fallback | zapp | p09 | zapp: zapp has no "shocked" face; nearest drawable "shock" |
| action_placeholder | kira | p09 | kira: planned action (S5); played as remain_still/idle |
| expression_fallback | kira | p09 | kira: kira has no "scared" face; nearest drawable "surprised" |
| expression_fallback | zapp | p10 | zapp: zapp has no "shocked" face; nearest drawable "shock" |
| action_placeholder | kira | p10 | kira: planned action (S5); played as remain_still/idle |
| expression_fallback | kira | p10 | kira: kira has no "scared" face; nearest drawable "surprised" |
| expression_fallback | zapp | p11 | zapp: zapp has no "smug" face; nearest drawable "determined" |
| expression_fallback | kira | p11 | kira: kira has no "scared" face; nearest drawable "surprised" |
| look_at_camera | zapp | p11 | zapp looks at the camera: body turned to the audience side (the engine has no camera look target) |
| action_placeholder | zapp | p12 | zapp: planned action (S5); played as fall_prone/fall |
| expression_fallback | zapp | p12 | zapp: zapp has no "shocked" face; nearest drawable "shock" |
| expression_fallback | kira | p12 | kira: kira has no "shock" face; nearest drawable "surprised" |
| action_placeholder | kira | p13 | kira: planned action (S5); played as remain_still/idle |
| expression_fallback | kira | p13 | kira: kira has no "calm" face; nearest drawable "smug" |
| action_placeholder | zapp | p13 | zapp: planned action (S5); played as fall_prone/fall |
| action_placeholder | kira | p14 | kira: planned action (S5); played as remain_still/idle |
| action_placeholder | zapp | p14 | zapp: planned action (S5); played as fall_prone/fall |
| look_at_camera | kira | p14 | kira looks at the camera: body turned to the audience side (the engine has no camera look target) |

## Coverage misses

| Beat | Item | Seen / samples | Note |
|---|---|---|---|
| p02 | prop: door (closed) | 0/14 |  |
| p02 | prop: suspicious_button (idle) | 0/14 |  |
| p02 | event: door_close classroom_door@4.9 | 0/3 |  |
| p04 | prop: door (closed) | 0/14 |  |
| p05 | cast: kira (sit) | 0/14 |  |
| p05 | prop: door (closed) | 0/14 |  |
| p06 | prop: door (closed) | 0/16 |  |
| p07 | prop: door (closed) | 0/10 |  |
| p07 | prop: spark_coin (spawned) | 1/6 |  |
| p08 | prop: door (closed) | 0/14 |  |
| p08 | prop: spark_coin (spawned) | 0/14 |  |
| p08 | event: text ui_popup@36->spark_coin | 0/3 |  |
| p09 | prop: door (closed) | 0/11 |  |
| p09 | prop: spark_coin (growing) | 0/11 |  |
| p10 | prop: door (closed) | 0/16 |  |
| p11 | cast: zapp (arms_crossed) | 5/15 |  |
| p11 | prop: spark_coin (giant) | 0/15 |  |
| p11 | event: vfx emote_sweat@52.5->zapp | 0/3 |  |
| p13 | cast: kira (sit) | 3/15 |  |
| p13 | cast: zapp (flattened) | 0/15 |  |
| p13 | prop: suspicious_button (idle) | 0/15 |  |
| p13 | prop: spark_coin (tipped) | 0/15 |  |
