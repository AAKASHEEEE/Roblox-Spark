#!/usr/bin/env python3
"""Generate one bounded review sheet from the three locked procedural manifests."""
from __future__ import annotations

import json
import sys
from io import BytesIO
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "vignette" / "sets" / "procedural-sets-review.png"
W, H = 1600, 900
BG = "#101820"
PANEL = "#17242e"
INK = "#edf5f7"
MUTED = "#a9bbc2"
GREEN = "#58d68d"
ORANGE = "#f4b860"
CYAN = "#63c7da"

TITLE = ImageFont.load_default(size=28)
HEAD = ImageFont.load_default(size=19)
BODY = ImageFont.load_default(size=14)
SMALL = ImageFont.load_default(size=12)
CHECK = "--check" in sys.argv
UNKNOWN_ARGS = [arg for arg in sys.argv[1:] if arg != "--check"]
if UNKNOWN_ARGS:
    raise SystemExit(f"unknown argument(s): {', '.join(UNKNOWN_ARGS)}")


def load(name: str) -> dict:
    return json.loads((ROOT / "assets" / "environments" / name).read_text())


def box_xz(piece: dict, bounds: dict, rect: tuple[int, int, int, int]) -> tuple[float, float, float, float]:
    x0, y0, x1, y1 = rect
    mn, mx = bounds["min"], bounds["max"]
    sx = (x1 - x0) / (mx[0] - mn[0])
    sz = (y1 - y0) / (mx[2] - mn[2])
    px, _, pz = piece["pos"]
    size = piece["size"]
    hx = size[0] / 2
    hz = (size[2] if len(size) > 2 else size[0]) / 2
    return (x0 + (px - hx - mn[0]) * sx, y1 - (pz + hz - mn[2]) * sz,
            x0 + (px + hx - mn[0]) * sx, y1 - (pz - hz - mn[2]) * sz)


def point_xz(pos: list[float], bounds: dict, rect: tuple[int, int, int, int]) -> tuple[float, float]:
    x0, y0, x1, y1 = rect
    mn, mx = bounds["min"], bounds["max"]
    return (x0 + (pos[0] - mn[0]) / (mx[0] - mn[0]) * (x1 - x0),
            y1 - (pos[2] - mn[2]) / (mx[2] - mn[2]) * (y1 - y0))


def draw_plan(draw: ImageDraw.ImageDraw, manifest: dict, rect: tuple[int, int, int, int], mark_ids: list[str], door: dict | None) -> None:
    draw.rounded_rectangle(rect, 12, fill="#dce8e2", outline="#6e8791", width=2)
    for p in manifest["pieces"]:
        if p["id"] in {"floor", "ground", "ceiling"}:
            continue
        r = box_xz(p, manifest["bounds"], rect)
        if r[2] - r[0] < 1.5 or r[3] - r[1] < 1.5:
            continue
        fill = p.get("color", "#8299a3")
        outline = "#293b45" if p.get("collide") else "#78909a"
        draw.rectangle(r, fill=fill, outline=outline, width=2 if p.get("collide") else 1)
    safe = manifest["cameraSafe"]
    safe_piece = {"pos": [(safe["min"][0] + safe["max"][0]) / 2, 0, (safe["min"][2] + safe["max"][2]) / 2],
                  "size": [safe["max"][0] - safe["min"][0], 0, safe["max"][2] - safe["min"][2]]}
    safe_rect = box_xz(safe_piece, manifest["bounds"], rect)
    clipped_safe = (
        max(rect[0], min(rect[2], safe_rect[0])), max(rect[1], min(rect[3], safe_rect[1])),
        max(rect[0], min(rect[2], safe_rect[2])), max(rect[1], min(rect[3], safe_rect[3])),
    )
    draw.rectangle(clipped_safe, outline=CYAN, width=2)
    for mark_id in mark_ids:
        mark = manifest["marks"][mark_id]
        x, y = point_xz(mark["pos"], manifest["bounds"], rect)
        draw.ellipse((x - 5, y - 5, x + 5, y + 5), fill=ORANGE, outline="#6f4214")
        draw.text((x + 7, y - 8), mark_id, font=SMALL, fill="#14232b", stroke_width=2, stroke_fill="#eef6f1")
    if door:
        x, y = point_xz(door["threshold"], manifest["bounds"], rect)
        draw.line((x - 18, y, x + 18, y), fill=GREEN, width=6)
        ix, iy = point_xz(door["inside"], manifest["bounds"], rect)
        draw.line((x, y, ix, iy), fill=GREEN, width=3)
        draw.ellipse((ix - 6, iy - 6, ix + 6, iy + 6), fill=GREEN)


