// A heightmap reader of its own, written from the file layouts of the site's /heightmaps/<map>/ and the rule of the
// game's landscape collision, and sharing no line with the calculator: it imports nothing of src/ and engine/.
// Files read: meta.json, heightmap.png (16-bit grayscale, decoded here with node:zlib) and heightmap.detail.bin (HMD1).
//
// The surface: every quad of four samples is two triangles split along the diagonal from its (row, col) corner to its
// (row + 1, col + 1) corner. A quad with detail is read the same way on a sub-grid of `f` sub-quads per side, whose
// nodes are stored; a quad without detail beside one that has it takes the nodes of their shared edge from that
// neighbour and the other nodes from the triangle rule, so the surface has no jump there.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const HMD1_HEADER_BYTES = 24;

/**
 * 16-bit grayscale, non-interlaced PNG: inflate and undo the row filters
 * @param {Buffer} file
 * @returns {{width: number, height: number, levels: Uint16Array}}
 */
function decodePng16(file) {
    for (let i = 0; i < 8; i++) if (file[i] !== PNG_SIGNATURE[i]) throw new Error("not a PNG");
    let pos = 8;
    let width = 0;
    let height = 0;
    let depth = 0;
    let colorType = -1;
    let interlace = 0;
    const idat = [];
    while (pos < file.length) {
        const length = file.readUInt32BE(pos);
        const type = file.toString("latin1", pos + 4, pos + 8);
        const data = file.subarray(pos + 8, pos + 8 + length);
        if (type === "IHDR") {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            depth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === "IDAT") {
            idat.push(data);
        } else if (type === "IEND") {
            break;
        }
        pos += 12 + length;
    }
    if (depth !== 16 || colorType !== 0 || interlace !== 0) {
        throw new Error(`unsupported PNG: depth ${depth}, colour type ${colorType}, interlace ${interlace}`);
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * 2;
    if (raw.length !== height * (stride + 1)) throw new Error(`PNG data has ${raw.length} bytes, expected ${height * (stride + 1)}`);

    const bytes = Buffer.alloc(height * stride); // big-endian samples as in the PNG, unfiltered
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const source = y * (stride + 1) + 1;
        const row = y * stride;
        const up = row - stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= 2 ? bytes[row + x - 2] : 0;
            const b = y > 0 ? bytes[up + x] : 0;
            const c = x >= 2 && y > 0 ? bytes[up + x - 2] : 0;
            let v = raw[source + x];
            switch (filter) {
            case 0: break;
            case 1: v += a; break;
            case 2: v += b; break;
            case 3: v += (a + b) >> 1; break;
            case 4: {
                const p = a + b - c;
                const pa = Math.abs(p - a);
                const pb = Math.abs(p - b);
                const pc = Math.abs(p - c);
                v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
                break;
            }
            default: throw new Error(`bad PNG filter ${filter}`);
            }
            bytes[row + x] = v & 255;
        }
    }
    const levels = new Uint16Array(width * height);
    for (let i = 0; i < levels.length; i++) levels[i] = (bytes[2 * i] << 8) | bytes[2 * i + 1];
    return { width, height, levels };
}

/**
 * The stored nodes of every quad that has detail, from a gunzipped HMD1 file: the layout is the header (magic, factor,
 * unit, quad columns, quad rows, quad count), the bitset of the quads with detail (bit q % 8 of byte q >> 3), then for
 * each of them, in the order of q, the nodes of its sub-grid that are not its corners, row-major, as zigzag varints v.
 * A node's level is the triangle rule's read of the quad's corners there, rounded half up, plus v * unit.
 * @returns {{factor: number, quads: Map<number, Float64Array>}} - per quad q = row * (width - 1) + col, the (factor + 1)^2
 *   node levels, row-major, corners included
 */
