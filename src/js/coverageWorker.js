/**
 * Fire coverage worker (squadCoverage.js): classifies the cells of the rays the page samples, off the main
 * thread; the page starts several, each one classifying every n-th ray. The page owns the heightmap, so it
 * sends the terrain of each ray.
 *
 * Messages in, in this order:
 *   - `{init}`: the computation's parameters (squadCoverageRays.computeCoverageRays without `heightAt`
 *     and `inside`); the highest trajectory of every target distance is searched here;
 *   - `{first, size, profiles, targetHeights}` for each batch of rays (squadCoverageRays.createRaySampler):
 *     `size` rays from `first`, each one `samples` profile heights and `stride` target heights;
 *   - `{finish}` after the last batch.
 * Messages out: `{recycled}` after each batch, the buffers sent back for the page to fill again; and after
 * `finish` `{values}` (transferred), the COVERAGE value of every cell of every ray, as computeCoverageRays
 * fills them (the rays this worker did not get stay 0).
 */
import { computeCoveragePeaks, createRayClassifier } from "./squadCoverageRays.js";

let params = null;
let classifier = null;
let values = null;

onmessage = ({ data }) => {
    if (data.init) {
        params = data.init;
        const peaks = computeCoveragePeaks(params).peaks;
        classifier = createRayClassifier({ ...params, peaks });
        values = new Uint8Array(params.rays * classifier.stride);
    } else if (data.finish) {
        postMessage({ values }, [values.buffer]);
    } else {
        const { samples, stride } = classifier;
        for (let k = 0; k < data.size; k++) {
            classifier.classify(data.first + k, data.profiles.subarray(k * samples, (k + 1) * samples), data.targetHeights.subarray(k * stride, (k + 1) * stride), values);
        }
        const recycled = { profiles: data.profiles, targetHeights: data.targetHeights };
        postMessage({ recycled }, [recycled.profiles.buffer, recycled.targetHeights.buffer]);
    }
};
