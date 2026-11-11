/**
 * The detail of a heightmap where objects stand ("HMD1", heightmap.detail.bin; tools/heightmaps/py/heightmap_detail.py in
 * the deployment repository). On the quads that hold it, the nodes of the lattice subdivided by `factor` inside the quad
 * (0.5 m apart on most maps), fused from the game's terrain and objects like the heightmap: next to a wall or a roof edge
 * the height is read on those smaller quads, with the same triangle rule, instead of across the whole quad.
 *
 * Layout (little endian, gzip): magic "HMD1", uint32 factor, unit, quad columns (heightmap width - 1), quad rows, quad
 * count; the bitset of the quads with detail (quad q = row * quad columns + col, bit q % 8 of byte q >> 3); then for each
 * of those quads in the order of q the (factor + 1)^2 - 4 nodes of its sub-grid that are not its corners, row-major, as
 * zigzag varints of v: the node's level is the level the triangle rule reads there from the quad's four corners, rounded
 * half up, plus v * unit. Levels are the heightmap's (height = level * step); a node may lie outside 0 to 65535.
 */

const MAGIC = "HMD1";
const HEADER_BYTES = 24;

/**
 * @typedef {object} HeightmapDetail
 * @property {number} factor - sub-quads along each side of a quad with detail
 * @property {number} inner - nodes stored per quad: (factor + 1)^2 - 4
 * @property {number} quadColumns - quads per row of the heightmap
 * @property {Uint32Array} words - the bitset of the quads with detail, quad q in bit q % 32 of word q >> 5
 * @property {Uint32Array} ranks - the number of quads with detail before each word
 * @property {Int32Array} nodes - the levels of the stored nodes of each quad with detail, in the order of the quads
 */

/**
 * Number of set bits of a 32-bit integer
 * @param {number} bits
 * @returns {number}
 */
