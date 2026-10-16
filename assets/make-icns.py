#!/usr/bin/env python3
"""Renders web/logo.svg into assets/MRAkdown.icns (the macOS app icon) at all standard sizes.

Uses rsvg-convert (librsvg) to rasterise the SVG; the .icns holds the sizes as PNG images, which macOS reads
directly, so no Mac tools are needed.
Usage: python3 assets/make-icns.py
"""
import struct
import subprocess
from pathlib import Path

here = Path(__file__).resolve().parent
svg = here.parent / "web" / "logo.svg"

# Icon type codes and their pixel sizes: 16, 32, 128, 256 and 512 points, each also at double resolution.
SIZES = [("icp4", 16), ("ic11", 32), ("icp5", 32), ("ic12", 64), ("ic07", 128), ("ic13", 256),
         ("ic08", 256), ("ic14", 512), ("ic09", 512), ("ic10", 1024)]

entries = b""
for code, size in SIZES:
    png = subprocess.run(["rsvg-convert", "-w", str(size), "-h", str(size), str(svg)],
                         check=True, capture_output=True).stdout
    entries += code.encode() + struct.pack(">I", 8 + len(png)) + png

(here / "MRAkdown.icns").write_bytes(b"icns" + struct.pack(">I", 8 + len(entries)) + entries)
