import { App } from "../app.js";
import { MUZZLE_CLEARANCE, SHOULDER_HEIGHT, TARGET_CLEARANCE } from "./squadCoverage.js";
import { heightAt, pathAt, solveElevation, trajectory } from "./squadBallistics.js";

// Largest distance between two points checked for an obstacle, in meters: the heightmap's sample spacing
// (SquadHeightmap.resolution) when that is finer, so a wall between two samples of the 0.5 m maps is not skipped
const OBSTACLE_STEP = 1;

export default class SquadFiringSolution {

    /**
     * @param {LatLng} weaponLatLng - weapon position
     * @param {LatLng} targetLatLng - point aimed at
     * @param {squadMinimap} map
     * @param {number|string} heightPadding - weapon height above the ground, meters
     * @param {LatLng} [heightLatLng=targetLatLng] - point whose ground height the shell must land at:
     *   the target when the aim is moved off it to correct the fire (squadTargetMarker.getAimLatLng)
     */
    constructor(weaponLatLng, targetLatLng, map, heightPadding, heightLatLng = targetLatLng) {
        this.map = map;
        this.activeWeapon = App.activeWeapon;
        this.weaponLatLng = weaponLatLng;
        this.targetLatLng = targetLatLng;
        this.moa = this.degToRad((App.activeWeapon.moa) / 60);
        this.gravity = App.gravity * App.activeWeapon.gravityScale;
        this.distance = this.getDist();
        this.bearing = this.getBearing(this.weaponLatLng, this.targetLatLng);
        // Equivalent constant velocity over the distance, for the spread; the trajectory itself is `shot`
        this.velocity = App.activeWeapon.getVelocity(this.distance);
        this.shot = App.activeWeapon.getShot(this.gravity);
        this.weaponHeight = this.map.heightmap.getHeight(weaponLatLng) + parseFloat(heightPadding);
        this.targetHeight = this.map.heightmap.getHeight(heightLatLng);
        // False while the heightmap loads and when it failed to load: both heights are 0, the solution is
        // for flat ground
        this.hasHeightData = this.map.heightmap.jsonPng.length > 0 && !this.map.heightmap.failed;
        this.heightDiff =  this.targetHeight - this.weaponHeight;
        // Both elevations of the trajectory of `shot`, found once
        this.roots = this.gravity === 0 ? null : solveElevation(this.shot, this.distance, this.heightDiff);
        this.elevation = {low: [], high: []};
        this.elevation.low.rad = this.getElevation(this.distance, true);
        this.elevation.low.deg = this.radToDeg(this.elevation.low.rad);
        this.elevation.low.mil = this.radToMil(this.elevation.low.rad);
        this.elevation.high.rad = this.getElevation(this.distance, false);
        this.elevation.high.deg = this.radToDeg(this.elevation.high.rad);
        this.elevation.high.mil = this.radToMil(this.elevation.high.rad);
        this.timeOfFlight = {low: [], high: []};
        this.timeOfFlight.low = this.getTimeOfFlight(this.elevation.low.rad);
        this.timeOfFlight.high = this.getTimeOfFlight(this.elevation.high.rad);
        this.spreadParameters = {low: [], high: []};
        this.spreadParameters.low = this.getSpreadParameter(this.elevation.low.rad, this.timeOfFlight.low);
        this.spreadParameters.high = this.getSpreadParameter(this.elevation.high.rad, this.timeOfFlight.high);

        // A projectile that dies in the air before landing has no solution, whatever the unit displayed
        for (const angleType of ["low", "high"]) {
            if (this.timeOfFlight[angleType] > App.activeWeapon.projectileLifespan) {
                this.elevation[angleType].rad = this.elevation[angleType].deg = this.elevation[angleType].mil = NaN;
            }
        }

        this.holdTime = {low: [], high: []};
        this.holdTime.low = App.activeWeapon.getHoldTime(this.elevation.low.deg);
        this.holdTime.high = App.activeWeapon.getHoldTime(this.elevation.high.deg);

        // Weapons laid by holding a key (AGS-17) only lob on the angles the key can reach
        if (App.activeWeapon.elevationRate && isNaN(this.holdTime.high)) {
            this.elevation.high.rad = this.elevation.high.deg = this.elevation.high.mil = NaN;
        }

        this.obstacle = {
            low: isNaN(this.elevation.low.rad) ? null : this.getObstacle(true),
            high: isNaN(this.elevation.high.rad) ? null : this.getObstacle(false),
        };
    }


