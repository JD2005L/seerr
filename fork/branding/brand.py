"""Levac TV branding for the Seerr fork (see fork/README.md, "Levac TV branding").

Usage: python -I brand.py <seerr public dir (read)> <font woff2> <out dir>

Writes replacements for every Seerr-logo asset into <out dir>, mirroring the
public/ layout, plus preview PNGs under <out dir>/_preview. Reads the images in
public/ only to copy their size, background and logo position, so it can be
re-run on its own output (or on new upstream sizes); then copy <out dir> over
public/, leaving _preview out.

Setup (2026-11-10 used Python 3.13):
  python -m venv venv && venv/bin/pip install pillow fonttools brotli uharfbuzz skia-pathops
  curl -fLo inter-bold.woff2 \
    https://cdn.jsdelivr.net/npm/@fontsource/inter@5.0.8/files/inter-latin-700-normal.woff2
Inter is SIL Open Font License; the logos carry its outlines, not the font.
"""
import io
import os
import sys

import uharfbuzz as hb
from fontTools.pens.basePen import BasePen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageChops, ImageDraw

PUBLIC, FONT, OUT = sys.argv[1:4]
ACCENT = "#4FC3F7"      # Levac TV accent (house)
DARK = "#0B0D10"        # Levac TV icon background
TEXT = "#F9FAFB"        # Seerr gray-50, the colour of its own wordmark
WORD = "Levac TV"
SS = 4                  # supersampling for rasters

# The Levac TV mark, from LevacTV app/src/main/res/drawable/ic_launcher.xml (108 viewport),
# moved so its bounding box starts at 0,0: 72 wide, 68 tall.
HOUSE = [(54, 20), (90, 52), (80, 52), (80, 88), (28, 88), (28, 52), (18, 52)]
PLAY = [(47, 58), (47, 80), (65, 69)]
HOUSE = [(x - 18, y - 20) for x, y in HOUSE]
PLAY = [(x - 18, y - 20) for x, y in PLAY]
MW, MH = 72.0, 68.0
WALL_TOP = 52 - 20        # where the house's walls start under the roof


