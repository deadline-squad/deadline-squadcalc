"""Converts the collision triangles of a volumetric `*_tris.npz` into the raw triangle bytes the engine reads.

The npz is the output of tools/volumetric/py/world_tris.py: `tris` float32 [n, 3, 3] world metres and `mask`
uint8 [n] (bit 1 = blocks Visibility, 2 = Projectile, 4 = Pawn). Only the triangles whose mask has a bit of
`--bits` are written. Output: little-endian float32, nine per triangle (x y z of three vertices), no header.

Run with `python3 -I npz_to_bin.py <in.npz> <out.bin> [--bits 2]` (numpy needed; see engine/README.md for the
docker image). The npz members are stored, not compressed, and are streamed in chunks.
"""
import argparse
import sys
import zipfile

import numpy as np

CHUNK = 1 << 21


def read_header(stream):
    version = np.lib.format.read_magic(stream)
    if version == (1, 0):
        shape, fortran, dtype = np.lib.format.read_array_header_1_0(stream)
    else:
        shape, fortran, dtype = np.lib.format.read_array_header_2_0(stream)
    if fortran:
        raise SystemExit("fortran-ordered arrays are not supported")
    return shape, dtype


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("npz")
    parser.add_argument("out")
    parser.add_argument("--bits", type=int, default=2, help="mask bits a triangle needs (default 2 = Projectile)")
    args = parser.parse_args()

    kept = total = 0
    with zipfile.ZipFile(args.npz) as z, z.open("tris.npy") as tf, z.open("mask.npy") as mf, open(args.out, "wb") as out:
        (n, _, _), tdtype = read_header(tf)
        (m,), mdtype = read_header(mf)
        if n != m or tdtype != np.float32 or mdtype != np.uint8:
            raise SystemExit(f"unexpected arrays: {n} {m} {tdtype} {mdtype}")
        for start in range(0, n, CHUNK):
            count = min(CHUNK, n - start)
            tris = np.frombuffer(tf.read(count * 36), dtype="<f4").reshape(count, 9)
            mask = np.frombuffer(mf.read(count), dtype=np.uint8)
            selected = tris[(mask & args.bits) != 0]
            out.write(selected.tobytes())
            kept += len(selected)
            total += count
    print(f"{kept} of {total} triangles written to {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
