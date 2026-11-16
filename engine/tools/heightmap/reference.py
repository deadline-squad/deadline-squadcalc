#!/usr/bin/env python3
"""Independent reference of the site's heightmap read, for checking the engine's `Heightmap` (`src/heightmap.rs`) and
the page's `SquadHeightmap` (`src/js/squadHeightmaps.js`) against.

Written from the format's description (`meta.json` `orientation`, the `HMD1` layout of `src/heightmap/detail.rs`, the
triangle-diagonal rule), not from the engine's code: pure Python, integers for the detail's nodes, no shared code.

The surface it defines, as the engine does: sample (col, row) at origin + col * resolution * (cos yaw, sin yaw) + row *
resolution * (-sin yaw, cos yaw) (Unreal's frame, Y south, yaw clockwise); a quad is two triangles split along the
diagonal from (row, col) to (row + 1, col + 1); a quad with detail is read on its sub-grid of `factor` sub-quads per side
with the same rule; a quad without detail beside one that has it takes the nodes of their shared edge from that
neighbour, the others from the triangle rule on its corners; more than half a sample outside the lattice there is no
height (NaN). A height is `level * z_step_m` (metres above the heightmap's lowest level, the page's convention).

usage:
  reference.py points <heightmaps_dir> <levels_dir> <map> <out_dir>
      draws 100 000 uniform points, 20 000 inside quads with detail, 2 000 around the lattice's border and 20 000
      inside plain quads beside a quad with detail, writes <out_dir>/<map>.pts.f64 (lat, lng pairs on the 256-unit
      minimap), <map>.kind.u8 (0 uniform, 1 detail quad, 2 border, 3 plain quad beside detail) and <map>.ref.f64
  reference.py expect <heightmaps_dir> <levels_dir> <map> <points.f64> <out.f64>
      the reference heights of given points

`<heightmaps_dir>` holds `<map>/meta.json` and `<map>/heightmap.detail.bin` as served; `<levels_dir>` holds `<map>.u16`,
the heightmap's levels as little-endian u16 (`png16_to_u16.mjs` decodes the served PNG).
"""
import array
import gzip
import json
import math
import os
import random
import struct
import sys

PIXEL = 256.0


def load(heightmaps_dir, levels_dir, name):
    """meta.json, the levels and the decoded detail of a map."""
    meta = json.load(open(f"{heightmaps_dir}/{name}/meta.json"))
    levels = array.array("H")
    with open(f"{levels_dir}/{name}.u16", "rb") as f:
        levels.frombytes(f.read())
    if sys.byteorder == "big":
        levels.byteswap()
    detail = None
    if meta.get("detail"):
        detail = decode_detail(gzip.open(f"{heightmaps_dir}/{name}/{meta['detail']['file']}").read(), levels, meta["width"])
    return meta, levels, detail