    /**
     * First point where the trajectory to the target passes under the heightmap, which holds the
     * terrain and the buildings: the shell hits it before the target. The trajectory (squadBallistics
     * pathAt) starts at the real muzzle (the weapon's `muzzle` model, else `heightOffset` above the
     * weapon, else the shoulder), and is aimed to reach the target from there, like the fire coverage;
     * it skips the same clearances.
     * @param {boolean} lowAngle - the low trajectory (else the high one)
     * @returns {{distance: number, height: number}|null} - distance from the weapon and height of the
     * obstacle above the weapon, in meters; null if the trajectory is clear, cannot reach the target
     * from the muzzle, or no heightmap is loaded
     */
    getObstacle(lowAngle) {
        if (!this.map.heightmap?.jsonPng?.length) return null;

        const weapon = App.activeWeapon;
        const shouldered = !weapon.muzzle && !(weapon.heightOffset > 0);
        const shot = shouldered ? weapon.getShot(this.gravity, SHOULDER_HEIGHT) : this.shot;
        let angle;

        if (this.gravity === 0) {
            angle = Math.atan2(this.heightDiff - shot.pivotHeight, this.distance);
        } else {
            // The shoulder-high muzzle is another trajectory: solved here, once for the two arcs
            if (shouldered && !this.shoulderRoots) this.shoulderRoots = solveElevation(shot, this.distance, this.heightDiff);
            const elevations = shouldered ? this.shoulderRoots : this.roots;
            angle = lowAngle ? elevations.low : elevations.high;
            if (isNaN(angle)) return null;
        }

        const latStep = (this.targetLatLng.lat - this.weaponLatLng.lat) / this.distance;
        const lngStep = (this.targetLatLng.lng - this.weaponLatLng.lng) / this.distance;

        const path = trajectory(shot, angle);

        const obstacleStep = Math.min(OBSTACLE_STEP, this.map.heightmap.resolution || OBSTACLE_STEP);
        for (let x = MUZZLE_CLEARANCE; x <= this.distance - TARGET_CLEARANCE; x += obstacleStep) {
            const ground = this.map.heightmap.getHeight({
                lat: this.weaponLatLng.lat + latStep * x,
                lng: this.weaponLatLng.lng + lngStep * x,
            });
            if (this.weaponHeight + path.height(x) < ground) {
                return { distance: x, height: ground - this.weaponHeight };
            }
        }
        return null;
    }


    /**
     * Calculate ingame distance between weapon & target, each map axis with its own scale
     * (squadMinimap.toMeters)
     * https://github.com/sh4rkman/SquadCalc/wiki/Deducing-distance-and-bearing#finding-distance
     * @return {number} - horizontal distance in meters
     */
    getDist(){
        const { east, north } = this.map.toMeters(this.weaponLatLng, this.targetLatLng);
        return Math.hypot(east, north);
    }