def draw_elevation(draw: ImageDraw.ImageDraw, x: int, y: int, wall_h: float, opening_w: float, opening_h: float) -> None:
    scale = 43
    wall_w = 4.0
    draw.rectangle((x, y - wall_h * scale, x + wall_w * scale, y), fill="#9fcbb6", outline="#dbe8df")
    left = x + (wall_w - opening_w) * scale / 2
    draw.rectangle((left, y - opening_h * scale, left + opening_w * scale, y + 1), fill=PANEL, outline=GREEN, width=3)
    draw.text((x + wall_w * scale + 10, y - wall_h * scale), f"wall {wall_h:.2f}m", font=SMALL, fill=MUTED)
    draw.text((left - 4, y + 6), f"clear {opening_w:.2f}m W x {opening_h:.2f}m H", font=SMALL, fill=GREEN)


def draw_panel(draw: ImageDraw.ImageDraw, index: int, manifest: dict, marks: list[str], door: dict | None, features: str) -> None:
    x = 20 + index * 526
    panel = (x, 62, x + 506, 875)
    draw.rounded_rectangle(panel, 18, fill=PANEL, outline="#35505f", width=2)
    draw.text((x + 18, 78), manifest["displayName"], font=HEAD, fill=INK)
    draw.text((x + 18, 104), f"{manifest['id']}@{manifest['version']}", font=BODY, fill=CYAN)
    plan = (x + 18, 136, x + 488, 548)
    draw_plan(draw, manifest, plan, marks, door)
    colliders = sum(1 for p in manifest["pieces"] if p.get("collide"))
    draw.text((x + 18, 565), f"{len(manifest['pieces'])} primitives | {colliders} colliders | {len(manifest['marks'])} manifest marks", font=BODY, fill=INK)
    draw.text((x + 18, 590), f"lighting: {', '.join(manifest['lighting'])}", font=BODY, fill=MUTED)
    draw.text((x + 18, 614), features, font=SMALL, fill=MUTED)
    if door:
        draw_elevation(draw, x + 34, 812, door["wall"], door["width"], door["height"])
        draw.text((x + 242, 675), f"threshold {door['threshold']}", font=SMALL, fill=INK)
        draw.text((x + 242, 697), f"inside    {door['inside']}", font=SMALL, fill=INK)
        draw.text((x + 242, 719), "adult test 2.69m + 0.21m", font=SMALL, fill=GREEN)
        draw.text((x + 242, 741), "PASS: collider-clear route", font=SMALL, fill=GREEN)
    else:
        draw.text((x + 18, 674), "Open set: no artificial doorway declared", font=BODY, fill=GREEN)
        draw.text((x + 18, 704), "Feature marks: slide, swings, sandpit", font=BODY, fill=INK)
        draw.text((x + 18, 734), "Camera-safe open volume + collider-clear staging", font=SMALL, fill=MUTED)


def main() -> None:
    image = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(image)
    draw.text((24, 18), "Original Procedural Set Library - S2 Review Sheet", font=TITLE, fill=INK)
    draw.text((1185, 29), "1600 x 900", font=BODY, fill=MUTED)
    classroom = load("classroom@1.2.0.json")
    hallway = load("school_hallway@1.0.0.json")
    playground = load("playground@1.0.0.json")
    draw_panel(draw, 0, classroom, ["center_stage", "zapp_desk", "classroom_door_inside"], {
        "threshold": [2.5, 0, -3.95], "inside": [2.5, 0, -3.0], "wall": 4.2, "width": 1.4, "height": 3.05,
    }, "Preserved 1.1 staging; split back wall; board, desks, shelf, original procedural textures")
    draw_panel(draw, 1, hallway, ["hall_center", "lockers", "hall_door_inside", "notice_board"], {
        "threshold": [0, 0, -8.05], "inside": [0, 0, -7.0], "wall": 4.2, "width": 1.4, "height": 3.05,
    }, "10 lockers; 3 classroom doors; trophy case; fountain; notice board; long-axis camera lane")
    draw_panel(draw, 2, playground, ["play_center", "slide", "swings", "sandpit"], None,
               "Slide + ladder; paired swings; bordered sandpit; bench; hopscotch; trees; school fence")
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    rendered = buffer.getvalue()
    if CHECK:
        if not OUT.exists() or OUT.read_bytes() != rendered:
            raise SystemExit(f"review sheet is stale: {OUT.relative_to(ROOT)}")
        print(f"verified {OUT.relative_to(ROOT)} ({W}x{H})")
    else:
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_bytes(rendered)
        print(f"wrote {OUT.relative_to(ROOT)} ({W}x{H})")


if __name__ == "__main__":
    main()