function popcount(bits) {
    let count = bits - ((bits >>> 1) & 0x55555555);
    count = (count & 0x33333333) + ((count >>> 2) & 0x33333333);
    return (((count + (count >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24;
}

/**
 * Decode a (gunzipped) detail of the heightmap `levels`
 * @param {Uint8Array} raw - heightmap.detail.bin without its gzip layer
 * @param {Uint16Array} levels - the heightmap's levels, row-major
 * @param {number} width - samples per row of the heightmap
 * @returns {HeightmapDetail}
 * @throws {Error} - on a wrong magic, a detail of another grid, or a truncated or damaged file
 */
export function decodeDetail(raw, levels, width) {
    if (raw.byteLength < HEADER_BYTES || String.fromCharCode(...raw.subarray(0, 4)) !== MAGIC) throw new Error("not an HMD1 detail");
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const [factor, unit, quadColumns, quadRows, count] = [4, 8, 12, 16, 20].map((offset) => view.getUint32(offset, true));
    if (quadColumns !== width - 1 || quadRows !== levels.length / width - 1) throw new Error("detail of another heightmap");
    const quads = quadColumns * quadRows;
    const bitBytes = Math.ceil(quads / 8);
    if (raw.byteLength < HEADER_BYTES + bitBytes) throw new Error("truncated detail");

    const words = new Uint32Array(Math.ceil(quads / 32));
    for (let byte = 0; byte < bitBytes; byte++) words[byte >> 2] |= raw[HEADER_BYTES + byte] << ((byte & 3) * 8);
    const ranks = new Uint32Array(words.length);
    let total = 0;
    for (let word = 0; word < words.length; word++) {
        ranks[word] = total;
        total += popcount(words[word]);
    }
    if (total !== count) throw new Error("damaged detail");

    // The stored nodes' sub-grid positions (row, col), row-major without the corners
    const positions = [];
    for (let i = 0; i <= factor; i++) {
        for (let j = 0; j <= factor; j++) if (!((i === 0 || i === factor) && (j === 0 || j === factor))) positions.push([i, j]);
    }
    const nodes = new Int32Array(count * positions.length);
    let position = HEADER_BYTES + bitBytes;
    let n = 0;
    for (let word = 0; word < words.length; word++) {
        for (let bits = words[word]; bits; bits &= bits - 1) {
            const quad = word * 32 + 31 - Math.clz32(bits & -bits);
            const row0 = Math.floor(quad / quadColumns);
            const first = row0 * width + quad - row0 * quadColumns;
            const c00 = levels[first];
            const c01 = levels[first + 1];
            const c10 = levels[first + width];
            const c11 = levels[first + width + 1];
            for (const [i, j] of positions) {
                let value = 0;
                for (let shift = 0; ; shift += 7) {
                    if (position >= raw.byteLength) throw new Error("truncated detail");
                    const byte = raw[position++];
                    value += (byte & 0x7F) * 2 ** shift;
                    if (byte < 0x80) break;
                }
                const scaled = j >= i
                    ? factor * c00 + j * (c01 - c00) + i * (c11 - c01)
                    : factor * c00 + i * (c10 - c00) + j * (c11 - c10);
                const residual = value % 2 ? -(value + 1) / 2 : value / 2;
                nodes[n++] = Math.floor((2 * scaled + factor) / (2 * factor)) + residual * unit;
            }
        }
    }
    if (position !== raw.byteLength) throw new Error("damaged detail");
    return { factor, inner: positions.length, quadColumns, words, ranks, nodes };
}

/**
 * Level of a node of a quad's sub-grid
 * @param {HeightmapDetail} detail
 * @param {number} first - index in `detail.nodes` of the quad's first stored node
 * @param {number} i - sub-grid row, 0 to factor
 * @param {number} j - sub-grid column, 0 to factor
 * @param {Uint16Array} top - the heightmap row of the quad's upper corners
 * @param {Uint16Array} bottom - the row of its lower corners
 * @param {number} col0 - the column of its left corners
 * @returns {number}
 */
function nodeLevel(detail, first, i, j, top, bottom, col0) {
    const factor = detail.factor;
    if ((i === 0 || i === factor) && (j === 0 || j === factor)) {
        const row = i === 0 ? top : bottom;
        return row[j === 0 ? col0 : col0 + 1];
    }
    const index = i * (factor + 1) + j;
    return detail.nodes[first + index - 1 - (index > factor ? 1 : 0) - (index > factor * (factor + 1) ? 1 : 0)];
}

/**
 * Level at a point of a quad that has detail, on the triangle of its sub-grid the point is in (the split of
 * SquadHeightmap.getHeight); null for a quad without detail
 * @param {HeightmapDetail} detail
 * @param {number} row0 - the quad's upper row
 * @param {number} col0 - its left column
 * @param {number} rowWeight - the point's fraction of the quad down, 0 to 1
 * @param {number} colWeight - its fraction across
 * @param {Uint16Array} top - the heightmap row row0
 * @param {Uint16Array} bottom - the row row0 + 1
 * @returns {number|null}
 */
export function detailLevel(detail, row0, col0, rowWeight, colWeight, top, bottom) {
    const quad = row0 * detail.quadColumns + col0;
    const word = quad >>> 5;
    const bit = quad & 31;
    const bits = detail.words[word];
    if (!((bits >>> bit) & 1)) return null;
    const first = (detail.ranks[word] + popcount(bits & ((1 << bit) - 1))) * detail.inner;

    const factor = detail.factor;
    const subRow = rowWeight * factor;
    const subCol = colWeight * factor;
    const i = Math.min(Math.floor(subRow), factor - 1);
    const j = Math.min(Math.floor(subCol), factor - 1);
    const rowPart = subRow - i;
    const colPart = subCol - j;
    const corner = nodeLevel(detail, first, i, j, top, bottom, col0);
    const diagonal = nodeLevel(detail, first, i + 1, j + 1, top, bottom, col0);
    if (colPart >= rowPart) {
        const right = nodeLevel(detail, first, i, j + 1, top, bottom, col0);
        return corner + (right - corner) * colPart + (diagonal - right) * rowPart;
    }
    const below = nodeLevel(detail, first, i + 1, j, top, bottom, col0);
    return corner + (below - corner) * rowPart + (diagonal - below) * colPart;
}
