#!/usr/bin/env python3
"""DSH Copilot pet — asset pipeline.

Turns the user-supplied demo image into the runtime assets the client bundle inlines:

    assets/source/character.jpg   byte-for-byte copy of the source (provenance)
    assets/character.png          full-resolution cutout (transparent background)
    assets/preview.png            human review sheet (checkerboard + light + dark, 3 sizes)
    assets/icon.png               square head crop, for docs
    plugin/src/assets.gen.json    data-URI payloads + geometry + sha256 (generated)

Design notes (why the code does what it does)
---------------------------------------------
* The demo has a flat near-white background (measured #FCFCFC). The apron, socks and
  hair highlights are ALSO near-white, so a plain chroma key would punch holes in the
  character. Instead the background is found by a flood fill from the image border:
  only pixels connected to the outside are background, so enclosed white areas survive.
* Anti-aliased edge pixels blend character -> background. Keeping them opaque leaves a
  light halo; deleting them eats the outline. They are re-estimated with a known-background
  matte (alpha solved per channel against the foreground colour sampled just inside) and
  un-premultiplied against that background.
* JPEG ringing leaves isolated speckles in the background. Only the large connected
  foreground component (plus anything touching it) is kept, so speckles disappear.
* Eye state frames ("half"/"closed"/"sleep") are synthesized from the artwork itself:
  the eye patch is squashed toward its upper edge, the cheek strip below is stretched in,
  and the result is composited through a feathered ellipse so the bangs/hair crossing the
  eye box are preserved. No external art is used anywhere.

Usage:
    python tools/build_assets.py [--source <image>] [--width 520] [--quality 85] [--check]

`--check` regenerates everything in memory and compares against the files on disk
without writing (drift check, used by the verification story).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import sys
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
ASSETS_DIR = ROOT / "assets"
GEN_JSON = ROOT / "plugin" / "src" / "assets.gen.json"

# 素材输入清单。代码在本地与"发布副本"完全一致，只换这份配置：
#   cutSource       抠图底座（键色底 #00FF00 最优：封闭洞可无歧义抠除、边缘 matting 最干净）
#   fallbackSources 底座缺失时的回退候选（发布副本里为空）
#   eraseRects      只作用于 cutSource 的擦除矩形（擦掉原图右下角水印；发布副本里为空）
#   provenance      记录进 manifest 的原始素材（哈希纳入门禁；发布副本里为空）
SOURCES_CONFIG = ASSETS_DIR / "source" / "sources.json"
DEFAULT_SOURCES_CONFIG = {
    "cutSource": "assets/source/character-green.png",
    "fallbackSources": ["assets/source/character-bg-gray.png", "assets/source/character.jpg"],
    "eraseRects": [[740, 1572, 942, 1672]],
    "provenance": ["assets/source/character.jpg"],
}


def load_sources_config() -> dict:
    """读取素材输入清单；文件不存在时用内置默认（保持历史行为）。"""
    config = dict(DEFAULT_SOURCES_CONFIG)
    if SOURCES_CONFIG.exists():
        loaded = json.loads(SOURCES_CONFIG.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise SystemExit(f"{SOURCES_CONFIG}: 顶层必须是对象")
        config.update(loaded)
    if not isinstance(config.get("cutSource"), str) or config["cutSource"] == "":
        raise SystemExit(f"{SOURCES_CONFIG}: cutSource 必须是非空字符串")
    for key in ("fallbackSources", "provenance"):
        config[key] = [str(item) for item in config.get(key) or []]
    config["eraseRects"] = [tuple(int(v) for v in rect) for rect in config.get("eraseRects") or []]
    return config


SOURCES = load_sources_config()
_CANDIDATES = [ROOT / SOURCES["cutSource"], *(ROOT / item for item in SOURCES["fallbackSources"])]
DEFAULT_SOURCE = next((path for path in _CANDIDATES if path.exists()), _CANDIDATES[0])
ERASE_RECTS = SOURCES["eraseRects"]

BACKGROUND_LEVEL = 252  # fallback flat background (the demo's near-white plate)
BACKGROUND_TOLERANCE = 8  # per-channel distance that still counts as background
MIN_FOREGROUND_AREA = 24  # connected foreground islands smaller than this are speckle

# Eye boxes in FULL-RESOLUTION source coordinates, measured off the artwork and reviewed
# against assets/preview.png. Order is [left eye (viewer's left), right eye].
EYE_BOXES = {
    "l": (348, 368, 428, 448),
    "r": (462, 332, 550, 420),
}

# 擦除矩形来自 sources.json，且**只作用于 cutSource**（见 cutout(..., erase=True)）：
# 这些矩形是为擦掉某版底图右下角的水印而设的，绝不该波及姿态/眼贴片素材。

# Eye states: (target height fraction of the box, top inset fraction).
EYE_STATES = {
    "half": (0.60, 0.05),
    "closed": (0.20, 0.0),
    "sleep": (0.12, 0.0),
}

# Optional hand-authored art. When present these REPLACE the synthesized eye frames
# (assets/source/eyes-<state>.png, same canvas as the source) and add full-body mood
# poses (assets/source/poses/<name>.png).
EYE_OVERRIDE_DIR = ASSETS_DIR / "source"
# 可接受的覆盖文件名（第一份存在的生效）：内部状态名 → 允许的文件名
EYE_OVERRIDE_ALIASES = {
    "half": ("half", "drowsy"),
    "closed": ("closed", "blink"),
    "sleep": ("sleep", "dozing"),
}
POSE_DIR = ASSETS_DIR / "source" / "poses"
POSE_WIDTH_CAP = 480
POSE_QUALITY = 80

# 拼图（character sheet）：assets/source/poses-sheet*.png，一个文件里横排/多行排列多套姿态。
# 按“整列/整行都是背景”的空档切格，再按阅读顺序映射到这些名字。
SHEET_GLOB = "poses-sheet*.png"
SHEET_NAMES = ["working", "tired", "exhausted", "wipe", "bowl", "sleep", "drag"]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def provenance_entry() -> dict:
    """素材溯源：sources.json 里 provenance 列表中的第一份存在文件（用于哈希门禁）。

    发布副本的 provenance 为空列表 → 返回 {}，manifest 仍带该键（消费者已有缺失分支）。
    """
    for item in SOURCES["provenance"]:
        path = ROOT / item
        if path.exists():
            return {"path": item, "sha256": sha256_bytes(path.read_bytes())}
    return {}


def detect_background(img: Image.Image) -> tuple:
    """Median colour of the border ring — the flat plate the artwork was drawn on.

    Works for the near-white demo plate (#FCFCFC) and for a re-rendered flat grey plate
    (#EDEDED), which is what a background-replaced source gives us. A background that is
    further from the character's own whites makes the matte cleaner.
    """
    w, h = img.size
    px = img.load()
    samples = []
    for x in range(w):
        samples.append(px[x, 0])
        samples.append(px[x, 1])
        samples.append(px[x, h - 2])
        samples.append(px[x, h - 1])
    for y in range(h):
        samples.append(px[0, y])
        samples.append(px[1, y])
        samples.append(px[w - 2, y])
        samples.append(px[w - 1, y])
    channels = [[sample[index] for sample in samples] for index in range(3)]
    return tuple(sorted(channel)[len(channel) // 2] for channel in channels)


def is_background(px, x: int, y: int, bg: tuple) -> bool:
    r, g, b = px[x, y][:3]
    return (abs(r - bg[0]) <= BACKGROUND_TOLERANCE
            and abs(g - bg[1]) <= BACKGROUND_TOLERANCE
            and abs(b - bg[2]) <= BACKGROUND_TOLERANCE)


def background_mask(img: Image.Image, bg: tuple) -> bytearray:
    """Flood fill the flat plate inward from the border."""
    w, h = img.size
    px = img.load()
    mask = bytearray(w * h)
    queue: deque[tuple[int, int]] = deque()

    def push(x: int, y: int) -> None:
        i = y * w + x
        if not mask[i] and is_background(px, x, y, bg):
            mask[i] = 1
            queue.append((x, y))

    for x in range(w):
        push(x, 0)
        push(x, h - 1)
    for y in range(h):
        push(0, y)
        push(w - 1, y)
    while queue:
        x, y = queue.popleft()
        if x > 0:
            push(x - 1, y)
        if x < w - 1:
            push(x + 1, y)
        if y > 0:
            push(x, y - 1)
        if y < h - 1:
            push(x, y + 1)
    return mask


def apply_erase_rects(img: Image.Image, bg: tuple) -> int:
    """Paint configured rectangles with the detected plate colour so the flood fill takes them."""
    if not ERASE_RECTS:
        return 0
    px = img.load()
    painted = 0
    for (x0, y0, x1, y1) in ERASE_RECTS:
        for y in range(max(0, y0), min(img.height, y1)):
            for x in range(max(0, x0), min(img.width, x1)):
                px[x, y] = bg
                painted += 1
    return painted


HOLE_TOLERANCE = 6      # “与底板同色”的紧容差（封闭洞判定用）
HOLE_MIN_AREA = 60      # 小于这个像素数的封闭同色块当噪点，不动
HOLE_MEAN_TOLERANCE = 4.0
HOLE_STDEV_LIMIT = 4.0
HOLE_GUARD_BRIGHT_DELTA = 8      # 角色自身的亮部要比底板亮这么多，才允许抠封闭洞
HOLE_GUARD_BRIGHT_AREA = 2000    # 且这样的亮部要够大（围裙级别）


HOLE_RING_BRIGHT_MAX = 0.35      # 外圈亮像素占比高于此值 → 判为“角色白里的阴影块”而不是洞
HOLE_RING_RADIUS = 2
CHROMA_SPREAD = 60               # 底板三通道极差 ≥ 此值 = 键色底（绿/品红）：封闭洞可无条件抠除
SOFT_BAND_RADIUS = 3             # 过渡带宽度（px）：键色底的边缘混合通常 1–3px，全带都要去键
KEY_EXCESS_FLOOR = 8             # 键色通道多出量 ≤ 此值视为纯前景（噪声级）


def ring_is_character_white(px, w: int, h: int, members: list, mask: bytearray, plate: float) -> float:
    """候选区域外圈的“比底板亮”像素占比。

    真洞（呆毛圈里、两腿之间、发丝缝）四周是线稿/头发/肤色 → 占比低；
    围裙、头饰蕾丝、袜子上那些平整的自身白区域 → 四周是更亮的自身白 → 占比高。
    """
    member_set = set(members)
    ring = set()
    for i in members:
        x, y = i % w, i // w
        for dy in range(-HOLE_RING_RADIUS, HOLE_RING_RADIUS + 1):
            for dx in range(-HOLE_RING_RADIUS, HOLE_RING_RADIUS + 1):
                nx, ny = x + dx, y + dy
                if not (0 <= nx < w and 0 <= ny < h):
                    continue
                j = ny * w + nx
                if j in member_set or mask[j]:
                    continue
                ring.add(j)
    if not ring:
        return 1.0
    bright = 0
    for j in ring:
        r, g, b = px[j % w, j // w]
        if (r + g + b) / 3.0 >= plate + HOLE_GUARD_BRIGHT_DELTA:
            bright += 1
    return bright / len(ring)


def fill_enclosed_holes(img: Image.Image, mask: bytearray, bg: tuple, report: dict) -> int:
    """把被头发/轮廓围住的"与底板同色"的封闭区域也判为背景。

    边界泛洪到不了这些洞（头顶呆毛圈里、两腿之间、发丝之间的缝），不处理就会留下一块
    不透明的底板色。

    两种底板，两种策略：
    * **键色底**（绿 #00FF00 / 品红 #FF00FF 这类饱和度高的纯色，`max(bg)-min(bg) ≥ CHROMA_SPREAD`）：
      角色身上不存在的颜色，判定无歧义 → 所有紧容差同色块都当洞抠掉。
    * **中性底**（近白 #FCFCFC / 浅灰 #EDECEC）：角色自己的白（围裙、头饰蕾丝、袜子）与底板
      颜色会重叠（实测灰底下围裙的平整区就在 237 附近），任何按颜色/统计的判定都会把围裙
      咬出洞 → 保守跳过，并在报告里说明，改用键色底重出。
    """
    w, h = img.size
    px = img.load()
    plate = sum(bg) / 3.0
    chroma = (max(bg) - min(bg)) >= CHROMA_SPREAD

    if not chroma:
        report["enclosed_holes"] = (
            "skipped (neutral plate overlaps the character's own whites; render a chroma-key "
            "plate such as #00FF00 to also punch the enclosed gaps)"
        )
        return 0

    # 键色底：安全护栏仍然保留——“比底板亮很多”的封闭亮区（角色自身的白）必须在场，
    # 否则说明这张图的底板其实很暗/很亮，判定不成立。
    bright_components = 0
    seen = bytearray(w * h)
    for start in range(w * h):
        if seen[start] or mask[start]:
            continue
        r, g, b = px[start % w, start // w]
        if (r + g + b) / 3.0 < plate + HOLE_GUARD_BRIGHT_DELTA:
            continue
        seen[start] = 1
        queue = deque([start])
        area = 0
        while queue:
            i = queue.popleft()
            area += 1
            x, y = i % w, i // w
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    if seen[j] or mask[j]:
                        continue
                    rr, gg, bb = px[nx, ny]
                    if (rr + gg + bb) / 3.0 >= plate + HOLE_GUARD_BRIGHT_DELTA:
                        seen[j] = 1
                        queue.append(j)
        if area >= HOLE_GUARD_BRIGHT_AREA:
            bright_components += 1
    if bright_components == 0:
        report["enclosed_holes"] = "skipped (no large bright character area found — plate looks wrong)"
        return 0

    # 紧容差同底板色且不在边界连通背景里的像素 → 连通块，全部当洞
    tight = bytearray(w * h)
    for y in range(h):
        base = y * w
        for x in range(w):
            i = base + x
            if mask[i]:
                continue
            r, g, b = px[x, y]
            if abs(r - bg[0]) <= HOLE_TOLERANCE and abs(g - bg[1]) <= HOLE_TOLERANCE and abs(b - bg[2]) <= HOLE_TOLERANCE:
                tight[i] = 1

    seen = bytearray(w * h)
    filled = 0
    accepted = []
    for start in range(w * h):
        if seen[start] or not tight[start]:
            continue
        seen[start] = 1
        queue = deque([start])
        members = []
        while queue:
            i = queue.popleft()
            members.append(i)
            x, y = i % w, i // w
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    if not seen[j] and tight[j]:
                        seen[j] = 1
                        queue.append(j)
        if len(members) < HOLE_MIN_AREA:
            continue
        for i in members:
            mask[i] = 1
        filled += len(members)
        accepted.append(len(members))
    accepted.sort(reverse=True)
    report["enclosed_holes"] = f"chroma key: {len(accepted)} hole(s), {filled}px {accepted[:6]}"
    return filled


def keep_main_component(mask: bytearray, w: int, h: int, min_area: int) -> int:
    """Drop foreground islands outside the character silhouette (JPEG speckle, watermarks).

    The rule is geometric rather than size-based: keep the largest component plus anything
    whose bounding box overlaps it (a hair strand or ruffle legitimately detached by a
    one-pixel white gap stays), drop every other island no matter how large it is.
    """
    seen = bytearray(w * h)
    components: list[tuple[int, list[int], tuple[int, int, int, int]]] = []
    for start in range(w * h):
        if mask[start] or seen[start]:
            continue
        seen[start] = 1
        queue = deque([start])
        members = [start]
        x0 = x1 = start % w
        y0 = y1 = start // w
        while queue:
            i = queue.popleft()
            x, y = i % w, i // w
            x0 = min(x0, x)
            x1 = max(x1, x)
            y0 = min(y0, y)
            y1 = max(y1, y)
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    if not mask[j] and not seen[j]:
                        seen[j] = 1
                        members.append(j)
                        queue.append(j)
        components.append((len(members), members, (x0, y0, x1, y1)))
    if not components:
        return 0
    components.sort(key=lambda entry: entry[0], reverse=True)
    main_area, main_members, main_box = components[0]
    keep = set(main_members)
    dropped = 0
    for area, members, box in components[1:]:
        overlaps = box[2] >= main_box[0] - 2 and box[0] <= main_box[2] + 2 and box[3] >= main_box[1] - 2 and box[1] <= main_box[3] + 2
        if overlaps and (area >= min_area or main_area > 0):
            continue
        for i in members:
            mask[i] = 1  # treat as background
            dropped += 1
    return dropped


def key_excess(r: int, g: int, b: int, bg: tuple) -> float:
    """键色通道相对其它通道的"多出量"：绿底看 g−max(r,b)，品红底看 min(r,b)−g。

    这是逐像素去键的度量：合成式 p = a·F + (1−a)·B 下
    `excess(p) ≈ a·excess(F) + (1−a)·excess(B)`，角色本身不含键色（excess(F) ≤ 0），
    因此 `a = 1 − excess(p) / excess(B)`，不需要估计前景色。
    """
    if bg[1] > max(bg[0], bg[2]) + 40:
        return g - max(r, b)
    if min(bg[0], bg[2]) > bg[1] + 40:
        return min(r, b) - g
    return 0.0


def key_taint(r: int, g: int, b: int, bg: tuple) -> bool:
    """该像素是否带有明显的键色成分（键色底模式专用）。"""
    return key_excess(r, g, b, bg) > KEY_EXCESS_FLOOR


def despill(r: int, g: int, b: int, bg: tuple, ceiling_delta: int = 4) -> tuple:
    """去键后的残留色偏压制：键色通道不得高出其它通道太多。"""
    if bg[1] > max(bg[0], bg[2]) + 40:
        ceiling = max(r, b) + ceiling_delta
        if g > ceiling:
            g = ceiling
    elif min(bg[0], bg[2]) > bg[1] + 40:
        ceiling = g + ceiling_delta
        if r > ceiling and b > ceiling:
            r, b = min(r, ceiling), min(b, ceiling)
    return r, g, b


def foreground_color_sample(px, mask: bytearray, w: int, h: int, x: int, y: int, band: set, radius: int = 4):
    """Colour of the nearest *definite* foreground pixel around (x, y).

    必须排除像素自身与整个过渡带：过渡带像素本身就是"底板色 + 角色色"的混合，
    拿它当 F 会导致 α 恒等于 1（这就是绿边去不掉的根因）。
    """
    best = None
    best_d = None
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            nx, ny = x + dx, y + dy
            if not (0 <= nx < w and 0 <= ny < h):
                continue
            i = ny * w + nx
            if mask[i] or i in band:
                continue
            d = dx * dx + dy * dy
            if best_d is None or d < best_d:
                best_d = d
                best = px[nx, ny][:3]
    return best


def cutout(img: Image.Image, report: dict, bg: tuple = None, erase: bool = False) -> Image.Image:
    """Return an RGBA cutout with a de-fringed alpha channel against the flat plate.

    `erase` 只在处理 cutSource 时为 True：擦除矩形（水印）不该作用于姿态/眼贴片素材。
    """
    img = img.convert("RGB")
    w, h = img.size
    if bg is None:
        bg = detect_background(img)
    chroma = (max(bg) - min(bg)) >= CHROMA_SPREAD
    report["background"] = list(bg)
    report["chroma_key"] = chroma
    report["erased_pixels"] = apply_erase_rects(img, bg) if erase else 0
    px = img.load()
    mask = background_mask(img, bg)
    report["background_pixels"] = sum(mask)
    report["speckle_pixels_dropped"] = keep_main_component(mask, w, h, MIN_FOREGROUND_AREA)
    fill_enclosed_holes(img, mask, bg, report)

    # Soft band = foreground pixels within SOFT_BAND_RADIUS of the background (a key-colour
    # render blends over 1–3 px, not 1). Every band pixel is de-keyed per pixel below.
    band_set: set[int] = set()
    frontier: set[int] = set()
    for y in range(h):
        for x in range(w):
            i = y * w + x
            if mask[i]:
                continue
            if ((x > 0 and mask[i - 1]) or (x < w - 1 and mask[i + 1])
                    or (y > 0 and mask[i - w]) or (y < h - 1 and mask[i + w])):
                band_set.add(i)
                frontier.add(i)
    for _ in range(max(0, SOFT_BAND_RADIUS - 1)):
        next_frontier: set[int] = set()
        for i in frontier:
            x, y = i % w, i // w
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    if not mask[j] and j not in band_set:
                        band_set.add(j)
                        next_frontier.add(j)
        frontier = next_frontier
        if not frontier:
            break
    # 键色底：把"带键色成分"的像素也纳入过渡带（发丝缝里透出的绿、半透明混合，
    # 它们离边界可能超过 SOFT_BAND_RADIUS，只有全图判定才不会残留绿斑）。
    if chroma:
        tainted = 0
        for y in range(h):
            base = y * w
            for x in range(w):
                i = base + x
                if mask[i] or i in band_set:
                    continue
                r0, g0, b0 = px[x, y]
                if key_taint(r0, g0, b0, bg):
                    band_set.add(i)
                    tainted += 1
        report["tainted_pixels"] = tainted
    report["soft_band_pixels"] = len(band_set)

    colors = bytearray(w * h * 3)
    alpha = bytearray(w * h)
    key_strength = key_excess(bg[0], bg[1], bg[2], bg)
    dekeyed = 0
    for y in range(h):
        row = y * w
        for x in range(w):
            i = row + x
            r, g, b = px[x, y][:3]
            if mask[i]:
                a = 0.0
            elif chroma:
                # 逐像素键色解算（不需要估计前景色）：
                #   合成式 p = a·F + (1−a)·B，取"键色通道比其它通道高多少"作为度量
                #   excess(p) ≈ a·excess(F) + (1−a)·excess(B)
                # 角色本身不含键色（excess(F) ≤ 0），于是
                #   a = 1 − excess(p) / excess(B)
                # 对整幅图逐像素成立：发丝缝里透出的绿、几像素宽的混合带、半透明处
                # 都会被算成对应的 α，而不是被当成不透明前景留下来。
                excess = key_excess(r, g, b, bg)
                if key_strength <= 0 or excess <= KEY_EXCESS_FLOOR:
                    a = 1.0
                    r, g, b = despill(r, g, b, bg)
                else:
                    a = min(1.0, max(0.0, 1.0 - excess / key_strength))
                    if a < 0.10:
                        a = 0.0
                    else:
                        dekeyed += 1
                        inv = 1.0 / a
                        r = min(255, max(0, round((r - (1 - a) * bg[0]) * inv)))
                        g = min(255, max(0, round((g - (1 - a) * bg[1]) * inv)))
                        b = min(255, max(0, round((b - (1 - a) * bg[2]) * inv)))
                        r, g, b = despill(r, g, b, bg)
            elif i in band_set:
                fg = foreground_color_sample(px, mask, w, h, x, y, band_set)
                solved = False
                if fg is not None:
                    # 已知背景色 matting（向量式）：观测 p = a·F + (1-a)·B
                    #   a = (p-B)·(F-B) / |F-B|²
                    # 中性底（近白/浅灰）没有"键色通道"可依赖，只能这样估计。
                    vr, vg, vb = fg[0] - bg[0], fg[1] - bg[1], fg[2] - bg[2]
                    denominator = vr * vr + vg * vg + vb * vb
                    if denominator >= 24 * 24:
                        a = ((r - bg[0]) * vr + (g - bg[1]) * vg + (b - bg[2]) * vb) / denominator
                        a = min(1.0, max(0.0, a))
                        solved = True
                if not solved:
                    a = 1.0  # 前景与底板几乎同色（例如围裙白 vs 浅灰底）→ 保守保留，不做去边
                if a < 0.10:
                    a = 0.0  # 几乎就是底板的像素算边缘残留
                else:
                    inv = 1.0 / a
                    r = min(255, max(0, round((r - (1 - a) * bg[0]) * inv)))
                    g = min(255, max(0, round((g - (1 - a) * bg[1]) * inv)))
                    b = min(255, max(0, round((b - (1 - a) * bg[2]) * inv)))
            else:
                a = 1.0
            colors[i * 3] = r
            colors[i * 3 + 1] = g
            colors[i * 3 + 2] = b
            alpha[i] = round(a * 255)
    if chroma:
        report["key_dekeyed_pixels"] = dekeyed

    out = Image.frombytes("RGB", (w, h), bytes(colors)).convert("RGBA")
    out.putalpha(Image.frombytes("L", (w, h), bytes(alpha)))
    # 透明像素的 RGB 必须换成邻接前景色：缩放会把"仍是底板色"的透明像素渗进边缘。
    # 层数要覆盖缩放核半径（LANCZOS 在 0.65 缩放时约 5px），所以取 6 层。
    filled = bleed_fill(colors, alpha, w, h, layers=6)
    report["bleed_fill_pixels"] = filled
    out = Image.frombytes("RGB", (w, h), bytes(colors)).convert("RGBA")
    out.putalpha(Image.frombytes("L", (w, h), bytes(alpha)))
    bbox = out.getbbox()
    report["cutout_bbox"] = list(bbox)
    return out


def bleed_fill(colors: bytearray, alpha: bytearray, w: int, h: int, layers: int = 3) -> int:
    """把贴近剪影的透明像素染成相邻前景色。

    为什么必须做：缩放（LANCZOS）会从"透明但 RGB 仍是底板色"的像素里取色，把底板色**渗进**
    边缘若干像素，于是成品会出现一圈底板色的描边/光晕（绿底时表现为一圈绿边，浅灰底时
    是一圈灰白毛边）。把 3px 内的透明像素用邻接前景色填上，缩放取到的就是角色自身的颜色。
    透明区域本身仍保持 alpha=0。
    """
    marked = bytearray(alpha)  # 非零 = 该像素已有可用颜色（前景或已填补）
    layer = set()
    for y in range(h):
        for x in range(w):
            i = y * w + x
            if alpha[i] != 0:
                continue
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h and marked[ny * w + nx] != 0:
                    layer.add(i)
                    break
    filled = 0
    for _ in range(layers):
        for i in layer:
            x, y = i % w, i // w
            total = [0, 0, 0]
            count = 0
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if not (0 <= nx < w and 0 <= ny < h):
                    continue
                j = ny * w + nx
                if marked[j] != 0:
                    total[0] += colors[j * 3]
                    total[1] += colors[j * 3 + 1]
                    total[2] += colors[j * 3 + 2]
                    count += 1
            if count > 0:
                colors[i * 3] = total[0] // count
                colors[i * 3 + 1] = total[1] // count
                colors[i * 3 + 2] = total[2] // count
                filled += 1
        for i in layer:
            marked[i] = 1
        next_layer = set()
        for i in layer:
            x, y = i % w, i // w
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    if alpha[j] == 0 and marked[j] == 0:
                        next_layer.add(j)
        layer = next_layer
        if not layer:
            break
    return filled


def feather(patch: Image.Image, blur_frac: float = 0.10) -> Image.Image:
    """Composite a patch through a feathered ellipse so it never shows a rectangular seam.

    The ellipse is inscribed in the box (2px inset), which is what keeps hair strands that
    cross the eye box outside the replaced area.
    """
    w, h = patch.size
    matte = Image.new("L", (w, h), 0)
    ImageDraw.Draw(matte).ellipse((2, 1, w - 3, h - 2), fill=255)
    matte = matte.filter(ImageFilter.GaussianBlur(max(1.8, min(w, h) * blur_frac)))
    out = patch.copy()
    out.putalpha(Image.composite(out.getchannel("A"), Image.new("L", (w, h), 0), matte))
    return out


def squash_eye(img: Image.Image, box, mode: str) -> Image.Image:
    """Synthesize one eye state as a transparent patch aligned with `img`."""
    keep_frac, inset_frac = EYE_STATES[mode]
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    patch = img.crop(box)
    cheek_h = max(4, int(h * 0.20))
    cheek = img.crop((x0, max(y0, y1 - cheek_h), x1, y1))
    keep = max(3, int(h * keep_frac))
    inset = int(h * inset_frac)
    content = cheek.resize((w, h), Image.LANCZOS)
    content.paste(patch.resize((w, keep), Image.LANCZOS), (0, inset))
    return feather(content)


def pose_entry(trimmed: Image.Image, sprite: Image.Image, name: str, report: dict):
    """Normalize one pose cutout to the idle sprite's height and encode it as inline webp."""
    if trimmed.width < 8 or trimmed.height < 8:
        report.setdefault("pose_rejected", []).append(f"{name}: empty cutout")
        return None
    height = sprite.height
    width = max(8, round(trimmed.width * height / trimmed.height))
    scaled = resize_rgba(trimmed, (width, height))
    if scaled.width > POSE_WIDTH_CAP:
        scaled = resize_rgba(scaled, (POSE_WIDTH_CAP, max(8, round(scaled.height * POSE_WIDTH_CAP / scaled.width))))
    payload = encode_webp(scaled, POSE_QUALITY)
    report.setdefault("poses", []).append(f"{name} {scaled.width}x{scaled.height} {len(payload)}B")
    return {
        "width": scaled.width,
        "height": scaled.height,
        "uri": data_uri(payload),
        "sha256": sha256_bytes(payload),
    }


def build_poses(sprite: Image.Image, report: dict) -> dict:
    """Optional full-body mood poses.

    Two sources, both optional:
      assets/source/poses/<name>.png   one file per pose
      assets/source/poses-sheet*.png   a character sheet; cells are detected by their gutters
                                       (a fully-background row/column band) and named in
                                       reading order from SHEET_NAMES.
    Each pose is normalized to the idle sprite's height so switching poses never changes how
    tall the character looks; the runtime bottom-aligns and centers them.
    """
    poses: dict = {}
    if POSE_DIR.is_dir():
        for path in sorted(POSE_DIR.glob("*.png")):
            name = path.stem
            pose_img = Image.open(io.BytesIO(path.read_bytes())).convert("RGB")
            cut = cutout(pose_img, {})
            box = cut.getbbox()
            if box is None:
                report.setdefault("pose_rejected", []).append(f"{name}: empty cutout")
                continue
            entry = pose_entry(cut.crop(box), sprite, name, report)
            if entry is not None:
                poses[name] = entry
    for sheet in sorted(ASSETS_DIR.joinpath("source").glob(SHEET_GLOB)):
        sheet_img = Image.open(io.BytesIO(sheet.read_bytes())).convert("RGB")
        cells = slice_sheet(sheet_img)
        report.setdefault("sheet_cells", []).append(f"{sheet.name}: {len(cells)} cell(s)")
        if len(cells) > len(SHEET_NAMES):
            report.setdefault("sheet_warning", []).append(
                f"{sheet.name}: {len(cells)} cells > {len(SHEET_NAMES)} names; extra cells ignored"
            )
        for index, cell in enumerate(cells):
            if index >= len(SHEET_NAMES):
                break
            name = SHEET_NAMES[index]
            cut = cutout(cell, {})
            box = cut.getbbox()
            if box is None:
                report.setdefault("pose_rejected", []).append(f"{sheet.name}#{index}: empty cutout")
                continue
            entry = pose_entry(cut.crop(box), sprite, f"{name} ({sheet.name})", report)
            if entry is not None:
                poses[name] = entry
    return poses


def slice_sheet(sheet: Image.Image) -> list:
    """Split a character sheet by fully-background row/column bands (clear gutters required)."""
    w, h = sheet.size
    bg = detect_background(sheet)
    mask = background_mask(sheet, bg)
    columns = [all(mask[y * w + x] for y in range(h)) for x in range(w)]
    rows = [all(mask[y * w + x] for x in range(w)) for y in range(h)]

    def bands(flags: list) -> list:
        out = []
        start = None
        for index, is_background in enumerate(flags):
            if not is_background and start is None:
                start = index
            elif is_background and start is not None:
                out.append((start, index))
                start = None
        if start is not None:
            out.append((start, len(flags)))
        return out

    cells = []
    for (y0, y1) in bands(rows):
        for (x0, x1) in bands(columns):
            if (x1 - x0) < 12 or (y1 - y0) < 12:
                continue
            cell = sheet.crop((x0, y0, x1, y1))
            # 只有真的带着前景的格子才算一格（避免角落的小噪点被当成姿态）
            cell_mask = background_mask(cell, bg)
            foreground = len(cell_mask) - sum(cell_mask)
            if foreground < max(500, int(w * h * 0.002)):
                continue
            cells.append(cell)
    return cells


def encode_webp(img: Image.Image, quality: int, lossless: bool = True) -> bytes:
    """内联素材统一用**无损** WebP。

    有损 WebP 会在深色发丝这类高频区域搬动色度（4:2:0 子采样），实测会给成品重新引入
    可见的绿色残留（q85 下 100 个不透明像素，q95 仍有 57 个）；无损编码则为 0。
    代价是主图从 91KB 涨到约 377KB，仍然全部内联、仍然零出网零 token。
    """
    buffer = io.BytesIO()
    if lossless:
        img.save(buffer, "WEBP", lossless=True, method=6, exact=True)
    else:
        img.save(buffer, "WEBP", quality=quality, method=6, exact=True)
    return buffer.getvalue()


def resize_rgba(img: Image.Image, size: tuple, resample=Image.LANCZOS) -> Image.Image:
    """Alpha-aware resize: premultiply → resize → unpremultiply.

    直接对 RGBA 做 LANCZOS 有两个问题：
      1) 透明像素的 RGB 参与卷积，会把底板色渗进边缘形成描边/光晕；
      2) LANCZOS 的负瓣会在高频细节上产生 ringing，把中性像素振出通道偏色
         （实测 520px 档出现过 g 比 max(r,b) 高 59 的像素）。
    先在预乘空间缩放再反预乘，两者都消失。
    """
    from PIL import ImageChops, ImageMath
    alpha = img.getchannel("A")
    channels = [ImageChops.multiply(img.getchannel(name), alpha) for name in ("R", "G", "B")]
    scaled_alpha = alpha.resize(size, resample)
    # 分母下限：α≈0 的像素上反预乘会把颜色放大成饱和色（实测出现过 (0,255,0) 的纯绿点）。
    # 这类像素本来就看不见，直接把分母当作 255，颜色随之趋近 0。
    denominator = scaled_alpha.point(lambda value: 255 if value < 8 else value)
    scaled = []
    for channel in channels:
        premultiplied = channel.resize(size, resample)
        unmultiplied = ImageMath.lambda_eval(
            lambda args: args["convert"](args["p"] * 255 / args["d"], "L"),
            {"p": premultiplied, "d": denominator},
        )
        scaled.append(unmultiplied)
    out = Image.merge("RGBA", [*scaled, scaled_alpha])
    return out


def final_despill(img: Image.Image, bg: tuple) -> Image.Image:
    """缩放/合成之后的最后一道保险：不透明像素里不得残留键色成分。

    为什么还要在最后做一次：alpha 混合与缩放都会让通道差被重新组合，即使每个输入像素
    都已被 despill，混合结果仍可能重新出现一点键色倾向。这一步把不变量钉死在产物上。
    """
    if key_excess(bg[0], bg[1], bg[2], bg) <= 0:
        return img
    px = img.load()
    w, h = img.size
    fixed = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            r2, g2, b2 = despill(r, g, b, bg)
            if (r2, g2, b2) != (r, g, b):
                px[x, y] = (r2, g2, b2, a)
                fixed += 1
    return img


def data_uri(payload: bytes) -> str:
    return "data:image/webp;base64," + base64.b64encode(payload).decode("ascii")


def checkerboard(size, cell: int = 16) -> Image.Image:
    im = Image.new("RGB", size, (206, 208, 212))
    d = ImageDraw.Draw(im)
    for y in range(0, size[1], cell):
        for x in range(0, size[0], cell):
            if ((x // cell) + (y // cell)) % 2:
                d.rectangle((x, y, x + cell - 1, y + cell - 1), fill=(166, 169, 175))
    return im


def build(source: Path, width: int, quality: int) -> tuple[dict, dict[str, bytes]]:
    report: dict = {}
    raw = source.read_bytes()
    report["source_sha256"] = sha256_bytes(raw)
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    report["source_size"] = list(img.size)

    cut = cutout(img, report, erase=True)
    plate = tuple(report["background"])
    bbox = tuple(report["cutout_bbox"])
    trimmed = cut.crop(bbox)
    scale = width / trimmed.width
    sprite = final_despill(resize_rgba(trimmed, (width, max(1, round(trimmed.height * scale)))), plate)

    payloads: dict[str, bytes] = {}
    character_png = io.BytesIO()
    trimmed.save(character_png, "PNG", optimize=True)
    payloads["character.png"] = character_png.getvalue()
    base_bytes = encode_webp(sprite, quality)
    payloads["main.webp"] = base_bytes

    # Square head avatar, cropped from the sprite in sprite coordinates.
    head_h = round(sprite.width * 1.0)
    head = sprite.crop((0, 0, sprite.width, min(head_h, sprite.height)))
    side = min(head.size)
    left = (head.width - side) // 2
    avatar = final_despill(resize_rgba(head.crop((left, 0, left + side, side)), (96, 96)), plate)
    payloads["avatar.webp"] = encode_webp(avatar, quality)

    bx0, by0, _, _ = bbox
    eyes = {}
    for state in EYE_STATES:
        per_eye = []
        override = None
        for alias in EYE_OVERRIDE_ALIASES[state]:
            candidate_path = EYE_OVERRIDE_DIR / f"eyes-{alias}.png"
            if candidate_path.exists():
                override = candidate_path
                break
        override_img = None
        if override is not None:
            candidate = Image.open(override).convert("RGB")
            tolerance = 4
            dx = abs(candidate.width - img.width)
            dy = abs(candidate.height - img.height)
            if dx <= tolerance and dy <= tolerance:
                # 生成器常给出 ±1~4px 的浮动画布：先归一到源图尺寸，再按同一组眼框裁片。
                # 超过容差则拒绝（宁可回落合成，也不要静默错位）。
                if candidate.size != img.size:
                    candidate = candidate.resize(img.size, Image.LANCZOS)
                    report.setdefault("eye_override_resized", []).append(
                        f"{state}: {dx}x{dy}px -> {img.size[0]}x{img.size[1]}"
                    )
                override_img = candidate
                report.setdefault("eye_overrides", []).append(state)
            else:
                report.setdefault("eye_override_rejected", []).append(
                    f"{state}: {candidate.size[0]}x{candidate.size[1]} != {img.size[0]}x{img.size[1]} (tolerance {tolerance}px)"
                )
        for key in ("l", "r"):
            full_box = EYE_BOXES[key]
            scaled = (
                round((full_box[0] - bx0) * scale),
                round((full_box[1] - by0) * scale),
                round((full_box[2] - bx0) * scale),
                round((full_box[3] - by0) * scale),
            )
            scaled = tuple(max(0, v) for v in scaled)
            if override_img is not None:
                patch = feather(override_img.crop(full_box).resize(
                    (scaled[2] - scaled[0], scaled[3] - scaled[1]), Image.LANCZOS
                ).convert("RGBA"))
            else:
                patch = squash_eye(sprite, scaled, state)
            payload = encode_webp(patch, 92)
            payloads[f"eye-{state}-{key}.webp"] = payload
            per_eye.append({
                # box 一律以 [x, y, w, h]（精灵图像素）表示，运行时按百分比定位。
                "box": [scaled[0], scaled[1], scaled[2] - scaled[0], scaled[3] - scaled[1]],
                "uri": data_uri(payload),
                "sha256": sha256_bytes(payload),
                "source": "hand-authored" if override_img is not None else "synthesized",
            })
        eyes[state] = per_eye

    poses = build_poses(sprite, report)

    manifest = {
        "version": 1,
        "generator": "tools/build_assets.py",
        "source": {
            "path": str(source.relative_to(ROOT)).replace("\\", "/"),
            "sha256": report["source_sha256"],
            "width": report["source_size"][0],
            "height": report["source_size"][1],
            "background": report.get("background"),
        },
        "provenance": provenance_entry(),
        "cutout": {"bbox": list(bbox), "scale": round(scale, 6)},
        "sprite": {
            "width": sprite.width,
            "height": sprite.height,
            "uri": data_uri(base_bytes),
            "sha256": sha256_bytes(base_bytes),
            "bytes": len(base_bytes),
        },
        "avatar": {
            "width": 96,
            "height": 96,
            "uri": data_uri(payloads["avatar.webp"]),
            "sha256": sha256_bytes(payloads["avatar.webp"]),
        },
        "eyes": eyes,
        "poses": poses,
    }
    report["sprite_size"] = [sprite.width, sprite.height]
    report["sprite_webp_bytes"] = len(base_bytes)
    report["inline_bytes"] = sum(
        len(payload) for name, payload in payloads.items() if name != "character.png"
    )
    report["base64_bytes"] = len(json.dumps(manifest))
    files = dict(payloads)
    files["assets.gen.json"] = json.dumps(manifest, indent=2).encode("utf-8")
    report["_preview"] = (sprite, avatar, manifest)
    return report, files


def _png_bytes(img: Image.Image) -> io.BytesIO:
    buffer = io.BytesIO()
    img.save(buffer, "PNG", optimize=True)
    return buffer


def preview_sheet(sprite: Image.Image, avatar: Image.Image, manifest: dict) -> Image.Image:
    """Human review sheet: three sizes on a checkerboard, a dark strip, and zoomed eye states."""
    pad = 18
    tiles = []
    for width in (260, 520, 180):
        tile = sprite.resize((width, max(1, round(sprite.height * width / sprite.width))), Image.LANCZOS)
        back = checkerboard(tile.size)
        back.paste(tile, (0, 0), tile)
        tiles.append(tile.resize((width, tile.height)).convert("RGB"))
        tiles[-1] = back
    band_h = 120
    height = max(t.height for t in tiles) + 40
    width_total = sum(t.width for t in tiles) + pad * (len(tiles) + 1)
    sheet = Image.new("RGB", (width_total, height + band_h + 30), (245, 246, 248))
    d = ImageDraw.Draw(sheet)
    x = pad
    for label, back in zip(("260px (min)", "520px (default)", "180px (narrow)"), tiles):
        sheet.paste(back, (x, 30))
        d.text((x, 14), label, fill=(30, 30, 40))
        x += back.width + pad

    dark = Image.new("RGB", (width_total, band_h), (18, 20, 26))
    thumb = sprite.resize((90, max(1, round(sprite.height * 90 / sprite.width))), Image.LANCZOS)
    dark.paste(thumb, (pad, 15), thumb)
    d.text((pad + 100, 20), "dark background check", fill=(232, 234, 242))
    d.text((pad + 100, 42), "eye states (half / closed / sleep), 2x nearest", fill=(232, 234, 242))
    zx = pad + 100
    for state in ("half", "closed", "sleep"):
        for eye in manifest["eyes"][state]:
            ex, ey, ew, eh = eye["box"]
            region = (ex, ey, ex + ew, ey + eh)
            patch = Image.open(io.BytesIO(base64.b64decode(eye["uri"].split(",", 1)[1]))).convert("RGBA")
            composed = sprite.crop(region).copy()
            composed.paste(patch, (0, 0), patch)
            zoom = composed.resize((ew * 2, eh * 2), Image.NEAREST)
            if zx + zoom.width > width_total - 130:
                break
            dark.paste(zoom, (zx, band_h - zoom.height - 12), zoom)
            zx += zoom.width + 6
    dark.paste(avatar.resize((64, 64), Image.LANCZOS), (width_total - 85, band_h // 2 - 32))
    sheet.paste(dark, (0, height + 10))
    if manifest.get("poses"):
        names = list(manifest["poses"].keys())
        pose_band = Image.new("RGB", (width_total, 200), (238, 240, 245))
        pd = ImageDraw.Draw(pose_band)
        pd.text((pad, 6), "hand-authored poses (drop these in assets/source/poses/): " + ", ".join(names), fill=(30, 30, 40))
        px = pad
        for name in names:
            payload = base64.b64decode(manifest["poses"][name]["uri"].split(",", 1)[1])
            thumb = Image.open(io.BytesIO(payload)).convert("RGBA")
            scale_h = 150
            thumb = thumb.resize((max(1, round(thumb.width * scale_h / thumb.height)), scale_h), Image.LANCZOS)
            back = checkerboard(thumb.size, cell=10)
            back.paste(thumb, (0, 0), thumb)
            if px + back.width > width_total - pad:
                break
            pose_band.paste(back, (px, 24))
            pd.text((px, 178), name, fill=(30, 30, 40))
            px += back.width + 8
        sheet.paste(pose_band, (0, height + 140))
    return sheet


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the DSH Copilot pet assets.")
    parser.add_argument("--source", default=str(DEFAULT_SOURCE))
    parser.add_argument("--width", type=int, default=520)
    parser.add_argument("--quality", type=int, default=85)
    parser.add_argument("--check", action="store_true", help="compare against on-disk artifacts without writing")
    args = parser.parse_args()

    report, files = build(Path(args.source), args.width, args.quality)
    sprite, avatar, manifest = report.pop("_preview")
    preview = preview_sheet(sprite, avatar, manifest)

    targets = {
        "assets/character.png": files["character.png"],
        "plugin/src/assets.gen.json": files["assets.gen.json"],
    }
    # preview lives next to the other human-review artifacts
    preview_target = ASSETS_DIR / "preview.png"
    icon_target = ASSETS_DIR / "icon.png"

    if args.check:
        drift = []
        for rel, payload in targets.items():
            path = ROOT / rel
            if not path.exists() or path.read_bytes() != payload:
                drift.append(rel)
        if drift:
            print("DRIFT: " + ", ".join(drift))
            return 1
        print("assets: no drift")
        return 0

    for rel, payload in targets.items():
        path = ROOT / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
    preview.save(preview_target)
    avatar.resize((256, 256), Image.LANCZOS).convert("RGB").save(icon_target)

    print(json.dumps(report, indent=2, ensure_ascii=False))
    print(f"wrote {preview_target.relative_to(ROOT)} and {icon_target.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
