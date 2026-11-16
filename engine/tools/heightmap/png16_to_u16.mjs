// Decodes the 16-bit grayscale heightmap.png of served heightmaps into <map>.u16 (the levels, little-endian u16, row 0
// first), for reference.py. A decoder of its own (zlib inflate and the PNG scanline filters), not the page's and not
// the engine's, and a check of the levels' sum against meta.json.
//
//   node png16_to_u16.mjs <heightmaps_dir> <levels_dir> <map>...
import fs from "node:fs";
import zlib from "node:zlib";

const [heightmapsDir, levelsDir, ...maps] = process.argv.slice(2);

/**
 * @param {Buffer} buffer - a non-interlaced 16-bit grayscale PNG
 * @returns {{width: number, height: number, levels: Uint16Array}}
 */
function decode(buffer) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    signature.forEach((byte, i) => { if (buffer[i] !== byte) throw new Error("not a PNG"); });
    let position = 8;
    let width = 0;
    let height = 0;
    let header = null;
    const compressed = [];
    while (position < buffer.length) {
        const length = buffer.readUInt32BE(position);
        const type = buffer.toString("latin1", position + 4, position + 8);
        const data = buffer.subarray(position + 8, position + 8 + length);
        if (type === "IHDR") {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            header = { depth: data[8], colorType: data[9], interlace: data[12] };
        } else if (type === "IDAT") {
            compressed.push(data);
        } else if (type === "IEND") {
            break;
        }
        position += 12 + length;
    }
    if (header.depth !== 16 || header.colorType !== 0 || header.interlace !== 0) throw new Error("not a 16-bit grayscale PNG");
    const raw = zlib.inflateSync(Buffer.concat(compressed));
    const stride = width * 2;
    if (raw.length !== height * (stride + 1)) throw new Error(`size mismatch: ${raw.length} bytes`);
    const bytes = Buffer.alloc(height * stride);
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const source = y * (stride + 1) + 1;
        const target = y * stride;
        const above = target - stride;
        for (let x = 0; x < stride; x++) {
            const left = x >= 2 ? bytes[target + x - 2] : 0;
            const up = y > 0 ? bytes[above + x] : 0;
            const upLeft = x >= 2 && y > 0 ? bytes[above + x - 2] : 0;
            let value = raw[source + x];
            if (filter === 1) value += left;
            else if (filter === 2) value += up;
            else if (filter === 3) value += (left + up) >> 1;
            else if (filter === 4) {
                const p = left + up - upLeft;
                const pLeft = Math.abs(p - left);
                const pUp = Math.abs(p - up);
                const pUpLeft = Math.abs(p - upLeft);
                value += pLeft <= pUp && pLeft <= pUpLeft ? left : pUp <= pUpLeft ? up : upLeft;
            } else if (filter !== 0) throw new Error(`bad filter ${filter}`);
            bytes[target + x] = value & 255;
        }
    }
    const levels = new Uint16Array(width * height);
    for (let i = 0; i < levels.length; i++) levels[i] = (bytes[2 * i] << 8) | bytes[2 * i + 1];
    return { width, height, levels };
}

for (const map of maps) {
    const meta = JSON.parse(fs.readFileSync(`${heightmapsDir}/${map}/meta.json`));
    const { width, height, levels } = decode(fs.readFileSync(`${heightmapsDir}/${map}/heightmap.png`));
    let sum = 0;
    for (let i = 0; i < levels.length; i++) sum = (sum + levels[i]) >>> 0;
    if (width !== meta.width || height !== meta.height || sum !== meta.webp.levels_sum) throw new Error(`${map}: the PNG does not match meta.json`);
    fs.writeFileSync(`${levelsDir}/${map}.u16`, Buffer.from(levels.buffer));
    console.log(map, width, "x", height, "levels, sum matches meta.json");
}
