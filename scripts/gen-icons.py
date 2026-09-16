#!/usr/bin/env python3
"""Generate Raven PWA icons as PNGs, no external deps (pure stdlib).

Motif: an indigo tile with a downward "prices dropping" chart line in gold
and a bright "buy" dot at the low point. Meaningful for a price watcher and
simple to rasterize. Produces:
  icons/icon-192.png, icons/icon-512.png, icons/icon-maskable-512.png
  apple-touch-icon.png (180x180, opaque for iOS)
"""
import os
import math
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Palette
BG = (30, 27, 75)        # deep indigo
BG2 = (49, 46, 129)      # lighter indigo (subtle band)
LINE = (250, 204, 21)    # gold line
DOT = (52, 211, 153)     # green "buy" dot
FAINT = (99, 102, 241)   # faint grid/wing accent


class Canvas:
    def __init__(self, size, bg):
        self.size = size
        self.px = bytearray(bg * (size * size))

    def _set(self, x, y, rgb):
        if 0 <= x < self.size and 0 <= y < self.size:
            i = (y * self.size + x) * 3
            self.px[i:i + 3] = bytes(rgb)

    def fill_rect(self, x0, y0, x1, y1, rgb):
        for y in range(int(y0), int(y1)):
            for x in range(int(x0), int(x1)):
                self._set(x, y, rgb)

    def fill_circle(self, cx, cy, r, rgb):
        r2 = r * r
        for y in range(int(cy - r), int(cy + r + 1)):
            for x in range(int(cx - r), int(cx + r + 1)):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r2:
                    self._set(x, y, rgb)

    def thick_line(self, p0, p1, width, rgb):
        (x0, y0), (x1, y1) = p0, p1
        dist = math.hypot(x1 - x0, y1 - y0)
        steps = max(1, int(dist))
        r = width / 2
        for s in range(steps + 1):
            t = s / steps
            self.fill_circle(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, rgb)

    def png_bytes(self):
        raw = bytearray()
        stride = self.size * 3
        for y in range(self.size):
            raw.append(0)  # filter: none
            raw.extend(self.px[y * stride:(y + 1) * stride])
        compressed = zlib.compress(bytes(raw), 9)

        def chunk(tag, data):
            c = struct.pack(">I", len(data)) + tag + data
            crc = zlib.crc32(tag + data) & 0xffffffff
            return c + struct.pack(">I", crc)

        sig = b"\x89PNG\r\n\x1a\n"
        ihdr = struct.pack(">IIBBBBB", self.size, self.size, 8, 2, 0, 0, 0)
        return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")


def draw(size, maskable=False):
    c = Canvas(size, BG)
    S = size

    # For maskable icons keep the art inside the safe zone (~80% center).
    pad = 0.22 * S if maskable else 0.14 * S
    inner = S - 2 * pad

    def P(fx, fy):
        return (pad + fx * inner, pad + fy * inner)

    # subtle lighter band at bottom
    c.fill_rect(0, S * 0.72, S, S, BG2)

    # faint baseline grid
    for gy in (0.35, 0.55, 0.75):
        c.fill_rect(pad, pad + gy * inner, pad + inner, pad + gy * inner + max(1, S // 256), FAINT)

    # descending price line (top-left -> bottom-right), gold
    pts = [P(0.05, 0.22), P(0.30, 0.42), P(0.52, 0.34), P(0.74, 0.70), P(0.95, 0.86)]
    lw = max(3, S // 42)
    for a, b in zip(pts, pts[1:]):
        c.thick_line(a, b, lw, LINE)
    for p in pts:
        c.fill_circle(p[0], p[1], lw * 0.7, LINE)

    # bright "buy" dot at the low point
    low = pts[-1]
    c.fill_circle(low[0], low[1], lw * 1.6, DOT)

    return c


def main():
    os.makedirs(os.path.join(ROOT, "icons"), exist_ok=True)
    specs = [
        (os.path.join(ROOT, "icons", "icon-192.png"), 192, False),
        (os.path.join(ROOT, "icons", "icon-512.png"), 512, False),
        (os.path.join(ROOT, "icons", "icon-maskable-512.png"), 512, True),
        (os.path.join(ROOT, "apple-touch-icon.png"), 180, False),
    ]
    for path, size, maskable in specs:
        data = draw(size, maskable).png_bytes()
        with open(path, "wb") as f:
            f.write(data)
        print(f"wrote {os.path.relpath(path, ROOT)} ({len(data)} bytes)")


if __name__ == "__main__":
    main()
