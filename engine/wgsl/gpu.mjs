/**
 * WebGPU host for the Squad ballistics compute shaders (trace.wgsl, heatmap.wgsl, voxel.wgsl).
 *
 * Runs unchanged in a browser and in any WebGPU runtime: it only needs a GPUDevice, the engine's `bvh.bin`
 * bytes and the three WGSL sources. Layouts and limits are documented in README.md.
 *
 * Coordinates are world metres, x east, y north, z up, f32.
 */

const WORKGROUP_SIZE = 64;
const MAX_GROUPS_PER_DIMENSION = 65535;
const NODE_BYTES = 32;
const TRIANGLE_BYTES = 48;
const SEGMENT_BYTES = 32;
const HIT_BYTES = 32;
const VOXEL_HIT_BYTES = 16;
const CELL_BYTES = 16;
const NO_HIT = 0xffffffff;
const ACCUMULATE = 1;
/** Highest first-triangle index a leaf can address: node.b packs it above 8 bits of a u32. */
const MAX_LEAF_TRIANGLE = 0xffffff;

const STORAGE = 0x80; // GPUBufferUsage.STORAGE
const UNIFORM = 0x40;
const COPY_SRC = 0x04;
const COPY_DST = 0x08;
const MAP_READ = 0x01;
const SHADER_COMPUTE = 0x4; // GPUShaderStage.COMPUTE

/**
 * @typedef {Object} Bvh
 * @property {number} nodeCount
 * @property {number} triangleCount
 * @property {Uint8Array} nodes - nodeCount * 32 bytes, little endian
 * @property {Float32Array} triangles - triangleCount * 12 floats (3 x xyz + pad)
 */

/**
 * Splits `bvh.bin` (u32 node_count, u32 tri_count, nodes, triangles) into views over the same memory.
 * @param {ArrayBuffer} buffer - the file contents
 * @returns {Bvh}
 * @throws {Error} if the sizes in the header do not match the file
 */
export function parseBvh(buffer) {
    const header = new Uint32Array(buffer, 0, 2);
    const [nodeCount, triangleCount] = header;
    const expected = 8 + nodeCount * NODE_BYTES + triangleCount * TRIANGLE_BYTES;
    if (buffer.byteLength !== expected) {
        throw new Error(`bvh.bin is ${buffer.byteLength} bytes, header says ${expected}`);
    }
    return {
        nodeCount,
        triangleCount,
        nodes: new Uint8Array(buffer, 8, nodeCount * NODE_BYTES),
        triangles: new Float32Array(buffer, 8 + nodeCount * NODE_BYTES, triangleCount * 12),
    };
}

/**
 * Requests a device with the adapter's own storage-buffer limits (the WebGPU default is 128 MiB).
 * @param {GPU} gpu - navigator.gpu
 * @returns {Promise<{device: GPUDevice, adapterInfo: GPUAdapterInfo}>}
 */
export async function requestDevice(gpu) {
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('no WebGPU adapter');
    const device = await adapter.requestDevice({
        requiredLimits: {
            maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
            maxBufferSize: adapter.limits.maxBufferSize,
        },
    });
    return { device, adapterInfo: adapter.info };
}

function dispatchSize(count) {
    const groups = Math.max(1, Math.ceil(count / WORKGROUP_SIZE));
    const x = Math.min(groups, MAX_GROUPS_PER_DIMENSION);
    return [x, Math.ceil(groups / x)];
}

/** GPU-resident BVH: node and triangle storage buffers. */
class GpuBvh {
    constructor(device, bvh, triangleBase) {
        const limit = device.limits.maxStorageBufferBindingSize;
        if (bvh.nodes.byteLength > limit || bvh.triangles.byteLength > limit) {
            throw new Error(`BVH part exceeds maxStorageBufferBindingSize (${limit} bytes): split it, see README.md`);
        }
        if (bvh.triangleCount > MAX_LEAF_TRIANGLE) {
            throw new Error('BVH part has more than 2^24 - 1 triangles: leaves cannot address them, split it');
        }
        this.nodeCount = bvh.nodeCount;
        this.triangleBase = triangleBase;
        this.nodes = this.upload(device, bvh.nodes);
        this.triangles = this.upload(device, bvh.triangles);
    }