def num(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s == "-0" else s


# ---------- font ----------
tt = TTFont(FONT)
tt.flavor = None
# Inter keeps overlapping outlines (its 'e' crossbar runs into the stem); merge them so the
# logo paths have no self-overlaps under any fill rule.
from fontTools.ttLib.removeOverlaps import removeOverlaps  # noqa: E402
removeOverlaps(tt, [tt.getBestCmap()[ord(c)] for c in set(WORD) if c != " "])
buf = io.BytesIO()
tt.save(buf)
tt = TTFont(io.BytesIO(buf.getvalue()))
UPM = tt["head"].unitsPerEm
CAP = tt["OS/2"].sCapHeight
GS = tt.getGlyphSet()
ORDER = tt.getGlyphOrder()

hbfont = hb.Font(hb.Face(buf.getvalue()))
hbbuf = hb.Buffer()
hbbuf.add_str(WORD)
hbbuf.guess_segment_properties()
hb.shape(hbfont, hbbuf, {"kern": True, "liga": True})
GLYPHS = [(ORDER[i.codepoint], p.x_offset, p.x_advance) for i, p in zip(hbbuf.glyph_infos, hbbuf.glyph_positions)]
WORD_UNITS = sum(a for _, _, a in GLYPHS)
# Ink extent of the first and last glyph, so the word sits flush where its letters start/end.
LSB = tt["hmtx"][GLYPHS[0][0]][1]
last_name = GLYPHS[-1][0]
last_glyf = tt["glyf"][last_name]
last_glyf.recalcBounds(tt["glyf"])
RSB = tt["hmtx"][last_name][0] - last_glyf.xMax


def word_width(cap_px: float) -> float:
    s = cap_px / CAP
    return (WORD_UNITS - LSB - RSB) * s


def word_svg(x: float, baseline: float, cap_px: float) -> str:
    s = cap_px / CAP
    pen = SVGPathPen(GS, ntos=num)
    pos = -LSB
    for name, xoff, adv in GLYPHS:
        GS[name].draw(TransformPen(pen, (s, 0, 0, -s, x + (pos + xoff) * s, baseline)))
        pos += adv
    return pen.getCommands()


class FlatPen(BasePen):
    """Glyph outlines as flattened polygons (for raster previews)."""

    def __init__(self, gs, tf):
        super().__init__(gs)
        self.tf, self.polys, self.cur = tf, [], []

    def _pt(self, p):
        a, b, c, d, e, f = self.tf
        return (a * p[0] + c * p[1] + e, b * p[0] + d * p[1] + f)

    def _moveTo(self, p):
        self.cur = [self._pt(p)]

    def _lineTo(self, p):
        self.cur.append(self._pt(p))

    def _curveToOne(self, p1, p2, p3):
        p0 = self._getCurrentPoint()
        for i in range(1, 13):
            t = i / 12
            mt = 1 - t
            x = mt**3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t**3 * p3[0]
            y = mt**3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t**3 * p3[1]
            self.cur.append(self._pt((x, y)))

    def _qCurveToOne(self, p1, p2):
        p0 = self._getCurrentPoint()
        for i in range(1, 9):
            t = i / 8
            mt = 1 - t
            x = mt * mt * p0[0] + 2 * mt * t * p1[0] + t * t * p2[0]
            y = mt * mt * p0[1] + 2 * mt * t * p1[1] + t * t * p2[1]
            self.cur.append(self._pt((x, y)))

    def _closePath(self):
        if len(self.cur) > 2:
            self.polys.append(self.cur)
        self.cur = []

    _endPath = _closePath


def word_polys(x: float, baseline: float, cap_px: float):
    s = cap_px / CAP
    out, pos = [], -LSB
    for name, xoff, adv in GLYPHS:
        pen = FlatPen(GS, (s, 0, 0, -s, x + (pos + xoff) * s, baseline))
        GS[name].draw(pen)
        out.append(pen.polys)
        pos += adv
    return out  # one list of contours per glyph


# ---------- mark ----------
def mark_path(x: float, y: float, h: float) -> str:
    s = h / MH
    def sub(pts):
        return "M" + " L".join(f"{num(x + px * s)} {num(y + py * s)}" for px, py in pts) + " Z"
    return sub(HOUSE) + " " + sub(PLAY)


def mark_polys(x: float, y: float, h: float):
    s = h / MH
    return [[(x + px * s, y + py * s) for px, py in pts] for pts in (HOUSE, PLAY)]


def evenodd_mask(size, contour_groups, ss=SS):
    """L mask of contours filled even-odd (each group XORed; groups OR-ed together)."""
    W, H = size[0] * ss, size[1] * ss
    total = Image.new("L", (W, H), 0)
    for group in contour_groups:
        acc = Image.new("1", (W, H), 0)
        for poly in group:
            layer = Image.new("1", (W, H), 0)
            ImageDraw.Draw(layer).polygon([(px * ss, py * ss) for px, py in poly], fill=1)
            acc = ImageChops.logical_xor(acc, layer)
        total = ImageChops.lighter(total, acc.convert("L"))
    return total.resize(size, Image.LANCZOS)


def glyph_mask(size, glyphs, ss=SS):
    """Text mask with the font's own winding: contours turning like the glyph's largest one
    add ink, the others cut holes (even-odd breaks on overlapping outlines, e.g. Inter's 'e')."""
    W, H = size[0] * ss, size[1] * ss
    m = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(m)

    def area(p):
        return sum(p[i][0] * p[i - 1][1] - p[i - 1][0] * p[i][1] for i in range(len(p))) / 2

    for contours in glyphs:
        if not contours:
            continue
        sign = 1 if area(max(contours, key=lambda c: abs(area(c)))) > 0 else -1
        scaled = [([(x * ss, y * ss) for x, y in c], area(c) * sign > 0) for c in contours]
        for pts, outer in scaled:
            if outer:
                d.polygon(pts, fill=255)
        for pts, outer in scaled:
            if not outer:
                d.polygon(pts, fill=0)
    return m.resize(size, Image.LANCZOS)


def mark_mask(size, box):
    """Mask of the mark fitted (aspect kept) and centred in box=(x0,y0,x1,y1)."""
    x0, y0, x1, y1 = box
    h = min((x1 - x0) / MW * MH, y1 - y0)
    w = h / MH * MW
    return evenodd_mask(size, [mark_polys(x0 + (x1 - x0 - w) / 2, y0 + (y1 - y0 - h) / 2, h)])


def paint(base: Image.Image, mask: Image.Image, color) -> Image.Image:
    layer = Image.new("RGBA", base.size, color)
    out = base.convert("RGBA")
    out.paste(layer, (0, 0), mask)
    return out


def save(img: Image.Image, rel: str, **kw):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, **kw)
    print("wrote", rel, img.size)