    /**
     * Calculates the angle the mortar needs to be set in order
     * to hit the target at the desired distance and vertical delta.
     * NaN also for a target on the weapon (no distance) or at an unknown height.
     * https://github.com/sh4rkman/SquadCalc/wiki/Deducing-Elevation
     * @param {number} [dist] - distance between mortar and target from getDist()
     * @param {boolean} [lowangle] - "high" or "low" angle
     * @returns {number || NaN} radian angle if target in range, NaN otherwise
    */
    getElevation(dist = 0, lowangle = false) {
        let elevation;

        if (this.gravity === 0) {
            // No gravity (NLAW): straight at the target, both "arcs" are the line of sight
            if (!(dist > 0) || !Number.isFinite(this.heightDiff)) return NaN;
            elevation = Math.atan2(this.heightDiff - App.activeWeapon.heightOffset, dist) - this.degToRad(App.activeWeapon.angleOffset);
            return this.isInElevationRange(elevation) ? elevation : NaN;
        }

        // Exact trajectory: the closed-form parabola, or the boost model solved numerically (the solution of
        // the constructor's target, else a new one)
        const { low, high } = dist === this.distance && this.roots ? this.roots : solveElevation(this.shot, dist, this.heightDiff);
        elevation = (lowangle ? low : high) - this.degToRad(App.activeWeapon.angleOffset);

        return this.isInElevationRange(elevation) ? elevation : NaN;
    }


    /**
     * Elevation above the line of sight to the target, the angle a direct-fire weapon is aimed with
     * (sight scale, Squad Ballistics overlay mark): the target is seen atan(rise / distance) above the
     * horizon from the muzzle, so aiming at it already gives that part of the elevation.
     * Same as Solution.sight_angle in Squad Ballistics (ballistics.py).
     * @param {number} elevation - elevation in radians
     * @returns {number} - degrees, NaN if the elevation is NaN
     */
    getSightAngle(elevation) {
        const lineOfSight = Math.atan2(this.heightDiff - App.activeWeapon.heightOffset, this.distance);
        return this.radToDeg(elevation - lineOfSight);
    }


    /**
     * Whether the weapon can be laid at this elevation
     * @param {number} elevation - elevation in radians
     * @returns {boolean} - true inside the weapon's minElevation range
     */
    isInElevationRange(elevation) {
        const degrees = this.radToDeg(elevation);
        return degrees >= App.activeWeapon.minElevation[0] && degrees <= App.activeWeapon.minElevation[1];
    }


    /**
     * Calculates the bearing required to see the target from the weapon, each map axis with its own
     * scale (squadMinimap.toMeters).
     * https://github.com/sh4rkman/SquadCalc/wiki/Deducing-distance-and-bearing#finding-bearing
     * @returns {number} - bearing in degrees, clockwise from north, in [0, 360)
     */
    getBearing() {
        const { east, north } = this.map.toMeters(this.weaponLatLng, this.targetLatLng);
        let bearing = Math.atan2(east, north) * 180 / Math.PI;
        if (bearing < 0) { bearing += 360; } // Avoid Negative Angle by adding a whole rotation
        return bearing;
    }

    
    /**
     * Calculates the horizontal distance a projectile will travel given a launch angle,
     * initial velocity, and vertical height difference between origin and target.
     * 
     * This function solves the vertical motion equation using the quadratic formula
     * to find the total flight time (t) required to reach the specified height difference.
     * It then uses that time to compute the horizontal distance.
     * 
     * VERY imprecise at low angles and high heights diff
     * 
     * @param {number} angle - Launch angle in degrees (from horizontal).
     * @returns {number} Horizontal distance the projectile will travel (in meters).
     */
    getProjectileDistance(angle) {
        if (App.activeWeapon.name === "Tech.Mortar") angle += 5;

        const angleRad = angle * Math.PI / 180;
        const vx = this.velocity * Math.cos(angleRad);
        const vy = this.velocity * Math.sin(angleRad);

        const a = 0.5 * this.gravity;
        const b = -vy;
        const c = this.heightDiff;

        const discriminant = b * b - 4 * a * c;

        if (discriminant < 0) return 0; // No real solution, target unreachable

        const sqrtDisc = Math.sqrt(discriminant);
        const denom = 2 * a;
        const t1 = (-b + sqrtDisc) / denom;
        const t2 = (-b - sqrtDisc) / denom;

        const t = t1 > 0 ? t1 : (t2 > 0 ? t2 : 0);
        if (t < 0) return 0;

        const distance = vx * t;
        return Math.max(0, distance);
    }