    upload(device, data) {
        const buffer = device.createBuffer({ size: Math.max(16, data.byteLength), usage: STORAGE | COPY_DST });
        device.queue.writeBuffer(buffer, 0, data);
        return buffer;
    }

    destroy() {
        this.nodes.destroy();
        this.triangles.destroy();
    }
}

/** Fetches the three shader files next to this module and returns their text. */
export async function fetchShaderSources(base = import.meta.url) {
    const read = async (name) => (await fetch(new URL(name, base))).text();
    const [common, trace, heatmap] = await Promise.all([read('bvh_common.wgsl'), read('trace.wgsl'), read('heatmap.wgsl')]);
    return { common, trace, heatmap };
}

/**
 * Pipelines and BVH buffers for ray-segment tracing and heatmaps.
 */
export class BallisticsGpu {
    /**
     * @param {GPUDevice} device
     * @param {{common: string, trace: string, heatmap: string}} sources - WGSL texts (see fetchShaderSources)
     * @param {Bvh[]} chunks - one BVH, or several that each fit the binding limit; triangle ids are reported
     *   in the concatenation order of the chunks
     * @returns {Promise<BallisticsGpu>}
     * @throws {Error} on any shader compile error or warning (the shaders must compile with zero messages)
     */
    static async create(device, sources, chunks) {
        const gpu = new BallisticsGpu(device, chunks);
        await gpu.compile(sources);
        return gpu;
    }

