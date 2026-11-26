"""Generate the 24x24 Even Hub icon: lit pixels are opaque #F4F4F4 in raster-aligned 2x2 blocks."""
import struct
import sys
import zlib

# 12x12 block grid; each '#' becomes a 2x2 lit block. A speech bubble with two text lines.
GRID = [
    "............",
    ".##########.",
    ".#........#.",
    ".#.######.#.",
    ".#........#.",
    ".#.####...#.",
    ".#........#.",
    ".##########.",
    "...##.......",
    "..##........",
    ".##.........",
    "............",
]
LIT = (0xF4, 0xF4, 0xF4, 0xFF)
OFF = (0, 0, 0, 0)


def chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)


def main(path: str) -> None:
    rows = []
    for y in range(24):
        line = bytearray([0])  # filter type 0
        for x in range(24):
            line.extend(LIT if GRID[y // 2][x // 2] == "#" else OFF)
        rows.append(bytes(line))
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", 24, 24, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as fh:
        fh.write(png)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "icon.png")
