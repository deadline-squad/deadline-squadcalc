/**
 * Landscape-only heights of a map ("TER2", tools/volumetric/py/terrain_raster.py in the deployment repository),
 * the ground that the voxel layer (VCOL1) stands on: the served heightmap fuses the landscape with the
 * buildings, so under a bridge or in a doorway it reports the roof.
 *
 * Layout (little endian, gzip): magic "TER2\0\0\0\0", float64 origin_x, origin_y, cell, float32 yaw_deg, z_min, step,
 * uint32 width, height, hole_count; width * height residuals as all their low bytes then all their high bytes (zigzag
 * coded 16-bit difference to the plane prediction left + above - above-left); hole_count varints (differences of the
 * sorted vertex indices of the holes). Level 0 = no landscape under the vertex, else z = z_min + (level - 1) * step.
 * The vertices are the landscape's own, on the grid of the heightmap (tools/heightmaps lattice.py): vertex (column, row)
 * lies at world origin + column * cell * (cos yaw, sin yaw) + row * cell * (-sin yaw, cos yaw), in the frame of the
 * voxel file (Unreal metres, X east, Y south).
 * A "TER1" file (the files served before the heightmaps moved onto the landscape's vertices) has the same body after a
 * 40-byte header: float32 min_x, min_y, cell, z_min, step, uint32 width, height, hole_count, its vertex (0, 0) at
 * (min_x, min_y) and no yaw.
 */

// Header of each magic: its size in bytes and its fields
const HEADERS = {
    "TER2\0\0\0\0": {
        bytes: 56,
        read: (view) => ({
            originX: view.getFloat64(8, true), originY: view.getFloat64(16, true), cell: view.getFloat64(24, true),
            yawDeg: view.getFloat32(32, true), zMin: view.getFloat32(36, true), step: view.getFloat32(40, true),
            width: view.getUint32(44, true), height: view.getUint32(48, true), holeCount: view.getUint32(52, true),
        }),
    },
    "TER1\0\0\0\0": {
        bytes: 40,
        read: (view) => ({
            originX: view.getFloat32(8, true), originY: view.getFloat32(12, true), cell: view.getFloat32(16, true),
            yawDeg: 0, zMin: view.getFloat32(20, true), step: view.getFloat32(24, true),
            width: view.getUint32(28, true), height: view.getUint32(32, true), holeCount: view.getUint32(36, true),
        }),
    },
};

/**
 * @typedef {object} Terrain
 * @property {number} originX - world X of vertex (0, 0)
 * @property {number} originY - world Y of vertex (0, 0)
 * @property {number} cell - metres between two vertices
 * @property {number} cos - cosine of the yaw the vertex axes are turned by from world X and Y
 * @property {number} sin - its sine
 * @property {number} zMin
 * @property {number} step - metres per level
 * @property {number} width - vertices per row
 * @property {number} height - rows
 * @property {Uint16Array} levels - row-major; 0 = no landscape
 * @property {Uint8Array} holes - row-major, 1 where the quad whose lower corner is the vertex is a landscape hole
 */

/**
 * Decode a (gunzipped) TER2 or TER1 file
 * @param {Uint8Array} raw - the file without its gzip layer
 * @returns {Terrain}
 * @throws {Error} - on a wrong magic or a truncated file
 */
export function decodeTerrain(raw) {
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const header = HEADERS[String.fromCharCode(...raw.subarray(0, 8))];
    if (!header || raw.byteLength < header.bytes) throw new Error("not a TER2 file");
    const { originX, originY, cell, yawDeg, zMin, step, width, height, holeCount } = header.read(view);
    const yaw = yawDeg * Math.PI / 180;
    const count = width * height;
    const body = header.bytes;
    if (raw.byteLength < body + 2 * count) throw new Error("truncated TER2 file");

    const high = body + count;
    const levels = new Uint16Array(count);
    for (let row = 0, i = 0; row < height; row++) {
        for (let col = 0; col < width; col++, i++) {
            const zigzag = raw[body + i] | (raw[high + i] << 8);
            const residual = (zigzag >>> 1) ^ -(zigzag & 1);
            const left = col > 0 ? levels[i - 1] : 0;
            const above = row > 0 ? levels[i - width] : 0;
            const aboveLeft = row > 0 && col > 0 ? levels[i - width - 1] : 0;
            levels[i] = left + above - aboveLeft + residual;
        }
    }

    const holes = new Uint8Array(count);
    let position = body + 2 * count;
    let index = 0;
    for (let n = 0; n < holeCount; n++) {
        let shift = 0;
        let value = 0;
        for (;;) {
            if (position >= raw.byteLength) throw new Error("truncated TER2 file");
            const byte = raw[position++];
            value += (byte & 0x7F) * 2 ** shift;
            if (byte < 0x80) break;
            shift += 7;
        }
        index += value;
        holes[index] = 1;
    }
    return { originX, originY, cell, cos: Math.cos(yaw), sin: Math.sin(yaw), zMin, step, width, height, levels, holes };
}

/**
 * Height of the landscape at a world position, on the game's triangle rule (every quad is two triangles split
 * along the diagonal from its (row, col) corner to its (row + 1, col + 1) corner, as SquadHeightmap.getHeight)
 * @param {Terrain} terrain
 * @param {number} x - world X, metres
 * @param {number} y - world Y, metres
 * @returns {number} - metres; NaN where the landscape does not stop a shell: outside the grid (more than half a
 *   cell), over a vertex without landscape, in a landscape hole
 */
export function terrainHeight(terrain, x, y) {
    const { width, height, levels, cell, cos, sin } = terrain;
    const dx = x - terrain.originX;
    const dy = y - terrain.originY;
    let col = (cos * dx + sin * dy) / cell;
    let row = (cos * dy - sin * dx) / cell;
    if (!(row >= -0.5 && row <= height - 0.5 && col >= -0.5 && col <= width - 0.5)) return NaN;
    row = Math.min(Math.max(row, 0), height - 1);
    col = Math.min(Math.max(col, 0), width - 1);

    const row0 = Math.min(Math.floor(row), height - 2);
    const col0 = Math.min(Math.floor(col), width - 2);
    const first = row0 * width + col0;
    if (terrain.holes[first]) return NaN;
    const corner = levels[first];
    const right = levels[first + 1];
    const below = levels[first + width];
    const diagonal = levels[first + width + 1];
    if (!corner || !right || !below || !diagonal) return NaN;

    const rowWeight = row - row0;
    const colWeight = col - col0;
    const level = colWeight >= rowWeight
        ? corner + (right - corner) * colWeight + (diagonal - right) * rowWeight
        : corner + (below - corner) * rowWeight + (diagonal - below) * colWeight;
    return terrain.zMin + (level - 1) * terrain.step;
}
