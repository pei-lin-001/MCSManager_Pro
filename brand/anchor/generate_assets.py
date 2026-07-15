#!/usr/bin/env python3
"""Generate Anchor brand assets: mark, wordmark, favicon, banners."""

from __future__ import annotations

import math
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = Path(__file__).resolve().parent
OUT.mkdir(parents=True, exist_ok=True)

# Brand tokens
TEAL = (15, 118, 110)  # #0f766e
TEAL_DEEP = (13, 90, 84)
TEAL_LIGHT = (45, 212, 191)  # #2dd4bf
CHARCOAL = (11, 18, 32)  # #0b1220
CHARCOAL_SOFT = (17, 28, 48)
BRASS = (201, 162, 39)  # #c9a227
BRASS_SOFT = (212, 168, 75)
WHITE = (248, 250, 252)
INK = (15, 23, 42)
MIST = (226, 232, 240)


def lerp(a, b, t):
    return int(a + (b - a) * t)


def mix(c1, c2, t):
    return tuple(lerp(c1[i], c2[i], t) for i in range(3))


def rounded_rect(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def draw_anchor(draw: ImageDraw.ImageDraw, cx: float, cy: float, size: float, fill, ring=None, ring_w=0):
    """Geometric ship-anchor mark, size = full height of symbol."""
    # Proportions relative to size
    s = size
    # Ring (stock eye)
    ring_r = s * 0.13
    ring_cy = cy - s * 0.38
    ring_w = max(2, int(s * 0.055))
    # Shank
    shank_w = s * 0.10
    shank_top = ring_cy + ring_r * 0.55
    shank_bot = cy + s * 0.18
    # Stock (cross bar)
    stock_w = s * 0.52
    stock_h = s * 0.085
    stock_y = ring_cy + ring_r + s * 0.06
    # Crown / flukes
    fluke_spread = s * 0.42
    fluke_h = s * 0.28
    base_y = cy + s * 0.42

    # Outer ring
    bbox = [cx - ring_r, ring_cy - ring_r, cx + ring_r, ring_cy + ring_r]
    draw.ellipse(bbox, outline=fill, width=ring_w)
    # Inner fill of ring hole is transparent by design

    # Shank
    draw.rectangle(
        [cx - shank_w / 2, shank_top, cx + shank_w / 2, shank_bot],
        fill=fill,
    )

    # Stock
    draw.rounded_rectangle(
        [cx - stock_w / 2, stock_y - stock_h / 2, cx + stock_w / 2, stock_y + stock_h / 2],
        radius=max(1, int(stock_h / 2)),
        fill=fill,
    )
    # Stock end caps (slightly thicker balls)
    cap_r = stock_h * 0.72
    for sx in (cx - stock_w / 2, cx + stock_w / 2):
        draw.ellipse([sx - cap_r, stock_y - cap_r, sx + cap_r, stock_y + cap_r], fill=fill)

    # Crown ball
    crown_r = shank_w * 0.85
    draw.ellipse(
        [cx - crown_r, shank_bot - crown_r * 0.3, cx + crown_r, shank_bot + crown_r * 1.5],
        fill=fill,
    )

    # Flukes as curved triangles (polygon approximations)
    # Left fluke
    left = [
        (cx - shank_w * 0.2, shank_bot + crown_r * 0.4),
        (cx - fluke_spread, base_y),
        (cx - fluke_spread + s * 0.12, base_y - fluke_h * 0.55),
        (cx - shank_w * 0.15, shank_bot + s * 0.08),
    ]
    right = [
        (cx + shank_w * 0.2, shank_bot + crown_r * 0.4),
        (cx + fluke_spread, base_y),
        (cx + fluke_spread - s * 0.12, base_y - fluke_h * 0.55),
        (cx + shank_w * 0.15, shank_bot + s * 0.08),
    ]
    draw.polygon(left, fill=fill)
    draw.polygon(right, fill=fill)

    # Fluke tips (diamond-ish)
    tip = s * 0.07
    for side in (-1, 1):
        tx = cx + side * fluke_spread
        ty = base_y
        tip_poly = [
            (tx, ty + tip * 0.2),
            (tx + side * tip * 1.4, ty - tip * 0.9),
            (tx, ty - tip * 2.1),
            (tx - side * tip * 0.5, ty - tip * 0.6),
        ]
        draw.polygon(tip_poly, fill=fill)

    # Arc connecting flukes under crown (visual weight)
    arc_box = [
        cx - fluke_spread * 0.92,
        shank_bot - s * 0.02,
        cx + fluke_spread * 0.92,
        base_y + s * 0.02,
    ]
    draw.arc(arc_box, start=20, end=160, fill=fill, width=max(2, int(s * 0.07)))


def make_app_icon(size: int, bg="dark", pad_ratio=0.18) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    margin = int(size * 0.06)
    radius = int(size * 0.22)

    if bg == "dark":
        # Gradient-ish rounded square via layers
        base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        bd = ImageDraw.Draw(base)
        rounded_rect(bd, [margin, margin, size - margin - 1, size - margin - 1], radius, fill=CHARCOAL + (255,))
        # subtle teal glow disc
        glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        g = int(size * 0.55)
        gd.ellipse([size // 2 - g, size // 2 - g // 3, size // 2 + g, size // 2 + g], fill=TEAL + (40,))
        glow = glow.filter(ImageFilter.GaussianBlur(radius=size * 0.08))
        img = Image.alpha_composite(base, glow)
        draw = ImageDraw.Draw(img)
        fill = TEAL_LIGHT
        # inner border
        rounded_rect(
            draw,
            [margin + 1, margin + 1, size - margin - 2, size - margin - 2],
            radius - 1,
            outline=mix(TEAL, WHITE, 0.15) + (90,),
            width=max(1, size // 128),
        )
    elif bg == "teal":
        rounded_rect(draw, [margin, margin, size - margin - 1, size - margin - 1], radius, fill=TEAL + (255,))
        # highlight
        hi = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        hd = ImageDraw.Draw(hi)
        hd.ellipse(
            [-size * 0.1, -size * 0.2, size * 0.9, size * 0.55],
            fill=(255, 255, 255, 28),
        )
        hi = hi.filter(ImageFilter.GaussianBlur(radius=size * 0.05))
        img = Image.alpha_composite(img, hi)
        draw = ImageDraw.Draw(img)
        fill = WHITE
    elif bg == "light":
        rounded_rect(draw, [margin, margin, size - margin - 1, size - margin - 1], radius, fill=WHITE + (255,))
        rounded_rect(
            draw,
            [margin, margin, size - margin - 1, size - margin - 1],
            radius,
            outline=MIST + (255,),
            width=max(1, size // 64),
        )
        fill = TEAL
    else:  # transparent
        fill = TEAL_LIGHT if bg == "transparent-light" else TEAL

    symbol = size * (1 - pad_ratio * 2)
    draw_anchor(draw, size / 2, size / 2 + size * 0.02, symbol, fill)
    return img


def load_font(size: int, bold=True) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf" if bold else "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            return ImageFont.truetype(p, size=size)
    return ImageFont.load_default()


def make_wordmark(height: int = 256, dark=True) -> Image.Image:
    """Horizontal logo: mark + ANCHOR wordmark."""
    mark_size = height
    mark = make_app_icon(mark_size, bg="teal" if not dark else "dark")

    font = load_font(int(height * 0.42), bold=True)
    sub_font = load_font(int(height * 0.14), bold=False)

    text = "ANCHOR"
    sub = "Server Console"
    # measure
    tmp = Image.new("RGBA", (10, 10))
    td = ImageDraw.Draw(tmp)
    bbox = td.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    sb = td.textbbox((0, 0), sub, font=sub_font)
    sw = sb[2] - sb[0]

    gap = int(height * 0.18)
    pad_x = int(height * 0.12)
    width = mark_size + gap + max(tw, sw) + pad_x * 2
    img = Image.new("RGBA", (width, height), (0, 0, 0, 0) if True else CHARCOAL + (255,))
    # optional solid bg strip for export variants handled by caller

    img.paste(mark, (pad_x // 2, 0), mark)
    draw = ImageDraw.Draw(img)
    text_color = WHITE if dark else INK
    sub_color = mix(TEAL_LIGHT, WHITE, 0.35) if dark else TEAL

    tx = pad_x // 2 + mark_size + gap
    ty = int(height * 0.22)
    draw.text((tx, ty), text, font=font, fill=text_color + (255,))
    draw.text((tx, ty + th + int(height * 0.06)), sub, font=sub_font, fill=sub_color + (255,))
    return img


def make_wordmark_on_bg(height: int, dark=True) -> Image.Image:
    logo = make_wordmark(height=height, dark=dark)
    pad = int(height * 0.2)
    bg_color = CHARCOAL if dark else WHITE
    canvas = Image.new("RGBA", (logo.width + pad * 2, logo.height + pad * 2), bg_color + (255,))
    canvas.paste(logo, (pad, pad), logo)
    return canvas


def make_banner(width=1920, height=1080) -> Image.Image:
    """Hero / OG style background with large soft anchor watermark."""
    img = Image.new("RGBA", (width, height), CHARCOAL + (255,))
    # vertical gradient layers
    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    for y in range(height):
        t = y / height
        c = mix(CHARCOAL, TEAL_DEEP, 0.15 + 0.35 * t)
        od.line([(0, y), (width, y)], fill=c + (255,))
    img = Image.alpha_composite(img, overlay)

    # soft teal orbs
    for cx, cy, r, a in [
        (int(width * 0.15), int(height * 0.2), int(width * 0.25), 50),
        (int(width * 0.85), int(height * 0.75), int(width * 0.3), 40),
        (int(width * 0.7), int(height * 0.15), int(width * 0.18), 35),
    ]:
        orb = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        ImageDraw.Draw(orb).ellipse([cx - r, cy - r, cx + r, cy + r], fill=TEAL + (a,))
        orb = orb.filter(ImageFilter.GaussianBlur(radius=r * 0.45))
        img = Image.alpha_composite(img, orb)

    # large watermark anchor
    wm = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    wd = ImageDraw.Draw(wm)
    draw_anchor(wd, width * 0.72, height * 0.52, height * 0.72, TEAL_LIGHT + (28,))
    img = Image.alpha_composite(img, wm)

    # foreground logo
    logo = make_wordmark(height=int(height * 0.16), dark=True)
    lx = int(width * 0.08)
    ly = int(height * 0.38)
    img.paste(logo, (lx, ly), logo)

    draw = ImageDraw.Draw(img)
    tag_font = load_font(int(height * 0.035), bold=False)
    tag = "A quiet harbor for your worlds."
    draw.text((lx + int(height * 0.02), ly + logo.height + int(height * 0.03)), tag, font=tag_font, fill=MIST + (200,))

    # thin brass accent line
    yline = ly + logo.height + int(height * 0.09)
    draw.rectangle([lx, yline, lx + int(width * 0.12), yline + 3], fill=BRASS + (220,))

    return img


def make_login_bg(width=1600, height=900) -> Image.Image:
    img = Image.new("RGBA", (width, height), CHARCOAL + (255,))
    # diagonal soft gradient
    for y in range(height):
        for x in range(0, width, 4):
            t = (x / width * 0.5 + y / height * 0.5)
            # skip dense loop — use lines
        pass
    od = ImageDraw.Draw(img)
    for y in range(height):
        t = y / height
        c = mix(CHARCOAL, mix(TEAL_DEEP, CHARCOAL_SOFT, 0.5), t * 0.55)
        od.line([(0, y), (width, y)], fill=c + (255,))

    # mesh dots
    dots = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dots)
    step = 28
    for y in range(0, height, step):
        for x in range(0, width, step):
            if (x + y) % (step * 2) == 0:
                dd.ellipse([x, y, x + 2, y + 2], fill=TEAL_LIGHT + (28,))
    img = Image.alpha_composite(img, dots)

    # large faint anchor
    wm = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw_anchor(ImageDraw.Draw(wm), width * 0.78, height * 0.5, height * 0.85, TEAL + (22,))
    img = Image.alpha_composite(img, wm)

    # vignette
    vig = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    vd = ImageDraw.Draw(vig)
    vd.rectangle([0, 0, width, height], fill=(0, 0, 0, 40))
    # keep center clearer via erase ellipse — approximate with soft white subtract not available; skip

    return img


def make_og_card(width=1200, height=630) -> Image.Image:
    img = make_banner(width, height)
    return img


def write_svg_mark(path: Path):
    """Pure SVG mark for scalable use."""
    svg = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <defs>
    <linearGradient id="bg" x1="20" y1="8" x2="108" y2="120" gradientUnits="userSpaceOnUse">
      <stop stop-color="#111c30"/>
      <stop offset="1" stop-color="#0b1220"/>
    </linearGradient>
  </defs>
  <rect x="6" y="6" width="116" height="116" rx="28" fill="url(#bg)"/>
  <rect x="6.5" y="6.5" width="115" height="115" rx="27.5" stroke="#2dd4bf" stroke-opacity="0.18"/>
  <!-- ring -->
  <circle cx="64" cy="34" r="10" stroke="#2dd4bf" stroke-width="6"/>
  <!-- stock -->
  <rect x="34" y="46" width="60" height="10" rx="5" fill="#2dd4bf"/>
  <circle cx="34" cy="51" r="6" fill="#2dd4bf"/>
  <circle cx="94" cy="51" r="6" fill="#2dd4bf"/>
  <!-- shank -->
  <rect x="58" y="42" width="12" height="46" rx="2" fill="#2dd4bf"/>
  <!-- crown -->
  <circle cx="64" cy="90" r="8" fill="#2dd4bf"/>
  <!-- flukes -->
  <path d="M58 88 C40 96 30 110 26 118 L42 108 C48 100 54 96 58 94 Z" fill="#2dd4bf"/>
  <path d="M70 88 C88 96 98 110 102 118 L86 108 C80 100 74 96 70 94 Z" fill="#2dd4bf"/>
  <path d="M30 108 C48 122 80 122 98 108" stroke="#2dd4bf" stroke-width="8" stroke-linecap="round" fill="none"/>
</svg>
"""
    path.write_text(svg, encoding="utf-8")


def write_svg_wordmark(path: Path):
    svg = """<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 96" fill="none">
  <defs>
    <linearGradient id="bg" x1="8" y1="4" x2="88" y2="92" gradientUnits="userSpaceOnUse">
      <stop stop-color="#0f766e"/>
      <stop offset="1" stop-color="#0d5a54"/>
    </linearGradient>
  </defs>
  <rect x="4" y="4" width="88" height="88" rx="22" fill="url(#bg)"/>
  <circle cx="48" cy="28" r="7" stroke="#f8fafc" stroke-width="4.5"/>
  <rect x="26" y="36" width="44" height="7" rx="3.5" fill="#f8fafc"/>
  <circle cx="26" cy="39.5" r="4.5" fill="#f8fafc"/>
  <circle cx="70" cy="39.5" r="4.5" fill="#f8fafc"/>
  <rect x="43.5" y="32" width="9" height="34" rx="1.5" fill="#f8fafc"/>
  <circle cx="48" cy="68" r="6" fill="#f8fafc"/>
  <path d="M43 66 C30 72 23 82 20 88 L32 80 C36 74 40 71 43 70 Z" fill="#f8fafc"/>
  <path d="M53 66 C66 72 73 82 76 88 L64 80 C60 74 56 71 53 70 Z" fill="#f8fafc"/>
  <path d="M22 80 C36 90 60 90 74 80" stroke="#f8fafc" stroke-width="5.5" stroke-linecap="round" fill="none"/>
  <text x="112" y="52" fill="#f8fafc" font-family="DejaVu Sans, Arial, sans-serif" font-size="36" font-weight="700" letter-spacing="1.5">ANCHOR</text>
  <text x="114" y="76" fill="#2dd4bf" font-family="DejaVu Sans, Arial, sans-serif" font-size="14" font-weight="400" letter-spacing="2">SERVER CONSOLE</text>
</svg>
"""
    path.write_text(svg, encoding="utf-8")


def save(img: Image.Image, name: str):
    path = OUT / name
    if name.endswith(".jpg") or name.endswith(".jpeg"):
        rgb = Image.new("RGB", img.size, CHARCOAL)
        rgb.paste(img, mask=img.split()[-1] if img.mode == "RGBA" else None)
        rgb.save(path, quality=92, optimize=True)
    else:
        img.save(path, optimize=True)
    print(f"wrote {path} ({img.size[0]}x{img.size[1]})")


def main():
    # App icons
    for size in (512, 256, 128, 64, 32):
        save(make_app_icon(size, "dark"), f"icon-dark-{size}.png")
        save(make_app_icon(size, "teal"), f"icon-teal-{size}.png")
        save(make_app_icon(size, "light"), f"icon-light-{size}.png")

    # Transparent mark (for overlays)
    save(make_app_icon(512, "transparent"), "mark-transparent-512.png")

    # Favicon multi
    fav = make_app_icon(64, "teal")
    save(fav, "favicon-64.png")
    save(make_app_icon(32, "teal"), "favicon-32.png")
    # ICO
    ico_sizes = [(16, 16), (32, 32), (48, 48)]
    icos = [make_app_icon(s[0], "teal") for s in ico_sizes]
    icos[0].save(OUT / "favicon.ico", format="ICO", sizes=ico_sizes, append_images=icos[1:])
    print(f"wrote {OUT / 'favicon.ico'}")

    # Wordmarks
    save(make_wordmark(256, dark=True), "wordmark-dark-transparent.png")
    save(make_wordmark(256, dark=False), "wordmark-light-transparent.png")
    save(make_wordmark_on_bg(256, dark=True), "wordmark-dark-solid.png")
    save(make_wordmark_on_bg(256, dark=False), "wordmark-light-solid.png")

    # Banners
    save(make_banner(1920, 1080), "hero-1920x1080.png")
    save(make_og_card(1200, 630), "og-1200x630.png")
    save(make_login_bg(1600, 900), "login-bg-1600x900.png")
    save(make_banner(1600, 400), "banner-1600x400.png")

    # Small header bar logo
    save(make_wordmark(96, dark=True), "header-logo-dark.png")
    save(make_wordmark(96, dark=False), "header-logo-light.png")

    # SVG sources
    write_svg_mark(OUT / "mark.svg")
    write_svg_wordmark(OUT / "wordmark.svg")
    print(f"wrote {OUT / 'mark.svg'}")
    print(f"wrote {OUT / 'wordmark.svg'}")

    # Brand tokens reference
    (OUT / "BRAND.md").write_text(
        """# Anchor brand assets

## Product
- **Name**: Anchor
- **Tagline**: A quiet harbor for your worlds.
- **Chinese tagline (optional)**: 给你的世界一个锚点。

## Colors
| Token | Hex | Use |
|-------|-----|-----|
| charcoal | `#0b1220` | app chrome, dark surfaces |
| teal | `#0f766e` | primary accent (matches existing `--sh-accent`) |
| sea-glass | `#2dd4bf` | mark on dark, highlights |
| brass | `#c9a227` | rare accent line / premium detail |
| mist | `#e2e8f0` | secondary text on dark |
| ink | `#0f172a` | text on light |

## Files
| File | Use |
|------|-----|
| `icon-teal-*.png` | app icon, PWA, default favicon source |
| `icon-dark-*.png` | dark UI mark tiles |
| `icon-light-*.png` | light UI mark tiles |
| `favicon.ico` / `favicon-32.png` | browser tab |
| `mark.svg` | scalable monochrome-ready mark |
| `wordmark*.png` / `wordmark.svg` | header, login, docs |
| `hero-1920x1080.png` | landing / splash |
| `og-1200x630.png` | Open Graph / social share |
| `login-bg-1600x900.png` | login page background |
| `banner-1600x400.png` | wide header strip |

## Usage notes
- Prefer **teal rounded mark** in navigation; dark mark on light pages.
- Do not recolor the flukes independently; keep one solid fill.
- Wordmark letterspacing is tight; keep “ANCHOR” in uppercase for lockups.
- Avoid purple gradients / neon glow — product tone is calm maritime tech.
""",
        encoding="utf-8",
    )
    print(f"wrote {OUT / 'BRAND.md'}")


if __name__ == "__main__":
    main()