def decode_detail(raw, levels, width):
    """{'factor', 'quad_columns', 'nodes': {quad: {(i, j): level}}} of an HMD1 file; the corners are the levels'."""
    assert raw[:4] == b"HMD1"
    factor, unit, quad_columns, quad_rows, count = struct.unpack_from("<5I", raw, 4)
    assert quad_columns == width - 1
    bits = raw[24:24 + (quad_columns * quad_rows + 7) // 8]
    position = 24 + len(bits)
    inner = [(i, j) for i in range(factor + 1) for j in range(factor + 1) if not (i in (0, factor) and j in (0, factor))]
    nodes = {}
    for byte_index, byte in enumerate(bits):
        for bit in range(8):
            if not byte >> bit & 1:
                continue
            quad = byte_index * 8 + bit
            row, col = divmod(quad, quad_columns)
            at = row * width + col
            c00, c01, c10, c11 = levels[at], levels[at + 1], levels[at + width], levels[at + width + 1]
            grid = {(0, 0): c00, (0, factor): c01, (factor, 0): c10, (factor, factor): c11}
            for i, j in inner:
                value = 0
                shift = 0
                while True:
                    octet = raw[position]
                    position += 1
                    value |= (octet & 0x7F) << shift
                    shift += 7
                    if octet < 0x80:
                        break
                residual = -((value + 1) // 2) if value & 1 else value // 2
                grid[(i, j)] = rounded_prediction(c00, c01, c10, c11, factor, i, j) + residual * unit
            nodes[quad] = grid
    assert position == len(raw) and len(nodes) == count
    return {"factor": factor, "quad_columns": quad_columns, "nodes": nodes}


def rounded_prediction(c00, c01, c10, c11, factor, i, j):
    """The triangle rule's level at sub-grid node (i, j), rounded half up."""
    scaled = rule_scaled(c00, c01, c10, c11, factor, i, j)
    return (2 * scaled + factor) // (2 * factor)


def rule_scaled(c00, c01, c10, c11, factor, i, j):
    """`factor` times the triangle rule's level at sub-grid node (i, j) of a quad with these corners."""
    if j >= i:
        return factor * c00 + j * (c01 - c00) + i * (c11 - c01)
    return factor * c00 + i * (c10 - c00) + j * (c11 - c10)


def to_lattice(meta, lat, lng):
    """(col, row) of a minimap LatLng in the sample lattice."""
    bounds = meta["bounds_m"]
    world_x = bounds["min_x"] + lng * (bounds["max_x"] - bounds["min_x"]) / PIXEL
    world_y = bounds["min_y"] - lat * (bounds["max_y"] - bounds["min_y"]) / PIXEL
    origin_x, origin_y = meta["origin_m"]
    yaw = math.radians(meta.get("yaw_deg", 0.0))
    dx, dy = world_x - origin_x, world_y - origin_y
    return ((dx * math.cos(yaw) + dy * math.sin(yaw)) / meta["resolution_m"],
            (-dx * math.sin(yaw) + dy * math.cos(yaw)) / meta["resolution_m"])


def to_latlng(meta, col, row):
    """The minimap LatLng of a position in the sample lattice."""
    origin_x, origin_y = meta["origin_m"]
    yaw = math.radians(meta.get("yaw_deg", 0.0))
    spacing = meta["resolution_m"]
    world_x = origin_x + col * spacing * math.cos(yaw) - row * spacing * math.sin(yaw)
    world_y = origin_y + col * spacing * math.sin(yaw) + row * spacing * math.cos(yaw)
    bounds = meta["bounds_m"]
    return (-(world_y - bounds["min_y"]) / (bounds["max_y"] - bounds["min_y"]) * PIXEL,
            (world_x - bounds["min_x"]) / (bounds["max_x"] - bounds["min_x"]) * PIXEL)


def height_at(meta, levels, detail, lat, lng):
    """The reference height at a minimap LatLng: NaN where there is none."""
    width, height = meta["width"], meta["height"]
    col, row = to_lattice(meta, lat, lng)
    if not (-0.5 <= row <= height - 0.5 and -0.5 <= col <= width - 0.5):
        return float("nan")
    row = min(max(row, 0.0), height - 1.0)
    col = min(max(col, 0.0), width - 1.0)
    row0 = min(int(math.floor(row)), height - 2)
    col0 = min(int(math.floor(col)), width - 2)
    row_weight, col_weight = row - row0, col - col0
    at = row0 * width + col0
    c00, c01, c10, c11 = levels[at], levels[at + 1], levels[at + width], levels[at + width + 1]
    grid = sub_grid(detail, row0, col0, (c00, c01, c10, c11), height - 1) if detail else None
    if grid is None:
        if col_weight >= row_weight:
            level = c00 + (c01 - c00) * col_weight + (c11 - c01) * row_weight
        else:
            level = c00 + (c10 - c00) * row_weight + (c11 - c10) * col_weight
    else:
        factor = detail["factor"]
        sub_row, sub_col = row_weight * factor, col_weight * factor
        i = min(int(math.floor(sub_row)), factor - 1)
        j = min(int(math.floor(sub_col)), factor - 1)
        row_part, col_part = sub_row - i, sub_col - j
        node = lambda a, b: grid[(a, b)]
        if col_part >= row_part:
            level = node(i, j) + (node(i, j + 1) - node(i, j)) * col_part + (node(i + 1, j + 1) - node(i, j + 1)) * row_part
        else:
            level = node(i, j) + (node(i + 1, j) - node(i, j)) * row_part + (node(i + 1, j + 1) - node(i + 1, j)) * col_part
    return level * meta["webp"]["z_step_m"]


def sub_grid(detail, row, col, corners, quad_rows):
    """The nodes of the quad's sub-grid, or None when neither it nor a neighbour has detail (the corner rule)."""
    nodes, columns, factor = detail["nodes"], detail["quad_columns"], detail["factor"]
    quad = row * columns + col
    if quad in nodes:
        return nodes[quad]
    neighbours = {
        "above": nodes.get(quad - columns) if row > 0 else None,
        "below": nodes.get(quad + columns) if row + 1 < quad_rows else None,
        "left": nodes.get(quad - 1) if col > 0 else None,
        "right": nodes.get(quad + 1) if col + 1 < columns else None,
    }
    if not any(neighbours.values()):
        return None
    c00, c01, c10, c11 = corners
    grid = {}
    for i in range(factor + 1):
        for j in range(factor + 1):
            grid[(i, j)] = rule_scaled(c00, c01, c10, c11, factor, i, j) / factor
    for k in range(1, factor):
        if neighbours["above"]:
            grid[(0, k)] = neighbours["above"][(factor, k)]
        if neighbours["below"]:
            grid[(factor, k)] = neighbours["below"][(0, k)]
        if neighbours["left"]:
            grid[(k, 0)] = neighbours["left"][(k, factor)]
        if neighbours["right"]:
            grid[(k, factor)] = neighbours["right"][(k, 0)]
    return grid


def draw_points(meta, levels, detail, name):
    """The points of the `points` command: (lat, lng) pairs and their kinds."""
    width, height = meta["width"], meta["height"]
    rng = random.Random(20261113 + sum(map(ord, name)))
    points, kinds = array.array("d"), array.array("B")
    for _ in range(100000):
        points.extend((-rng.uniform(0, PIXEL), rng.uniform(0, PIXEL)))
        kinds.append(0)
    quads = sorted(detail["nodes"]) if detail else []
    columns = width - 1
    for _ in range(20000 if quads else 0):
        row, col = divmod(rng.choice(quads), columns)
        points.extend(to_latlng(meta, col + rng.random(), row + rng.random()))
        kinds.append(1)
    for _ in range(2000):
        side, t = rng.randrange(4), rng.random()
        col = t * (width - 1) if side < 2 else rng.uniform(-3, 3) if side == 2 else (width - 1) + rng.uniform(-3, 3)
        row = rng.uniform(-3, 3) if side == 0 else (height - 1) + rng.uniform(-3, 3) if side == 1 else t * (height - 1)
        points.extend(to_latlng(meta, col, row))
        kinds.append(2)
    beside = sorted({quad + step for quad in quads for step in (-columns, columns, -1, 1)
                     if 0 <= quad + step < columns * (height - 1) and quad + step not in detail["nodes"]}) if quads else []
    for _ in range(20000 if beside else 0):
        row, col = divmod(rng.choice(beside), columns)
        points.extend(to_latlng(meta, col + rng.random(), row + rng.random()))
        kinds.append(3)
    return points, kinds


def main():
    command, heightmaps_dir, levels_dir, name = sys.argv[1:5]
    meta, levels, detail = load(heightmaps_dir, levels_dir, name)
    if command == "points":
        out_dir = sys.argv[5]
        points, kinds = draw_points(meta, levels, detail, name)
        expected = array.array("d", (height_at(meta, levels, detail, points[2 * i], points[2 * i + 1]) for i in range(len(kinds))))
        for suffix, data in (("pts.f64", points), ("kind.u8", kinds), ("ref.f64", expected)):
            open(f"{out_dir}/{name}.{suffix}", "wb").write(data.tobytes())
        print(name, len(kinds), "points,", len(detail["nodes"]) if detail else 0, "detail quads")
    elif command == "expect":
        points = array.array("d")
        points.frombytes(open(sys.argv[5], "rb").read())
        expected = array.array("d", (height_at(meta, levels, detail, points[2 * i], points[2 * i + 1]) for i in range(len(points) // 2)))
        open(sys.argv[6], "wb").write(expected.tobytes())
        print(name, len(expected), "points")
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