# ---------- logos (SVG) ----------
def svg(w, h, body):
    return (f'<svg width="{num(w)}" height="{num(h)}" viewBox="0 0 {num(w)} {num(h)}" fill="none" '
            f'xmlns="http://www.w3.org/2000/svg">\n{body}\n</svg>\n')


# Full (sidebar): mark left, word right, caps exactly as tall as the house walls.
FH, PAD = 96.0, 2.0
f_mh = 84.0
f_s = f_mh / MH
f_my = (FH - f_mh) / 2
f_cap = (MH - WALL_TOP) * f_s
f_base = f_my + f_mh
f_tx = PAD + MW * f_s + 20
FW = f_tx + word_width(f_cap) + PAD
full = svg(FW, FH,
           f'<path fill-rule="evenodd" clip-rule="evenodd" d="{mark_path(PAD, f_my, f_mh)}" fill="{ACCENT}"/>\n'
           f'<path d="{word_svg(f_tx, f_base, f_cap)}" fill="{TEXT}"/>')

# Stacked (login, setup, password reset): mark above, word centred below.
s_mh, s_cap, s_gap = 100.0, 44.0, 18.0
s_ww = word_width(s_cap)
SW = max(s_ww, MW * s_mh / MH) + 2 * PAD
SH = PAD + s_mh + s_gap + s_cap + PAD
stacked = svg(SW, SH,
              f'<path fill-rule="evenodd" clip-rule="evenodd" d="{mark_path((SW - MW * s_mh / MH) / 2, PAD, s_mh)}" fill="{ACCENT}"/>\n'
              f'<path d="{word_svg((SW - s_ww) / 2, PAD + s_mh + s_gap + s_cap, s_cap)}" fill="{TEXT}"/>')

for rel, text in (("logo_full.svg", full), ("logo_stacked.svg", stacked)):
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, rel), "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    print("wrote", rel)


def logo_raster(w, h, scale, mark_xyh, word_xbc, bg=None):
    size = (round(w * scale), round(h * scale))
    base = Image.new("RGBA", size, bg or (0, 0, 0, 0))
    mx, my, mh = mark_xyh
    base = paint(base, evenodd_mask(size, [mark_polys(mx * scale, my * scale, mh * scale)]), ACCENT)
    tx, tb, tc = word_xbc
    return paint(base, glyph_mask(size, word_polys(tx * scale, tb * scale, tc * scale)), TEXT)