function readDetail(raw, levels, width, height) {
    if (raw.toString("latin1", 0, 4) !== "HMD1") throw new Error("not an HMD1 detail");
    const factor = raw.readUInt32LE(4);
    const unit = raw.readUInt32LE(8);
    const quadColumns = raw.readUInt32LE(12);
    const quadRows = raw.readUInt32LE(16);
    const count = raw.readUInt32LE(20);
    if (quadColumns !== width - 1 || quadRows !== height - 1) throw new Error("the detail is of another heightmap");

    const quads = new Map();
    let pos = HMD1_HEADER_BYTES + Math.ceil(quadColumns * quadRows / 8);
    for (let q = 0; q < quadColumns * quadRows; q++) {
        if (!((raw[HMD1_HEADER_BYTES + (q >> 3)] >> (q & 7)) & 1)) continue;
        const row = Math.floor(q / quadColumns);
        const col = q - row * quadColumns;
        const corners = cornersOf(levels, width, row, col);
        const nodes = new Float64Array((factor + 1) * (factor + 1));
        for (let i = 0; i <= factor; i++) {
            for (let j = 0; j <= factor; j++) {
                if ((i === 0 || i === factor) && (j === 0 || j === factor)) {
                    nodes[i * (factor + 1) + j] = corners[(i === factor ? 2 : 0) + (j === factor ? 1 : 0)];
                    continue;
                }
                let value = 0;
                let scale = 1;
                for (;;) {
                    const byte = raw[pos++];
                    value += (byte & 127) * scale;
                    scale *= 128;
                    if (byte < 128) break;
                }
                const residual = value % 2 ? -(value + 1) / 2 : value / 2;
                nodes[i * (factor + 1) + j] = Math.floor((2 * scaledRead(corners, factor, i, j) + factor) / (2 * factor)) + residual * unit;
            }
        }
        quads.set(q, nodes);
    }
    if (pos !== raw.length || quads.size !== count) throw new Error("the detail does not decode to its header");
    return { factor, quads };
}

/** [(row, col), (row, col + 1), (row + 1, col), (row + 1, col + 1)] levels of a quad */
function cornersOf(levels, width, row, col) {
    const at = row * width + col;
    return [levels[at], levels[at + 1], levels[at + width], levels[at + width + 1]];
}

/** The triangle rule's read of the corners at sub-node (i, j) of a grid of `factor` sub-quads, times `factor` */
function scaledRead([c00, c01, c10, c11], factor, i, j) {
    return j >= i
        ? factor * c00 + j * (c01 - c00) + i * (c11 - c01)
        : factor * c00 + i * (c10 - c00) + j * (c11 - c10);
}

/**
 * @param {string} directory - the site's heightmaps directory, holding <map>/{meta.json, heightmap.png, heightmap.detail.bin}
 * @param {string} map
 * @returns {object} - the reader: `factor` (sub-quads per side, 1 without detail), `terrainAt(col, row)` the height in metres
 *   above the lowest level at a fractional lattice position, `toLattice(x, y)` the lattice position [col, row] of a world
 *   point (Unreal's frame of meta.json: Y south, yaw clockwise), `inside(x, y)`, `meta`, `levels`, `detailBytes`
 * @throws {Error} - a file is missing or does not decode to its meta.json
 */
