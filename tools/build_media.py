#!/usr/bin/env python3
"""DSH Copilot pet — README media builder.

从已构建的素材清单 `plugin/src/assets.gen.json` 生成 README 用的效果图：

    docs/media/hero.gif    呼吸 + 眨眼（真实眼贴片）+ 气泡，约 2s 循环
    docs/media/moods.png   八态长图（2×4），ASCII 或中文小标签
    docs/media/drag.gif    被拎起来：整帧 + 三颗小汗滴依次滴落 + 气泡

设计约束
--------
* **确定性**：不写时间戳、帧数与相位写死 → 同输入同字节，`--check` 可做漂移比对。
* **不依赖本机字体**：默认用 Pillow 内置位图字体（ASCII 文案）；若系统存在常见 CJK 字体
  （Windows 微软雅黑 / 黑体，Linux Noto CJK）则自动使用并渲染中文文案；也可 `--font` 显式指定。
  解析到的字体路径会记进 `docs/media/media.json`，`--check` 会一并报告。
* 生成物**随仓库提交**：README 用相对路径引用即可（私有仓库同样渲染）。

用法：
    python tools/build_media.py            # 重建三张效果图
    python tools/build_media.py --check    # 与磁盘上的图逐字节比对
    python tools/build_media.py --font C:/Windows/Fonts/msyh.ttc
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
MANIFEST_FILE = ROOT / "plugin" / "src" / "assets.gen.json"
MEDIA_DIR = ROOT / "docs" / "media"
MEDIA_INDEX = MEDIA_DIR / "media.json"

CARD_W, CARD_H = 400, 500
CARD_RADIUS = 22
GRADIENT_TOP = (30, 38, 58)
GRADIENT_BOTTOM = (12, 16, 26)
BORDER = (58, 72, 104)
SPRITE_W = 250
SPRITE_BOTTOM_MARGIN = 24

BUBBLE_BG = (244, 246, 252)
BUBBLE_FG = (24, 28, 40)

HERO_FRAMES = 20
DRAG_FRAMES = 12
GIF_COLORS = 56
MOOD_TILE_W = 150
MOOD_COLS = 4

CJK_FONT_CANDIDATES = (
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/PingFang.ttc",
)

HERO_LINES = ("正在干活…", "上下文快满了…", "呼——轻松多了！")
MOOD_LABELS = ("待机", "工作中", "疲倦", "快撑不住", "打盹", "擦汗", "空碗", "被拎起来")
MOOD_LABELS_ASCII = ("idle", "working", "tired", "exhausted", "sleep", "wipe", "bowl", "drag")
DRAG_LINE = "欸欸…放我下来！"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def load_manifest() -> dict:
    if not MANIFEST_FILE.exists():
        raise SystemExit(f"missing {MANIFEST_FILE.relative_to(ROOT)} — run: python tools/build_assets.py")
    return json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))


def decode_asset(entry: dict) -> Image.Image:
    payload = base64.b64decode(entry["uri"].split(",", 1)[1])
    return Image.open(io.BytesIO(payload)).convert("RGBA")


def resolve_font(explicit: str | None) -> tuple[str | None, bool]:
    """返回 (字体路径 或 None, 是否支持中文)。"""
    candidates = [explicit] if explicit else []
    if not explicit:
        candidates = [path for path in CJK_FONT_CANDIDATES if Path(path).exists()]
    for path in candidates:
        if path and Path(path).exists():
            return path, True
    return None, False


def make_font(path: str | None, size: int) -> ImageFont.ImageFont:
    if path is not None:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default(size=size) if hasattr(ImageFont.load_default, "__call__") else ImageFont.load_default()


def make_card() -> Image.Image:
    card = Image.new("RGB", (CARD_W, CARD_H), GRADIENT_BOTTOM)
    draw = ImageDraw.Draw(card)
    for y in range(CARD_H):
        ratio = y / (CARD_H - 1)
        draw.line(
            [(0, y), (CARD_W, y)],
            fill=tuple(round(top + (bottom - top) * ratio) for top, bottom in zip(GRADIENT_TOP, GRADIENT_BOTTOM)),
        )
    mask = Image.new("L", (CARD_W, CARD_H), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, CARD_W - 1, CARD_H - 1), radius=CARD_RADIUS, fill=255)
    out = Image.new("RGB", (CARD_W, CARD_H), GRADIENT_BOTTOM)
    out.paste(card, (0, 0), mask)
    ImageDraw.Draw(out).rounded_rectangle((0, 0, CARD_W - 1, CARD_H - 1), radius=CARD_RADIUS, outline=BORDER, width=2)
    return out


def draw_bubble(canvas: Image.Image, text: str, font, anchor_xy: tuple[int, int]) -> None:
    draw = ImageDraw.Draw(canvas)
    box = draw.textbbox((0, 0), text, font=font)
    text_w, text_h = box[2] - box[0], box[3] - box[1]
    pad_x, pad_y = 14, 9
    w, h = text_w + pad_x * 2, text_h + pad_y * 2
    x, y = anchor_xy
    x = max(12, min(CARD_W - w - 12, x))
    draw.rounded_rectangle((x, y, x + w, y + h), radius=14, fill=BUBBLE_BG)
    draw.polygon([(x + w * 0.32, y + h), (x + w * 0.48, y + h), (x + w * 0.38, y + h + 12)], fill=BUBBLE_BG)
    draw.text((x + pad_x, y + pad_y - box[1]), text, font=font, fill=BUBBLE_FG)


def draw_sweat(canvas: Image.Image, x: int, y: int, size: int, alpha: int) -> None:
    layer = Image.new("RGBA", (size * 3, size * 4), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    draw.ellipse((size, size * 1.4, size * 2, size * 2.6), fill=(143, 208, 255, alpha))
    draw.polygon([(size * 1.5, 0), (size * 2.05, size * 1.9), (size * 0.95, size * 1.9)], fill=(143, 208, 255, alpha))
    draw.ellipse((size * 1.2, size * 1.6, size * 1.5, size * 1.9), fill=(224, 240, 255, min(255, alpha + 40)))
    canvas.paste(layer, (x - size, y - size), layer)


def paste_sprite(canvas: Image.Image, sprite: Image.Image, eye_patches, eye_state: str, dy: int) -> None:
    scaled = sprite.resize((SPRITE_W, round(sprite.height * SPRITE_W / sprite.width)), Image.LANCZOS)
    x = (CARD_W - scaled.width) // 2
    y = CARD_H - SPRITE_BOTTOM_MARGIN - scaled.height + dy
    canvas.paste(scaled, (x, y), scaled)
    if eye_state == "open" or eye_patches is None:
        return
    ratio = SPRITE_W / sprite.width
    for patch in eye_patches:
        bx, by, bw, bh = patch["box"]
        patch_img = decode_asset(patch).resize((max(1, round(bw * ratio)), max(1, round(bh * ratio))), Image.LANCZOS)
        canvas.paste(patch_img, (x + round(bx * ratio), y + round(by * ratio)), patch_img)


def hero_frames(manifest: dict, font) -> list[Image.Image]:
    sprite = decode_asset(manifest["sprite"])
    eyes_half = manifest["eyes"]["half"]
    eyes_closed = manifest["eyes"]["closed"]
    frames = []
    for index in range(HERO_FRAMES):
        phase = index / HERO_FRAMES
        card = make_card()
        # 呼吸：上下 6px 正弦；眨眼：第 8 帧半闭、第 9 帧闭合、第 10 帧半闭
        dy = round(-6 * math.sin(phase * 2 * math.pi) / 2) - 3
        if index == 8:
            state, patches = "half", eyes_half
        elif index == 9:
            state, patches = "closed", eyes_closed
        elif index == 10:
            state, patches = "half", eyes_half
        else:
            state, patches = "open", None
        paste_sprite(card, sprite, patches, state, dy)
        if 13 <= index <= 21:
            draw_bubble(card, HERO_LINES[(index // 3) % len(HERO_LINES)], font, (26, 26))
        frames.append(card)
    return frames


def drag_frames(manifest: dict, font) -> list[Image.Image]:
    sprite = decode_asset(manifest["poses"]["drag"])
    frames = []
    for index in range(DRAG_FRAMES):
        card = make_card()
        wobble = round(4 * math.sin(index / DRAG_FRAMES * 2 * math.pi))
        paste_sprite(card, sprite, None, "open", wobble)
        for drop in range(3):
            progress = ((index + drop * 6) % DRAG_FRAMES) / DRAG_FRAMES
            alpha = 255 if progress < 0.75 else round(255 * (1 - (progress - 0.75) / 0.25))
            draw_sweat(
                card,
                330 + drop * 26,
                96 + round(progress * 70),
                6 + drop,
                max(0, alpha),
            )
        draw_bubble(card, DRAG_LINE, font, (26, 26))
        frames.append(card)
    return frames


def moods_image(manifest: dict, font, cjk: bool) -> Image.Image:
    tiles = [decode_asset(manifest["sprite"])]
    for name in ("working", "tired", "exhausted", "sleep", "wipe", "bowl", "drag"):
        tiles.append(decode_asset(manifest["poses"][name]))
    labels = MOOD_LABELS if cjk else MOOD_LABELS_ASCII
    tile_w, tile_h = MOOD_TILE_W, 196
    rows = math.ceil(len(tiles) / MOOD_COLS)
    pad = 18
    width = pad + MOOD_COLS * (tile_w + pad)
    height = pad + rows * (tile_h + pad + 22)
    sheet = Image.new("RGB", (width, height), GRADIENT_BOTTOM)
    for index, tile in enumerate(tiles):
        col, row = index % MOOD_COLS, index // MOOD_COLS
        x = pad + col * (tile_w + pad)
        y = pad + row * (tile_h + pad + 22)
        scaled = tile.resize((tile_w, round(tile.height * tile_w / tile.width)), Image.LANCZOS)
        if scaled.height > tile_h:
            scaled = tile.resize((round(tile.width * tile_h / tile.height), tile_h), Image.LANCZOS)
        sheet.paste(scaled, (x + (tile_w - scaled.width) // 2, y + tile_h - scaled.height), scaled)
        ImageDraw.Draw(sheet).text((x + tile_w / 2, y + tile_h + 4), labels[index], font=font, fill=(206, 214, 232), anchor="ma")
    return sheet


def gif_bytes(frames: list[Image.Image], duration_ms: int) -> bytes:
    palette = frames[0].quantize(colors=GIF_COLORS, method=Image.MEDIANCUT)
    quantized = [frame.quantize(palette=palette, dither=Image.NONE) for frame in frames]
    buffer = io.BytesIO()
    quantized[0].save(
        buffer,
        format="GIF",
        save_all=True,
        append_images=quantized[1:],
        duration=duration_ms,
        loop=0,
        optimize=True,
        disposal=2,
    )
    return buffer.getvalue()


def build(font_path: str | None) -> tuple[dict[str, bytes], dict]:
    manifest = load_manifest()
    path, cjk = resolve_font(font_path)
    font = make_font(path, 17)
    small = make_font(path, 14)
    outputs = {
        "hero.gif": gif_bytes(hero_frames(manifest, font), 83),
        "drag.gif": gif_bytes(drag_frames(manifest, font), 80),
    }
    buffer = io.BytesIO()
    moods_image(manifest, small, cjk).save(buffer, "PNG", optimize=True)
    outputs["moods.png"] = buffer.getvalue()
    index = {
        "generator": "tools/build_media.py",
        "font": path,
        "cjk": cjk,
        "files": {name: {"sha256": sha256_bytes(data), "bytes": len(data)} for name, data in outputs.items()},
    }
    return outputs, index


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the README media for the DSH Copilot pet.")
    parser.add_argument("--font", default=None, help="显式指定渲染中文用的字体文件")
    parser.add_argument("--check", action="store_true", help="与磁盘上的图比对，漂移则退出码 1")
    args = parser.parse_args()

    outputs, index = build(args.font)
    if args.check:
        drift = []
        for name, data in outputs.items():
            path = MEDIA_DIR / name
            if not path.exists() or path.read_bytes() != data:
                drift.append(name)
        if drift:
            print(f"media drift: {', '.join(drift)}")
            print(f"  font: {index['font']} (cjk={index['cjk']})")
            print("  → 重新生成：python tools/build_media.py（若字体不同，图像可能有意不同）")
            return 1
        print(f"media: no drift (font {index['font']}, cjk={index['cjk']})")
        return 0

    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    for name, data in outputs.items():
        (MEDIA_DIR / name).write_bytes(data)
        print(f"wrote docs/media/{name}  {len(data) / 1024:.0f} KB")
    MEDIA_INDEX.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"font: {index['font']} (cjk={index['cjk']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