# logo_full.png: same artwork as the SVG, at the original 322x96 box (fitted, centred).
full_png = logo_raster(FW, FH, 1, (PAD, f_my, f_mh), (f_tx, f_base, f_cap))
fit = min(322 / full_png.width, 96 / full_png.height)
full_png = logo_raster(FW, FH, fit, (PAD, f_my, f_mh), (f_tx, f_base, f_cap))
canvas = Image.new("RGBA", (322, 96), (0, 0, 0, 0))
canvas.paste(full_png, ((322 - full_png.width) // 2, (96 - full_png.height) // 2))
save(canvas, "logo_full.png")

# ---------- icons ----------
for n in (16, 32):
    save(paint(Image.new("RGBA", (n, n), (0, 0, 0, 0)), mark_mask((n, n), (0, 0.5, n, n - 0.5)), ACCENT),
         f"favicon-{n}x{n}.png")

ico = paint(Image.new("RGBA", (256, 256), (0, 0, 0, 0)), mark_mask((256, 256), (0, 4, 256, 252)), ACCENT)
save(ico, "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])


def app_icon(n, frac, rounded):
    base = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    bg = Image.new("L", (n * SS, n * SS), 0)
    if rounded:
        ImageDraw.Draw(bg).rounded_rectangle((0, 0, n * SS - 1, n * SS - 1), radius=int(n * SS * 0.22), fill=255)
    else:
        bg.paste(255, (0, 0, n * SS, n * SS))
    base = paint(base, bg.resize((n, n), Image.LANCZOS), DARK)
    m = n * frac
    return paint(base, mark_mask((n, n), ((n - m) / 2, (n - m) / 2, (n + m) / 2, (n + m) / 2)), ACCENT)


save(app_icon(180, 0.62, False).convert("RGB"), "apple-touch-icon.png")
for n in (192, 512):
    save(app_icon(n, 0.62, True), f"android-chrome-{n}x{n}.png")
    save(app_icon(n, 0.50, False), f"android-chrome-{n}x{n}_maskable.png")


# ---------- splash screens and missing-poster art: house where the circle was ----------
def logo_box(img: Image.Image, bg, tol=40):
    rgb = img.convert("RGB")
    diff = ImageChops.difference(rgb, Image.new("RGB", rgb.size, bg)).convert("L")
    return diff.point(lambda v: 255 if v > tol else 0).getbbox()


def logo_color(img: Image.Image, box, bg):
    crop = img.convert("RGB").crop(box)
    colors = crop.getcolors(1 << 20) or []
    far = [(c, rgb) for c, rgb in colors if sum(abs(a - b) for a, b in zip(rgb, bg)) > 60]
    return max(far)[1] if far else ACCENT


def replace_logo(rel, use_accent):
    src = Image.open(os.path.join(PUBLIC, rel))
    bg = src.convert("RGB").getpixel((0, 0))
    box = logo_box(src, bg)
    if not box:
        print("no logo found, kept", rel)
        return None
    color = ACCENT if use_accent else logo_color(src, box, bg)
    out = paint(Image.new("RGB", src.size, bg), mark_mask(src.size, box), color)
    if rel.endswith(".jpg"):
        save(out.convert("RGB"), rel, quality=92)
    elif src.mode == "P":
        save(out.convert("RGB").quantize(colors=64), rel, optimize=True)
    else:
        save(out.convert(src.mode), rel, optimize=True)
    return out


for f in sorted(os.listdir(PUBLIC)):
    if f.startswith("apple-splash-") and f.endswith(".jpg"):
        replace_logo(f, True)
for f in ("seerr_poster_not_found.png", "seerr_poster_not_found_logo_center.png", "seerr_poster_not_found_logo_top.png"):
    replace_logo("images/" + f, False)

# ---------- previews ----------
pv = os.path.join(OUT, "_preview")
os.makedirs(pv, exist_ok=True)
sheet = Image.new("RGBA", (900, 560), (17, 24, 39, 255))           # Seerr gray-900
side = Image.new("RGBA", (300, 140), (31, 41, 55, 255))             # sidebar gray-800
lf = logo_raster(FW, FH, min(256 / FW, 96 / FH), (PAD, f_my, f_mh), (f_tx, f_base, f_cap))
side.alpha_composite(lf, ((300 - lf.width) // 2, (140 - lf.height) // 2))
sheet.alpha_composite(side, (20, 20))
ls = logo_raster(SW, SH, min(448 / SW, 192 / SH), ((SW - MW * s_mh / MH) / 2, PAD, s_mh),
                 ((SW - s_ww) / 2, PAD + s_mh + s_gap + s_cap, s_cap))
sheet.alpha_composite(ls, (360 + (500 - ls.width) // 2, 20))
x = 20
for rel in ("favicon-32x32.png", "apple-touch-icon.png", "android-chrome-192x192.png", "android-chrome-192x192_maskable.png"):
    im = Image.open(os.path.join(OUT, rel)).convert("RGBA")
    sheet.alpha_composite(im, (x, 300))
    x += im.width + 30
poster = Image.open(os.path.join(OUT, "images/seerr_poster_not_found_logo_top.png")).convert("RGBA").resize((140, 210))
sheet.alpha_composite(poster, (740, 300))
sheet.save(os.path.join(pv, "sheet.png"))
Image.open(os.path.join(OUT, "apple-splash-1170-2532.jpg")).resize((390, 844)).save(os.path.join(pv, "splash.png"))
print("logo_full", num(FW), "x", num(FH), "| logo_stacked", num(SW), "x", num(SH))
