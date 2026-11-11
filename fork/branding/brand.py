"""Levac TV branding for the Seerr fork (see fork/README.md, "Levac TV branding").

Usage: python -I brand.py <seerr public dir> <Levac TV app Inter.ttf> <out dir>

- logo_stacked.svg (login, setup, password reset) and logo_full.svg (sidebar): the wordmark
  from the Levac TV app's "Who's watching?" screen (LevacTV ProfilesScreen.kt, Wordmark()),
  reproduced from its numbers: "LEVAC" Inter Black 50 with 9 letter spacing and a white to
  #B9C4DA gradient, 6 gap, then a "TV" badge (Inter Black 34, spacing 1, black at 82%) on a
  Sky accent gradient (#4FC3F7 to 72%), 12/3 padding, radius 12, with a radial glow as wide
  as the badge. Units are the app's dp/sp, so the login logo is the TV's size in CSS px.
- favicons, apple-touch-icon, android-chrome icons: the app's launcher house on its dark
  tile, drawn with depth (side, bevel, gloss, play button set in, glow and shadow under it).
- apple-splash-*.jpg: the wordmark centred on each image's own background.
- images/seerr_poster_not_found*.png: a flat muted house where the old logo was.
Reads public/ only for sizes, backgrounds and logo positions, so it can be re-run on its own
output; copy <out dir> over public/ (leave _preview out).

Setup (2026-11-10 used Python 3.13):
  python -m venv venv && venv/bin/pip install pillow fonttools uharfbuzz skia-pathops resvg-py
The font is the app's own (LevacTV app/src/main/assets/fonts/Inter.ttf, Inter 4.001 variable,
SIL Open Font License); the logos carry its outlines at weight 900, not the font.
"""
import io
import math
import os
import sys

import resvg_py
import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.removeOverlaps import removeOverlaps
from fontTools.varLib.instancer import instantiateVariableFont
from PIL import Image, ImageChops

PUBLIC, FONT, OUT = sys.argv[1:4]
ACCENT = "#4FC3F7"   # the app's default accent (Palette.accents[0], "Sky")