    /**
     * Calculate Axises and angle for spread ellipse
     * @param {number} [elevation] - Elevation angle in radian
     * @param {number} [timeOfFlight] - Time of flight in seconds
     * @returns {object} [semiMajorAxis, semiMinorAxis, ellipseAngle]
     */
    getSpreadParameter(elevation, timeOfFlight){
        return  {
            semiMajorAxis: this.getHorizontalSpread(timeOfFlight),
            semiMinorAxis: this.getVerticalSpread(elevation, this.velocity),
            ellipseAngle: (elevation * (180 / Math.PI))
        };
    }


    /**
     * Semi-axes of the ground ellipse the rounds of the weapon's cone land in, for the hit probability
     * (the drawn ellipse has twice these, getSpreadParameter). A plain parabola uses the closed form of
     * getSpreadParameter. A shot with a motor or a speed cap (rockets, tank and autocannon shells) is not
     * one: its speed is not constant, so the closed form misjudges the range spread (SPG-9 at 400 m:
     * 16.9 m against 8.1 m). Its semi-axes come from the trajectory itself: the range error of the cone's
     * top and bottom (the barrel raised and lowered by the half-angle), and the sideways error of the cone's
     * side, which at the landing distance d, with the barrel at elevation e, is d·tan(half-angle)/cos(e)
     * (the sideways component of the cone's edge is sin(half-angle), the forward one cos(half-angle)·cos(e)).
     * @param {string} arc - "low" or "high"
     * @returns {{lateral: number, along: number}} - semi-axes across and along the line of fire, meters
     */
    getHitSpread(arc) {
        const spread = this.spreadParameters[arc];
        const closedForm = { lateral: (spread.semiMajorAxis || 0) / 2, along: (spread.semiMinorAxis || 0) / 2 };
        if (!this.shot.acceleration && !this.shot.maxSpeed) return closedForm;

        const elevation = this.elevation[arc].rad + this.degToRad(App.activeWeapon.angleOffset);
        const halfAngle = this.moa / 2;
        const landing = (angle) => this.getLandingDistance(angle);
        const top = landing(elevation + halfAngle);
        const bottom = landing(elevation - halfAngle);
        if (isNaN(top) || isNaN(bottom)) return closedForm;

        return {
            lateral: this.distance * Math.tan(halfAngle) / Math.cos(elevation),
            along: Math.abs(top - bottom) / 2,
        };
    }


    /**
     * Horizontal distance at which a shot laid at `angle` comes down to the target's height, searching
     * around the target's distance (the landing of the cone's top and bottom is close to it)
     * @param {number} angle - barrel elevation in radians
     * @returns {number} - meters from the pivot, NaN if the shot does not come down there
     */
    getLandingDistance(angle) {
        const above = (distance) => heightAt(this.shot, angle, distance) - this.heightDiff;
        let low = this.distance;
        let high = this.distance;
        let step = Math.max(1, this.distance / 100);

        // Widen the bracket until the shot is above the target's height at `low` and below it at `high`
        for (let i = 0; i < 20 && (above(low) <= 0 || above(high) >= 0); i++) {
            if (above(low) <= 0) low = Math.max(0, low - step);
            if (above(high) >= 0) high += step;
            step *= 1.5;
        }
        if (above(low) <= 0 || above(high) >= 0) return NaN;

        for (let i = 0; i < 60; i++) {
            const middle = (low + high) / 2;
            if (above(middle) > 0) low = middle;
            else high = middle;
        }
        return (low + high) / 2;
    }