export function readHeightmap(directory, map) {
    const folder = path.join(directory, map);
    const meta = JSON.parse(fs.readFileSync(path.join(folder, "meta.json"), "utf8"));
    const png = decodePng16(fs.readFileSync(path.join(folder, "heightmap.png")));
    const width = meta.width;
    const height = meta.height;
    if (png.width !== width || png.height !== height) throw new Error(`${map}: the PNG is ${png.width} x ${png.height}, meta.json says ${width} x ${height}`);
    const { levels } = png;
    if (meta.webp?.levels_sum === undefined) throw new Error(`${map}: meta.json has no webp.levels_sum to check the decoded levels against`);
    let sum = 0;
    for (let i = 0; i < levels.length; i++) sum = (sum + levels[i]) >>> 0;
    if (sum !== meta.webp.levels_sum) throw new Error(`${map}: the sum of the levels is ${sum}, meta.json says ${meta.webp.levels_sum}`);

    let factor = 1;
    let quads = new Map();
    let detailBytes = null;
    if (meta.detail?.file) {
        const gz = fs.readFileSync(path.join(folder, meta.detail.file));
        detailBytes = zlib.gunzipSync(gz);
        ({ factor, quads } = readDetail(detailBytes, levels, width, height));
    }

    const step = meta.z_step_m;
    const spacing = meta.resolution_m;
    const yaw = (meta.yaw_deg ?? 0) * Math.PI / 180;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const [originX, originY] = meta.origin_m;
    const quadColumns = width - 1;
    const quadRows = height - 1;

    // Quads without detail beside a quad with it: nodes made on first use (null: no neighbour has detail)
    const shared = new Map();
    const sharedNodes = (row, col) => {
        const q = row * quadColumns + col;
        if (shared.has(q)) return shared.get(q);
        const above = row > 0 ? quads.get(q - quadColumns) : undefined;
        const below = row + 1 < quadRows ? quads.get(q + quadColumns) : undefined;
        const left = col > 0 ? quads.get(q - 1) : undefined;
        const right = col + 1 < quadColumns ? quads.get(q + 1) : undefined;
        let nodes = null;
        if (above || below || left || right) {
            const corners = cornersOf(levels, width, row, col);
            const side = factor + 1;
            nodes = new Float64Array(side * side);
            for (let i = 0; i <= factor; i++) {
                for (let j = 0; j <= factor; j++) {
                    let level;
                    if ((i === 0 || i === factor) && (j === 0 || j === factor)) level = corners[(i === factor ? 2 : 0) + (j === factor ? 1 : 0)];
                    else if (i === 0 && above) level = above[factor * side + j];
                    else if (i === factor && below) level = below[j];
                    else if (j === 0 && left) level = left[i * side + factor];
                    else if (j === factor && right) level = right[i * side];
                    else level = scaledRead(corners, factor, i, j) / factor;
                    nodes[i * side + j] = level;
                }
            }
        }
        shared.set(q, nodes);
        return nodes;
    };

    const terrainAt = (col, row) => {
        const row0 = Math.min(Math.max(Math.floor(row), 0), height - 2);
        const col0 = Math.min(Math.max(Math.floor(col), 0), width - 2);
        const fy = row - row0;
        const fx = col - col0;
        if (quads.size) {
            const nodes = quads.get(row0 * quadColumns + col0) ?? sharedNodes(row0, col0);
            if (nodes) {
                const side = factor + 1;
                const sr = fy * factor;
                const sc = fx * factor;
                const i = Math.min(Math.floor(sr), factor - 1);
                const j = Math.min(Math.floor(sc), factor - 1);
                const pr = sr - i;
                const pc = sc - j;
                const n = (a, b) => nodes[a * side + b];
                const level = pc >= pr
                    ? n(i, j) + (n(i, j + 1) - n(i, j)) * pc + (n(i + 1, j + 1) - n(i, j + 1)) * pr
                    : n(i, j) + (n(i + 1, j) - n(i, j)) * pr + (n(i + 1, j + 1) - n(i + 1, j)) * pc;
                return level * step;
            }
        }
        const at = row0 * width + col0;
        const a = levels[at];
        const b = levels[at + 1];
        const c = levels[at + width];
        const d = levels[at + width + 1];
        return (fx >= fy ? a + (b - a) * fx + (d - b) * fy : a + (c - a) * fy + (d - c) * fx) * step;
    };

    const toLattice = (x, y) => {
        const dx = x - originX;
        const dy = y - originY;
        return [(dx * cos + dy * sin) / spacing, (-dx * sin + dy * cos) / spacing];
    };
    const inside = (x, y) => {
        const [col, row] = toLattice(x, y);
        return col >= 0 && col <= width - 1 && row >= 0 && row <= height - 1;
    };

    return { meta, levels, detailBytes, factor, terrainAt, toLattice, inside };
}
