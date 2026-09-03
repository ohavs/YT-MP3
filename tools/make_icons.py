#!/usr/bin/env python3
"""Generate the PWA icon set (no image libraries required).

Draws a rounded gradient tile with a white double note, supersampled 3x for
smooth edges, and writes the PNGs into web/icons/.
"""

from __future__ import annotations

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "icons"
ACCENT_A = (0xFF, 0x3D, 0x5A)
ACCENT_B = (0xFF, 0x7A, 0x45)
SS = 3  # supersampling factor


def rounded(x: float, y: float, r: float) -> bool:
    """Inside a unit rounded square with corner radius r."""
    cx = min(max(x, r), 1 - r)
    cy = min(max(y, r), 1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def ellipse(x: float, y: float, cx: float, cy: float, rx: float, ry: float, ang: float) -> bool:
    dx, dy = x - cx, y - cy
    c, s = math.cos(ang), math.sin(ang)
    u, v = dx * c + dy * s, -dx * s + dy * c
    return (u / rx) ** 2 + (v / ry) ** 2 <= 1


def note(x: float, y: float, k: float) -> bool:
    """White glyph, scaled by k about the tile centre."""
    x = 0.5 + (x - 0.5) / k
    y = 0.5 + (y - 0.5) / k

    if 0.345 <= x <= 0.400 and 0.255 <= y <= 0.700:      # left stem
        return True
    if 0.655 <= x <= 0.710 and 0.215 <= y <= 0.660:      # right stem
        return True
    if 0.345 <= x <= 0.710:                              # beam
        top = 0.255 + (x - 0.345) * (0.215 - 0.255) / 0.365
        if top <= y <= top + 0.100:
            return True
    if ellipse(x, y, 0.312, 0.700, 0.108, 0.080, -0.32):  # left head
        return True
    if ellipse(x, y, 0.622, 0.660, 0.108, 0.080, -0.32):  # right head
        return True
    return False


def png(path: Path, size: int, *, glyph: float, radius: float) -> None:
    rows = bytearray()
    inv = 1.0 / SS
    samples = SS * SS

    for py in range(size):
        rows.append(0)  # PNG filter byte: none
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    u = (px + (sx + 0.5) * inv) / size
                    v = (py + (sy + 0.5) * inv) / size
                    if not rounded(u, v, radius):
                        continue
                    a += 1.0
                    if note(u, v, glyph):
                        r += 255; g += 255; b += 255
                    else:
                        t = max(0.0, min(1.0, (u * 0.45 + v * 0.55)))
                        r += ACCENT_A[0] + (ACCENT_B[0] - ACCENT_A[0]) * t
                        g += ACCENT_A[1] + (ACCENT_B[1] - ACCENT_A[1]) * t
                        b += ACCENT_A[2] + (ACCENT_B[2] - ACCENT_A[2]) * t
            if a:
                row += bytes((round(r / a), round(g / a), round(b / a), round(a / samples * 255)))
            else:
                row += b"\0\0\0\0"
        rows += row

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    blob = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9))
            + chunk(b"IEND", b""))
    path.write_bytes(blob)
    print(f"{path.name}: {len(blob):,} bytes")


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff3d5a"/>
      <stop offset="1" stop-color="#ff7a45"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="24" fill="url(#g)"/>
  <path fill="#fff" d="M34.5 25.5 71 21.5v10l-36.5 4z"/>
  <rect x="34.5" y="25.5" width="5.5" height="44.5" fill="#fff"/>
  <rect x="65.5" y="21.5" width="5.5" height="44.5" fill="#fff"/>
  <ellipse cx="31.2" cy="70" rx="10.8" ry="8" fill="#fff" transform="rotate(-18 31.2 70)"/>
  <ellipse cx="62.2" cy="66" rx="10.8" ry="8" fill="#fff" transform="rotate(-18 62.2 66)"/>
</svg>
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    png(OUT / "icon-192.png", 192, glyph=1.0, radius=0.22)
    png(OUT / "icon-512.png", 512, glyph=1.0, radius=0.22)
    # maskable: full bleed, glyph pulled into the safe zone
    png(OUT / "maskable-512.png", 512, glyph=0.62, radius=0.0)
    (OUT / "favicon.svg").write_text(SVG, encoding="utf-8")
    print("favicon.svg written")


if __name__ == "__main__":
    main()