    /**
     * Radius of the spread ellipse in a given compass direction, relative
     * to the firing bearing the ellipse is rotated to on the map.
     * @param {number} bearingDeg - direction to measure the radius in, in degrees
     * @param {string} angleType - "high" or "low"
     * @returns {number} - spread radius in meters in that direction
     */
    getSpreadRadiusAtBearing(bearingDeg, angleType) {
        const sp = angleType === "high" ? this.spreadParameters.high : this.spreadParameters.low;
        const a = isNaN(sp.semiMajorAxis) ? 50 : sp.semiMajorAxis;
        const b = isNaN(sp.semiMinorAxis) ? 50 : sp.semiMinorAxis;
        const theta = this.degToRad(bearingDeg - this.bearing);
        let r = (a * b) / Math.sqrt((a * Math.cos(theta)) ** 2 + (b * Math.sin(theta)) ** 2);
        if (isNaN(r)) r = 0;
        return r;
    }


    /**
     * Calculates the horizontal spread for a given trajectory path length 
     * @param {number} [timeOfFlight] - Time of flight in seconds
     * @returns {number} - Length of horizontal spread in meters
     */
    getHorizontalSpread(timeOfFlight){
        const horizontalVelocity = Math.sin(this.moa) * this.velocity;
        const horizontalSpread = horizontalVelocity * timeOfFlight;
        return Math.max(0, horizontalSpread);
    }


    /**
     * Calculates the vertical spread of a projectile
     * to hit the target at the desired distance and vertical delta.
     * https://github.com/sh4rkman/SquadCalc/wiki/Deducing-Spread#vertical-spread
     * @param {number} [angle] - angle of the initial shot
     * @returns {number} - vertical spread in meter
     */
    getVerticalSpread(angle){
        // No dispersion, or no gravity to turn it into a range error (direct-fire weapons)
        if (this.moa === 0 || this.gravity === 0) return 0;

        const verticalSpread1 = (this.velocity ** 2 * Math.sin(2*(angle + (this.moa/2)))) / this.gravity;
        const verticalSpread2  = (this.velocity ** 2 * Math.sin(2*(angle - (this.moa/2)))) / this.gravity;
        const totalSpread = Math.abs(verticalSpread2 - verticalSpread1);
        return Math.max(0, totalSpread);
    }


    /**
     * Calculate the time of flight of the projectile to the target: the time the exact trajectory
     * (squadBallistics pathAt) takes to cover the distance, on the way up for a direct shot at a
     * target above, on the way down for a lob
     * https://github.com/sh4rkman/SquadCalc/wiki/Deducing-Time-Of-Flight
     * @param {number} [angle] - elevation of the solution in radians (angleOffset subtracted)
     * @returns {number} - time of flight in seconds, NaN for a NaN angle
     */
    getTimeOfFlight(angle){
        // Without gravity the projectile flies the straight line of sight
        if (this.gravity === 0) {
            const path = this.distance / Math.cos(angle);
            return path / App.activeWeapon.getVelocity(path);
        }

        return pathAt(this.shot, angle + this.degToRad(App.activeWeapon.angleOffset), this.distance).time;
    }


    /**
     * Converts radians into degrees
     * @param {number} rad - radians
     * @returns {number} degrees
     */
    radToDeg(rad){
        return (rad * 180) / Math.PI;
    }


    /**
     * Converts radians into NATO mils
     * @param {number} rad - radians
     * @returns {number} NATO mils
     */
    radToMil(rad){
        return this.degToMil(this.radToDeg(rad));
    }


    /**
     * Converts degrees to radians
     * @param {number} deg - degrees
     * @returns {number} radians
     */
    degToRad(deg){
        return (deg * Math.PI) / 180;
    }


    /**
     * Converts degrees into NATO mils
     * @param {number} deg - degrees
     * @returns {number} NATO mils
     */
    degToMil(deg){
        return deg / (360 / 6400);
    }
    
    /**
     * Converts NATO mils into degrees
     * @param {number} mil - NATO mils
     * @returns {number} degrees
     */
    milToDeg(mil){
        return mil * (360 / 6400);
    }

}