    constructor(device, chunks) {
        this.device = device;
        this.chunks = [];
        let base = 0;
        for (const chunk of chunks) {
            this.chunks.push(new GpuBvh(device, chunk, base));
            base += chunk.triangleCount;
        }
        /** @type {{module: string, type: string, message: string}[]} compiler messages, empty when clean */
        this.compilerMessages = [];
        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: SHADER_COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: SHADER_COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: SHADER_COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: SHADER_COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: SHADER_COMPUTE, buffer: { type: 'storage' } },
            ],
        });
    }

    async compile(sources) {
        const layout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] });
        const modules = {
            trace: this.device.createShaderModule({ code: `${sources.common}\n${sources.trace}`, label: 'trace.wgsl' }),
            heatmap: this.device.createShaderModule({ code: `${sources.common}\n${sources.heatmap}`, label: 'heatmap.wgsl' }),
        };
        for (const [name, module] of Object.entries(modules)) {
            const info = await module.getCompilationInfo();
            for (const m of info.messages) this.compilerMessages.push({ module: name, type: m.type, message: m.message });
        }
        if (this.compilerMessages.length) {
            throw new Error(`shader compiler messages: ${JSON.stringify(this.compilerMessages)}`);
        }
        const pipeline = (module, entryPoint) => this.device.createComputePipelineAsync({
            layout, compute: { module, entryPoint },
        });
        [this.segmentsPipeline, this.trajectoriesPipeline, this.heatmapPipeline] = await Promise.all([
            pipeline(modules.trace, 'trace_segments'),
            pipeline(modules.trace, 'trace_trajectories'),
            pipeline(modules.heatmap, 'heatmap'),
        ]);
    }

    buffer(size, usage, data) {
        const buffer = this.device.createBuffer({ size: Math.max(16, size), usage });
        if (data) this.device.queue.writeBuffer(buffer, 0, data);
        return buffer;
    }

    /** Packs [p0.xyz, p1.xyz] * n (6 floats per segment) into the shader's two vec4 per segment. */
    packSegments(segments) {
        const n = segments.length / 6;
        const packed = new Float32Array(n * 8);
        for (let i = 0; i < n; i++) {
            packed.set(segments.subarray(6 * i, 6 * i + 3), 8 * i);
            packed.set(segments.subarray(6 * i + 3, 6 * i + 6), 8 * i + 4);
        }
        return packed;
    }

    async read(buffer, size) {
        const staging = this.buffer(size, MAP_READ | COPY_DST);
        const encoder = this.device.createCommandEncoder();
        encoder.copyBufferToBuffer(buffer, 0, staging, 0, size);
        this.device.queue.submit([encoder.finish()]);
        await staging.mapAsync(1);
        const copy = staging.getMappedRange().slice(0);
        staging.destroy();
        return copy;
    }

    static unpackHits(raw, count) {
        const f32 = new Float32Array(raw);
        const u32 = new Uint32Array(raw);
        const out = { count, t: new Float32Array(count), tri: new Uint32Array(count), seg: new Uint32Array(count), point: new Float32Array(count * 3) };
        for (let i = 0; i < count; i++) {
            out.point.set(f32.subarray(8 * i, 8 * i + 3), 3 * i);
            out.t[i] = f32[8 * i + 3];
            out.tri[i] = u32[8 * i + 4];
            out.seg[i] = u32[8 * i + 5];
        }
        return out;
    }

    /**
     * First hit of every segment p0 -> p1 against all chunks.
     * @param {Float32Array} segments - 6 floats per segment: p0.xyz, p1.xyz
     * @returns {Promise<{count: number, t: Float32Array, tri: Uint32Array, seg: Uint32Array, point: Float32Array, elapsedMs: number}>}
     *   t is the segment fraction (1 on a miss), tri the hit triangle in global leaf order (NO_HIT = 0xFFFFFFFF
     *   on a miss), point the hit position (the segment end on a miss), seg the segment's own index
     */
    async traceSegments(segments) {
        const count = segments.length / 6;
        const segmentBuffer = this.buffer(count * SEGMENT_BYTES, STORAGE | COPY_DST, this.packSegments(segments));
        const hitBuffer = this.buffer(count * HIT_BYTES, STORAGE | COPY_SRC | COPY_DST);
        const started = performance.now();
        const encoder = this.device.createCommandEncoder();
        const uniforms = [];
        this.chunks.forEach((chunk, i) => {
            const params = this.buffer(32, UNIFORM | COPY_DST, new Uint32Array([
                count, chunk.nodeCount, i === 0 ? 0 : ACCUMULATE, chunk.triangleBase, 0, 0, 0, 0]));
            uniforms.push(params);
            // Chunks run one after another so each sees the closer hit of the previous ones; the pass
            // boundary orders the read-modify-write of hits[].
            const pass = encoder.beginComputePass();
            pass.setPipeline(this.segmentsPipeline);
            pass.setBindGroup(0, this.bindGroup(params, chunk, segmentBuffer, hitBuffer));
            pass.dispatchWorkgroups(...dispatchSize(count));
            pass.end();
        });
        this.device.queue.submit([encoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();
        const elapsedMs = performance.now() - started;
        const hits = BallisticsGpu.unpackHits(await this.read(hitBuffer, count * HIT_BYTES), count);
        [segmentBuffer, hitBuffer, ...uniforms].forEach((b) => b.destroy());
        return { ...hits, elapsedMs };
    }

    bindGroup(params, chunk, input, output) {
        return this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: params } },
                { binding: 1, resource: { buffer: chunk.nodes } },
                { binding: 2, resource: { buffer: chunk.triangles } },
                { binding: 3, resource: { buffer: input } },
                { binding: 4, resource: { buffer: output } },
            ],
        });
    }

    /**
     * First occluded segment of every trajectory. Uses the first chunk only (a trajectory's segments would
     * otherwise need the closest hit across chunks per segment; see README.md).
     * @param {Float32Array} segments - 6 floats per segment, `segmentsPerTrajectory` consecutive segments per trajectory
     * @param {number} segmentsPerTrajectory
     * @param {number} [endTrimMetres=0] - ignored length at the start of the first and the end of the last segment
     * @returns {Promise<{count: number, t: Float32Array, tri: Uint32Array, seg: Uint32Array, point: Float32Array, elapsedMs: number}>}
     *   seg is the occluded segment index within the trajectory, NO_HIT when the trajectory is clear
     */
    async traceTrajectories(segments, segmentsPerTrajectory, endTrimMetres = 0) {
        if (this.chunks.length !== 1) throw new Error('traceTrajectories needs a single BVH chunk');
        const chunk = this.chunks[0];
        const count = segments.length / 6 / segmentsPerTrajectory;
        const segmentBuffer = this.buffer(count * segmentsPerTrajectory * SEGMENT_BYTES, STORAGE | COPY_DST, this.packSegments(segments));
        const hitBuffer = this.buffer(count * HIT_BYTES, STORAGE | COPY_SRC);
        const params = this.buffer(32, UNIFORM | COPY_DST);
        const view = new DataView(new ArrayBuffer(32));
        [count, chunk.nodeCount, 0, 0, segmentsPerTrajectory].forEach((v, i) => view.setUint32(4 * i, v, true));
        view.setFloat32(20, endTrimMetres, true);
        this.device.queue.writeBuffer(params, 0, view.buffer);

        const started = performance.now();
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.trajectoriesPipeline);
        pass.setBindGroup(0, this.bindGroup(params, chunk, segmentBuffer, hitBuffer));
        pass.dispatchWorkgroups(...dispatchSize(count));
        pass.end();
        this.device.queue.submit([encoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();
        const elapsedMs = performance.now() - started;
        const hits = BallisticsGpu.unpackHits(await this.read(hitBuffer, count * HIT_BYTES), count);
        [segmentBuffer, hitBuffer, params].forEach((b) => b.destroy());
        return { ...hits, elapsedMs };
    }

    /**
     * Firing-position heatmap for one target (heatmap.wgsl). Uses the first chunk only.
     * @param {Object} options
     * @param {[number, number, number]} options.target - world metres
     * @param {number} options.muzzleHeight - muzzle above the ground, m
     * @param {{x: number, y: number, cell: number, width: number, height: number}} options.grid - corner of the
     *   candidate grid, cell size in m, cells per row / column
     * @param {number} options.v0 - muzzle velocity, m/s
     * @param {number} options.gravity - g, m/s^2 (9.80 * the projectile's gravity scale), must be > 0
     * @param {number} [options.distanceScale=500] - D0 of the distance weight D0 / (D0 + distance), m
     * @param {number} [options.endTrim=1] - metres ignored at the muzzle and at the target
     * @param {number} [options.probe=20] - length of the downward clearance probes, m
     * @param {number} [options.chords=32] - chords per trajectory
     * @param {{data: Uint16Array, width: number, height: number, x: number, y: number, texel: number, zMin: number, zMax: number}} options.heightmap
     *   16-bit samples row-major, world position of texel (0, 0), texel size in m, heights of values 0 and 65535
     * @returns {Promise<{cells: Float32Array, elapsedMs: number}>} 2 cells per candidate (low arc, high arc), 4 floats
     *   each: state (0 clear, 1 blocked, 2 unreachable), clearance m, distance weight, path fraction
     */
    async heatmap(options) {
        if (this.chunks.length !== 1) throw new Error('heatmap needs a single BVH chunk');
        const { target, muzzleHeight, grid, v0, gravity, heightmap } = options;
        const { distanceScale = 500, endTrim = 1, probe = 20, chords = 32 } = options;
        if (!(gravity > 0)) throw new Error('gravity must be > 0');
        const chunk = this.chunks[0];
        const candidates = grid.width * grid.height;

        const words = new ArrayBuffer(112);
        new Float32Array(words).set([
            ...target, muzzleHeight,
            grid.x, grid.y, grid.cell, probe,
            v0, gravity, distanceScale, endTrim,
            heightmap.x, heightmap.y, heightmap.texel, heightmap.zMin,
            heightmap.zMax - heightmap.zMin, 0, 0, 0,
        ]);
        new Uint32Array(words, 80).set([grid.width, grid.height, heightmap.width, heightmap.height, chunk.nodeCount, chords, 0, 0]);

        const padded = new Uint16Array(Math.ceil(heightmap.data.length / 2) * 2);
        padded.set(heightmap.data);
        const heightmapBuffer = this.buffer(padded.byteLength, STORAGE | COPY_DST, padded);
        const cellBuffer = this.buffer(candidates * 2 * CELL_BYTES, STORAGE | COPY_SRC);
        const params = this.buffer(112, UNIFORM | COPY_DST, new Uint8Array(words));

        const started = performance.now();
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.heatmapPipeline);
        pass.setBindGroup(0, this.bindGroup(params, chunk, heightmapBuffer, cellBuffer));
        pass.dispatchWorkgroups(...dispatchSize(candidates));
        pass.end();
        this.device.queue.submit([encoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();
        const elapsedMs = performance.now() - started;
        const cells = new Float32Array(await this.read(cellBuffer, candidates * 2 * CELL_BYTES));
        [heightmapBuffer, cellBuffer, params].forEach((b) => b.destroy());
        return { cells, elapsedMs };
    }

    destroy() {
        this.chunks.forEach((chunk) => chunk.destroy());
    }
}

const VCOL_MAGIC = 'VCOL1\0\0\0';
const VCOL_HEADER_BYTES = 40;

/**
 * @typedef {Object} VoxelColumns
 * @property {{minX: number, minY: number, cell: number, dz: number, zMin: number, width: number, height: number}} header
 * @property {Uint32Array} ids - occupied column ids (row * width + column), ascending
 * @property {Uint32Array} first - columnCount + 1 offsets into the runs (in runs, not in numbers)
 * @property {Uint32Array} runs - [start, end) height-index pairs
 */

/**
 * Decodes a `VCOL1` file (layout of tools/volumetric/py/codec.py) into the arrays voxel.wgsl reads.
 * @param {ArrayBuffer|Uint8Array} file - the gzip file, or its decompressed contents
 * @returns {Promise<VoxelColumns>}
 * @throws {Error} if the magic is wrong or the data is truncated
 */
export async function parseVcol(file) {
    let bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    if (bytes.length < VCOL_HEADER_BYTES || new TextDecoder().decode(bytes.subarray(0, 8)) !== VCOL_MAGIC) {
        throw new Error('not a VCOL1 file');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = {
        minX: view.getFloat32(8, true), minY: view.getFloat32(12, true), cell: view.getFloat32(16, true),
        dz: view.getFloat32(20, true), zMin: view.getFloat32(24, true),
        width: view.getUint32(28, true), height: view.getUint32(32, true),
    };
    const columnCount = view.getUint32(36, true);
    let position = VCOL_HEADER_BYTES;
    const varint = () => {
        let value = 0;
        for (let shift = 0; ; shift += 7) {
            if (position >= bytes.length) throw new Error('VCOL1 data ends too early');
            const byte = bytes[position++];
            value += (byte & 0x7f) * 2 ** shift;
            if (byte < 0x80) return value;
        }
    };
    const ids = new Uint32Array(columnCount);
    const first = new Uint32Array(columnCount + 1);
    let runs = new Uint32Array(1 << 20);
    let runCount = 0;
    let id = 0;
    for (let column = 0; column < columnCount; column++) {
        id += varint();
        ids[column] = id;
        first[column] = runCount;
        let end = 0;
        for (let left = varint(); left > 0; left--) {
            const start = end + varint();
            end = start + varint() + 1;
            if (2 * runCount + 2 > runs.length) {
                const grown = new Uint32Array(runs.length * 2);
                grown.set(runs);
                runs = grown;
            }
            runs[2 * runCount] = start;
            runs[2 * runCount + 1] = end;
            runCount++;
        }
    }
    first[columnCount] = runCount;
    return { header, ids, first, runs: runs.slice(0, 2 * runCount) };
}

/** Fetches voxel.wgsl next to this module and returns its text. */
export async function fetchVoxelShader(base = import.meta.url) {
    return (await fetch(new URL('voxel.wgsl', base))).text();
}

/**
 * Pipeline and buffers for tracing segments through voxel columns (voxel.wgsl).
 */
export class VoxelGpu {
    /**
     * @param {GPUDevice} device
     * @param {string} source - the text of voxel.wgsl (see fetchVoxelShader)
     * @param {VoxelColumns} columns - see parseVcol
     * @returns {Promise<VoxelGpu>}
     * @throws {Error} on any shader compile message, or if an array exceeds maxStorageBufferBindingSize
     */
    static async create(device, source, columns) {
        const voxels = new VoxelGpu(device, columns);
        await voxels.compile(source);
        return voxels;
    }

    constructor(device, columns) {
        this.device = device;
        this.header = columns.header;
        this.columnCount = columns.ids.length;
        const limit = device.limits.maxStorageBufferBindingSize;
        for (const array of [columns.ids, columns.first, columns.runs]) {
            if (array.byteLength > limit) throw new Error(`voxel array of ${array.byteLength} bytes exceeds maxStorageBufferBindingSize (${limit})`);
        }
        this.buffers = [columns.ids, columns.first, columns.runs].map((array) => {
            const buffer = device.createBuffer({ size: Math.max(16, array.byteLength), usage: STORAGE | COPY_DST });
            device.queue.writeBuffer(buffer, 0, array);
            return buffer;
        });
        this.bindGroupLayout = device.createBindGroupLayout({
            entries: [
                { binding: 0, visibility: SHADER_COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: SHADER_COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: SHADER_COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: SHADER_COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 4, visibility: SHADER_COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 5, visibility: SHADER_COMPUTE, buffer: { type: 'storage' } },
            ],
        });
    }

    async compile(source) {
        const module = this.device.createShaderModule({ code: source, label: 'voxel.wgsl' });
        /** @type {{type: string, message: string}[]} compiler messages, empty when clean */
        this.compilerMessages = (await module.getCompilationInfo()).messages.map((m) => ({ type: m.type, message: m.message }));
        if (this.compilerMessages.length) throw new Error(`shader compiler messages: ${JSON.stringify(this.compilerMessages)}`);
        this.pipeline = await this.device.createComputePipelineAsync({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
            compute: { module, entryPoint: 'voxel_segments' },
        });
    }

    /**
     * First occupied voxel every segment enters.
     * @param {Float64Array|number[]} segments - 6 numbers per segment (p0.xyz, p1.xyz) in the frame of the file;
     *   the grid origin is subtracted in float64 before the narrowing to f32
     * @returns {Promise<{count: number, t: Float32Array, column: Uint32Array, row: Uint32Array, z: Uint32Array, elapsedMs: number}>}
     *   t is the entry fraction of the segment (1 when clear), column is NO_HIT (0xFFFFFFFF) when clear
     */
    async traceSegments(segments) {
        const count = segments.length / 6;
        const { header } = this;
        const local = new Float32Array(count * 8);
        for (let i = 0; i < count; i++) {
            for (const [k, offset] of [[0, 0], [1, 4]]) {
                local[8 * i + offset] = segments[6 * i + 3 * k] - header.minX;
                local[8 * i + offset + 1] = segments[6 * i + 3 * k + 1] - header.minY;
                local[8 * i + offset + 2] = segments[6 * i + 3 * k + 2] - header.zMin;
            }
        }
        const make = (size, usage, data) => {
            const buffer = this.device.createBuffer({ size: Math.max(16, size), usage });
            if (data) this.device.queue.writeBuffer(buffer, 0, data);
            return buffer;
        };
        const words = new DataView(new ArrayBuffer(32));
        [count, this.columnCount, header.width, header.height].forEach((v, i) => words.setUint32(4 * i, v, true));
        words.setFloat32(16, header.cell, true);
        words.setFloat32(20, header.dz, true);
        const params = make(32, UNIFORM | COPY_DST, new Uint8Array(words.buffer));
        const input = make(count * SEGMENT_BYTES, STORAGE | COPY_DST, local);
        const output = make(count * VOXEL_HIT_BYTES, STORAGE | COPY_SRC);
        const bindGroup = this.device.createBindGroup({
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: params } },
                ...this.buffers.map((buffer, i) => ({ binding: 1 + i, resource: { buffer } })),
                { binding: 4, resource: { buffer: input } },
                { binding: 5, resource: { buffer: output } },
            ],
        });
        const started = performance.now();
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(...dispatchSize(count));
        pass.end();
        const staging = make(count * VOXEL_HIT_BYTES, MAP_READ | COPY_DST);
        encoder.copyBufferToBuffer(output, 0, staging, 0, count * VOXEL_HIT_BYTES);
        this.device.queue.submit([encoder.finish()]);
        await this.device.queue.onSubmittedWorkDone();
        const elapsedMs = performance.now() - started;
        await staging.mapAsync(1);
        const raw = staging.getMappedRange().slice(0);
        [params, input, output, staging].forEach((b) => b.destroy());
        const f32 = new Float32Array(raw);
        const u32 = new Uint32Array(raw);
        const result = { count, t: new Float32Array(count), column: new Uint32Array(count), row: new Uint32Array(count), z: new Uint32Array(count), elapsedMs };
        for (let i = 0; i < count; i++) {
            result.t[i] = f32[4 * i];
            result.column[i] = u32[4 * i + 1];
            result.row[i] = u32[4 * i + 2];
            result.z[i] = u32[4 * i + 3];
        }
        return result;
    }

    destroy() {
        this.buffers.forEach((b) => b.destroy());
    }
}

export { NO_HIT };