def num(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


# ---------------- font: the app's Inter at FontWeight.Black ----------------
tt = instantiateVariableFont(TTFont(FONT), {"wght": 900, "opsz": 14})
removeOverlaps(tt, sorted({tt.getBestCmap()[ord(c)] for c in "LEVACTV"}))
_buf = io.BytesIO()
tt.save(_buf)
tt = TTFont(io.BytesIO(_buf.getvalue()))
UPM = tt["head"].unitsPerEm
ASC, DESC = tt["hhea"].ascent, -tt["hhea"].descent
GS = tt.getGlyphSet()
ORDER = tt.getGlyphOrder()
HBF = hb.Font(hb.Face(_buf.getvalue()))


def text_run(text, x, top, size, spacing):
    """Android/Compose layout: each glyph gets `spacing` extra, half before and half after.
    Returns (svg path, box width, box height) for a text box whose top-left is x, top."""
    b = hb.Buffer()
    b.add_str(text)
    b.guess_segment_properties()
    hb.shape(HBF, b, {"kern": True})
    s = size / UPM
    pen = SVGPathPen(GS, ntos=num)
    pos = 0.0
    for info, p in zip(b.glyph_infos, b.glyph_positions):
        gx = x + pos + spacing / 2 + p.x_offset * s
        GS[ORDER[info.codepoint]].draw(TransformPen(pen, (s, 0, 0, -s, gx, top + ASC * s)))
        pos += p.x_advance * s + spacing
    return pen.getCommands(), pos, (ASC + DESC) * s


# ---------------- the wordmark ----------------
def wordmark(uid):
    levac, w1, h1 = text_run("LEVAC", 0, 0, 50, 9)
    gap = 6
    _, tvw, tvh = text_run("TV", 0, 0, 34, 1)
    bw, bh = tvw + 24, tvh + 6
    H = max(h1, bh)
    ly = (H - h1) / 2
    levac, _, _ = text_run("LEVAC", 0, ly, 50, 9)
    bx, by = w1 + gap, (H - bh) / 2
    tv, _, _ = text_run("TV", bx + 12, by + 3, 34, 1)
    cx, cy, r = bx + bw / 2, by + bh / 2, max(bw, bh)
    d = f"""<linearGradient id="lv{uid}" gradientUnits="userSpaceOnUse" x1="0" y1="{num(ly)}" x2="0" y2="{num(ly + h1)}">
<stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#B9C4DA"/></linearGradient>
<linearGradient id="bd{uid}" gradientUnits="userSpaceOnUse" x1="{num(bx)}" y1="{num(by)}" x2="{num(bx + bw)}" y2="{num(by + bh)}">
<stop offset="0" stop-color="{ACCENT}"/><stop offset="1" stop-color="{ACCENT}" stop-opacity="0.72"/></linearGradient>
<radialGradient id="gw{uid}" gradientUnits="userSpaceOnUse" cx="{num(cx)}" cy="{num(cy)}" r="{num(r)}">
<stop offset="0" stop-color="{ACCENT}" stop-opacity="0.45"/><stop offset="1" stop-color="{ACCENT}" stop-opacity="0"/></radialGradient>"""
    body = (f'<circle cx="{num(cx)}" cy="{num(cy)}" r="{num(r)}" fill="url(#gw{uid})"/>\n'
            f'<path d="{levac}" fill="url(#lv{uid})"/>\n'
            f'<rect x="{num(bx)}" y="{num(by)}" width="{num(bw)}" height="{num(bh)}" rx="12" fill="url(#bd{uid})"/>\n'
            f'<path d="{tv}" fill="#000000" fill-opacity="0.82"/>')
    return d, body, bx + bw, H


def wordmark_svg(uid, box_w, box_h, art_w):
    """The wordmark centred in a viewBox with the container's aspect, drawn art_w px wide."""
    d, body, W, H = wordmark(uid)
    su = W / art_w
    vw, vh = box_w * su, box_h * su
    ox, oy = (vw - W) / 2, (vh - H) / 2
    return (f'<svg width="{num(vw)}" height="{num(vh)}" viewBox="0 0 {num(vw)} {num(vh)}" fill="none" '
            f'xmlns="http://www.w3.org/2000/svg">\n<defs>\n{d}\n</defs>\n'
            f'<g transform="translate({num(ox)} {num(oy)})">\n{body}\n</g>\n</svg>\n')


# ---------------- the house (launcher icon geometry, normalised to 72 x 68) ----------------
HOUSE = [(36, 0), (72, 32), (62, 32), (62, 68), (10, 68), (10, 32), (0, 32)]
PLAY = [(29, 38), (29, 60), (47, 49)]


def rounded(pts, r):
    n = len(pts)
    corners = []
    for i in range(n):
        p0, p1, p2 = pts[i - 1], pts[i], pts[(i + 1) % n]
        def toward(a, b):
            dx, dy = b[0] - a[0], b[1] - a[1]
            L = math.hypot(dx, dy)
            t = min(r, L / 2)
            return (a[0] + dx / L * t, a[1] + dy / L * t)
        corners.append((toward(p1, p0), p1, toward(p1, p2)))
    d = f"M{num(corners[0][2][0])} {num(corners[0][2][1])}"
    for i in range(1, n + 1):
        a, c, b = corners[i % n]
        d += f" L{num(a[0])} {num(a[1])} Q{num(c[0])} {num(c[1])} {num(b[0])} {num(b[1])}"
    return d + " Z"


def house_paths(cx, top, width):
    s = width / 72
    x0 = cx - width / 2
    h = [(x0 + x * s, top + y * s) for x, y in HOUSE]
    gx = sum(p[0] for p in PLAY) / 3
    gy = sum(p[1] for p in PLAY) / 3
    pl = [(x0 + (gx + (x - gx) * 1.12 + 0.8) * s, top + (gy + (y - gy) * 1.12) * s) for x, y in PLAY]
    return rounded(h, 3.6 * s), rounded(pl, 2.4 * s)


def tile_defs(uid, k):
    return f"""<linearGradient id="tg{uid}" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#2A3546"/><stop offset="0.55" stop-color="#121821"/><stop offset="1" stop-color="#07090C"/></linearGradient>
<linearGradient id="tb{uid}" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#FFFFFF" stop-opacity="0.28"/><stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0.04"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>
<linearGradient id="hf{uid}" x1="0.2" y1="0" x2="0.6" y2="1">
<stop offset="0" stop-color="#D2F6FF"/><stop offset="0.32" stop-color="#6AD2FB"/><stop offset="0.7" stop-color="#2E9DF0"/><stop offset="1" stop-color="#1A73D1"/></linearGradient>
<linearGradient id="hs{uid}" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#1E6FBF"/><stop offset="1" stop-color="#0B3F73"/></linearGradient>
<radialGradient id="gl{uid}" cx="0.32" cy="0.18" r="0.55">
<stop offset="0" stop-color="#FFFFFF" stop-opacity="0.55"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>
<filter id="cs{uid}" x="-30%" y="-30%" width="160%" height="170%"><feGaussianBlur stdDeviation="{num(3.5 * k)}"/></filter>
<filter id="gw{uid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="{num(9 * k)}"/></filter>"""


def tile3d(uid, x, y, size, house_frac=0.64, radius=0.23):
    """The app tile with the house standing off it."""
    k = size / 100
    house, play = house_paths(x + size / 2, y + size * (0.15 + (0.64 - house_frac) * 0.5), house_frac * 100 * k)
    hid, pid = f"H{uid}", f"P{uid}"
    p = [f'<rect x="{num(x)}" y="{num(y)}" width="{num(size)}" height="{num(size)}" rx="{num(radius * 100 * k)}" fill="url(#tg{uid})"/>']
    if radius > 0:
        p.append(f'<rect x="{num(x + 0.75 * k)}" y="{num(y + 0.75 * k)}" width="{num(size - 1.5 * k)}" height="{num(size - 1.5 * k)}" '
                 f'rx="{num((radius * 100 - 0.7) * k)}" stroke="url(#tb{uid})" stroke-width="{num(1.5 * k)}"/>')
    p += [f'<clipPath id="{hid}"><path d="{house}"/></clipPath>',
          f'<clipPath id="{pid}"><path d="{play}"/></clipPath>',
          f'<path d="{house}" fill="#2EA6FF" fill-opacity="0.45" transform="translate(0 {num(5 * k)})" filter="url(#gw{uid})"/>',
          f'<path d="{house}" fill="#000" fill-opacity="0.9" transform="translate(0 {num(6.5 * k)})" filter="url(#cs{uid})"/>']
    for i in range(8, 0, -1):
        p.append(f'<path d="{house}" fill="url(#hs{uid})" transform="translate(0 {num(3.6 * k * i / 8)})"/>')
    p += [f'<path d="{house}" fill="url(#hf{uid})"/>',
          f'<g clip-path="url(#{hid})">',
          f'<path d="{house}" stroke="#FFFFFF" stroke-opacity="0.75" stroke-width="{num(2.6 * k)}" transform="translate(0 {num(1.5 * k)})"/>',
          f'<path d="{house}" stroke="#0A3A6B" stroke-opacity="0.55" stroke-width="{num(2.6 * k)}" transform="translate(0 {num(-1.5 * k)})"/>',
          f'<rect x="{num(x)}" y="{num(y)}" width="{num(size)}" height="{num(size * 0.6)}" fill="url(#gl{uid})"/>',
          "</g>",
          f'<path d="{play}" fill="#0A1626"/>',
          f'<g clip-path="url(#{pid})">',
          f'<path d="{play}" stroke="#000" stroke-opacity="0.85" stroke-width="{num(2.4 * k)}" transform="translate(0 {num(1.3 * k)})"/>',
          f'<path d="{play}" stroke="#8FDCFF" stroke-opacity="0.55" stroke-width="{num(1.6 * k)}" transform="translate(0 {num(-1.1 * k)})"/>',
          "</g>"]
    return "\n".join(p)


def tile_svg(n, house_frac=0.64, radius=0.23, margin=0.0):
    size = 100 * (1 - 2 * margin)
    o = 100 * margin
    return (f'<svg width="{n}" height="{n}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">\n'
            f'<defs>\n{tile_defs("i", size / 100)}\n</defs>\n{tile3d("i", o, o, size, house_frac, radius)}\n</svg>\n')


# ---------------- output helpers ----------------
def write_text(rel, text):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path) or OUT, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    print("wrote", rel)


def render(svg, w, h):
    return Image.open(io.BytesIO(bytes(resvg_py.svg_to_bytes(svg_string=svg, width=w, height=h)))).convert("RGBA")


def save(img, rel, **kw):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path) or OUT, exist_ok=True)
    img.save(path, **kw)
    print("wrote", rel, img.size)


os.makedirs(OUT, exist_ok=True)

# logos
write_text("logo_stacked.svg", wordmark_svg("s", 448, 192, wordmark("m")[2]))   # TV size, 1 dp = 1 px
write_text("logo_full.svg", wordmark_svg("f", 256, 96, 212))
save(render(wordmark_svg("p", 322, 96, 215), 322, 96), "logo_full.png")

# icons: rounded tile on transparent; full-bleed square where the platform rounds it itself
for n in (16, 32):
    big = render(tile_svg(256, radius=0.22), 256, 256)
    save(big.resize((n, n), Image.LANCZOS), f"favicon-{n}x{n}.png")
save(render(tile_svg(256, radius=0.22), 256, 256), "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
save(render(tile_svg(180, radius=0), 180, 180).convert("RGB"), "apple-touch-icon.png")
for n in (192, 512):
    save(render(tile_svg(n, radius=0.22), n, n), f"android-chrome-{n}x{n}.png")
    save(render(tile_svg(n, house_frac=0.5, radius=0), n, n), f"android-chrome-{n}x{n}_maskable.png")


# splash screens: wordmark centred on the image's own background
def bg_of(img):
    return img.convert("RGB").getpixel((2, 2))


for f in sorted(os.listdir(PUBLIC)):
    if not (f.startswith("apple-splash-") and f.endswith(".jpg")):
        continue
    src = Image.open(os.path.join(PUBLIC, f))
    w, h = src.size
    r, g, b = bg_of(src)
    art = min(w, h) * 0.56
    svg = wordmark_svg("sp", w, h, art).replace('fill="none" xmlns', f'fill="none" style="background:rgb({r},{g},{b})" xmlns')
    out = Image.new("RGBA", (w, h), (r, g, b, 255))
    out.alpha_composite(render(svg, w, h))
    save(out.convert("RGB"), f, quality=92)


# missing-poster images: flat muted house where the old logo sat
def logo_box(img, bg, tol=40):
    rgb = img.convert("RGB")
    diff = ImageChops.difference(rgb, Image.new("RGB", rgb.size, bg)).convert("L")
    return diff.point(lambda v: 255 if v > tol else 0).getbbox()


for f in ("seerr_poster_not_found.png", "seerr_poster_not_found_logo_center.png", "seerr_poster_not_found_logo_top.png"):
    rel = "images/" + f
    src = Image.open(os.path.join(PUBLIC, rel))
    w, h = src.size
    bg = bg_of(src)
    box = logo_box(src, bg)
    if not box:
        print("kept", rel)
        continue
    crop = src.convert("RGB").crop(box)
    colors = sorted(crop.getcolors(1 << 20) or [], reverse=True)
    far = [c for _, c in colors if sum(abs(a - b) for a, b in zip(c, bg)) > 60]
    col = "#%02X%02X%02X" % (far[0] if far else (75, 85, 99))
    x0, y0, x1, y1 = box
    hw = min(x1 - x0, (y1 - y0) / 68 * 72)
    house, play = house_paths((x0 + x1) / 2, (y0 + y1) / 2 - hw / 72 * 34, hw)
    svg = (f'<svg width="{w}" height="{h}" viewBox="0 0 {w} {h}" xmlns="http://www.w3.org/2000/svg">'
           f'<rect width="{w}" height="{h}" fill="rgb{bg}"/>'
           f'<path fill-rule="evenodd" d="{house} {play}" fill="{col}"/></svg>')
    save(render(svg, w, h).convert("RGB").quantize(colors=64), rel, optimize=True)
