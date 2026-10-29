import { App } from "../app.js";
import { WEAPONS } from "../data/weapons.js";

// Range shown for weapons without gravity (NLAW): they fly straight, beyond the largest map.
const NO_GRAVITY_RANGE = 10000;

export class Weapon {
    constructor(name, deceleration, decelerationTime, gravityScale, minElevation, unit, logo, marker, type, angleType, elevationPrecision, shells = [], heightOffset = 0, angleOffset = 0, projectileLifespan = 100, mod = null, elevationRate = null, heatmap = true, acceleration = 0, accelerationTime = 0, holdElevation = null, ballistics = null, image = null) {
        this.name = name;
        //this.velocity = velocity;
        this.deceleration = deceleration;
        this.decelerationTime = decelerationTime;
        //this.decelerationDistance = this.velocity * this.decelerationTime - 0.5 * this.deceleration * Math.pow(this.decelerationTime, 2);
        this.gravityScale = gravityScale;
        this.minElevation = minElevation;
        this.unit = unit;
        this.logo = logo;
        this.marker = marker;
        this.type = type;
        this.angleType = angleType;
        this.elevationPrecision = elevationPrecision;
        //this.minDistance = minDistance;
        //this.moa = moa;
        //this.maxDistance = this.getMaxDistance();
        //this.hundredDamageRadius = this.calculateDistanceForDamage(maxDamage, startRadius, endRadius, falloff, distanceFromImpact, 100);
        //this.twentyFiveDamageRadius = this.calculateDistanceForDamage(maxDamage, startRadius, endRadius, falloff, distanceFromImpact, 25);
        this.shells = shells;
        this.heightOffset = heightOffset;
        this.angleOffset = angleOffset;
        this.projectileLifespan = projectileLifespan;
        this.mod = mod;
        this.elevationRate = elevationRate;
        this.heatmap = heatmap;
        // Rocket boost (Squad Ballistics model): `acceleration` m/s² during `accelerationTime` s
        this.acceleration = acceleration;
        this.accelerationTime = accelerationTime;
        // [lowest, top] elevations reachable by holding the elevation key (AGS-17)
        this.holdElevation = holdElevation;
        // Name of the same weapon in Squad Ballistics' weapons.json, null if it has none
        this.ballistics = ballistics;
        // Image file name in /img/weapons and /img/markers/weapons
        this.image = image || name;
    }


    /**
     * Calculate the weapon velocity based on the distance to the target.
     * If the projectile has a deceleration phase, the function considers both the deceleration
     * and the post-deceleration velocity. 
     * The deceleration code is black magic produced by https://github.com/Devil4ngle
     * @param {number} [distance] - Distance between the mortar and the target from getDist().
     * @returns {number} - Calculated velocity of the weapon for the given distance.
     */
    getVelocity(distance) {

        if (this.hasBoost()) return this.getBoostVelocity(distance);

        // If there's no deceleration, return the constant velocity
        if (this.decelerationDistance === 0) return this.velocity;
        
        // If the distance is within the deceleration phase
        if (distance <= this.decelerationDistance) {
            const discriminant = Math.sqrt(Math.pow(this.velocity, 2) + 2 * this.deceleration * distance);
            const t = (-this.velocity + discriminant) / this.deceleration;
            return this.velocity - this.deceleration * t;
        } 
        
        // If the distance is beyond the deceleration phase
        const finalVelocity = this.velocity - this.deceleration * this.decelerationTime;
        const distanceAfterDeceleration = distance - this.decelerationDistance;
        const timeAfterDeceleration = distanceAfterDeceleration / finalVelocity;
        const totalTime = this.decelerationTime + timeAfterDeceleration;

        // Calculate the average velocity
        return distance / totalTime;   
    }


    /**
     * Whether the projectile is a rocket boosted by `acceleration` during `accelerationTime`.
     * @returns {boolean}
     */
    hasBoost() {
        return this.accelerationTime > 0 && this.acceleration !== 0;
    }


    /**
     * Equivalent constant velocity over `distance` for a boosted rocket: it accelerates by
     * `acceleration` m/s² during `accelerationTime` s, then keeps its speed.
     * Same model as Weapon.velocity_at in Squad Ballistics (ballistics.py), so both apps give
     * the same elevation.
     * @param {number} distance - Distance to the target in meters.
     * @returns {number} - distance / time of flight, in m/s.
     */
    getBoostVelocity(distance) {
        if (distance <= 0) return this.velocity;

        const a = this.acceleration;
        const boostTime = this.accelerationTime;
        const boostDistance = this.velocity * boostTime + 0.5 * a * boostTime ** 2;
        let time;

        if (distance <= boostDistance) {
            time = (Math.sqrt(Math.max(0, this.velocity ** 2 + 2 * a * distance)) - this.velocity) / a;
        } else {
            time = boostTime + (distance - boostDistance) / (this.velocity + a * boostTime);
        }

        return distance / time;
    }


    /**
     * Longest hold of the elevation key: the time to lower the mount from the top to the
     * bottom of `holdElevation`.
     * @returns {number} - Hold time in seconds, NaN for weapons without `elevationRate`.
     */
    getMaxHoldTime() {
        if (!this.elevationRate) return NaN;
        return this.getHoldTime(this.holdElevation[0]);
    }

    /**
     * Convert an elevation angle into the time the elevation key must be held,
     * for weapons whose mount starts at the top of `holdElevation` and is
     * lowered at a constant `elevationRate` down to its bottom (ex: AGS-17).
     * @param {number} elevationDeg - Elevation angle in degrees, from SquadFiringSolution.
     * @returns {number} - Hold time in seconds; NaN if the weapon has no rate, or the angle
     * is NaN or outside `holdElevation` (the key cannot lay the barrel there).
     */
    getHoldTime(elevationDeg) {
        if (!this.elevationRate) return NaN;

        const [lowest, top] = this.holdElevation;

        if (!(elevationDeg >= lowest && elevationDeg <= top)) return NaN;

        return (top - elevationDeg) / this.elevationRate;
    }


    /**
     * Return the angle factor from 45°
     * @returns {1/-1} -1 = 0-45° / 1 = 45-90°
     */
    getAngleType() {
        if (this.angleType === "high") { return -1; }
        return 1;
    }


    /**
     * Calculate the maximum distance a projectile can travel at a 45° angle.
     * 
     * If no deceleration is specified (`decelerationDistance == 0`), the total distance is simply the 
     * standard maximum range for a projectile with no deceleration, based on the initial velocity.
     *
     * Reference: https://en.wikipedia.org/wiki/Projectile_motion#Maximum_distance_of_projectile
     * 
     * @returns {number} - The maximum distance the projectile can travel.
     */
    getMaxDistance() {

        const gravity = App.gravity * this.gravityScale;

        if (gravity === 0) return NO_GRAVITY_RANGE;

        // Boosted rockets reach a distance while their equivalent velocity v(d) has v(d)² >= g·d
        // (Weapon.max_range in Squad Ballistics)
        if (this.hasBoost()) {
            const reachable = (distance) => this.getBoostVelocity(distance) ** 2 >= gravity * distance;
            let low = 0;
            let high = Math.max(this.velocity, this.velocity + this.acceleration * this.accelerationTime) ** 2 / gravity;

            while (reachable(high)) high *= 2;

            for (let i = 0; i < 60; i++) {
                const mid = (low + high) / 2;
                if (reachable(mid)) low = mid;
                else high = mid;
            }

            return low;
        }

        // If there's no deceleration (anything but UB32)
        if (this.decelerationDistance == 0) {

            // Weapons aimed by key press duration (AGS-17) cannot reach the ideal 45° when
            // their mount stops above it: their range is the one of the lowest hold elevation
            if (this.elevationRate) {
                const angle = Math.max(45, this.holdElevation[0]) * Math.PI / 180;
                return (this.velocity ** 2) * Math.sin(2 * angle) / gravity;
            }

            return (this.velocity ** 2) / gravity;
        }

        // Calculate distance due to deceleration (only the velocity difference part)
        const velocityDifference = this.velocity - (this.velocity - this.deceleration * this.decelerationTime);
        const decelerationDistance = velocityDifference * this.decelerationTime;

        // Calculate distance at constant velocity like if the whole trajectory was at cruise speed
        const finalVelocity = this.velocity - this.deceleration * this.decelerationTime;
        const cruiseDistance = (finalVelocity ** 2) / App.gravity / this.gravityScale;

        // Add both parts of the distance
        return decelerationDistance + cruiseDistance;
    }


    /**
     * Return distance at which will be dealt given damage
     * https://github.com/sh4rkman/SquadCalc/wiki/Deducing-Damage-Radius
     */
    calculateDistanceForDamage(maxDamage, startRadius, endRadius, falloff, distanceFromImpact, targetDamage) {
        const PLAYERSIZE = 1.8;
        const RADIUS = endRadius - (Math.pow(targetDamage / maxDamage, 1 / falloff) * (endRadius - startRadius));
        return Math.sqrt(-Math.pow(distanceFromImpact - PLAYERSIZE, 2 ) + Math.pow(RADIUS, 2));
    }

    /**
     * Updates the shell type for the active weapon 
     * (recalculates damage radiuses / update MOA)
     * @returns {void} 
     */
    changeShell(){
        const SHELL_NUM = $(".dropbtn3").val();
        const WEAPON_NUM = $(".dropbtn2").val();
        const SHELL_DATA = WEAPONS[WEAPON_NUM].shells[SHELL_NUM];

        const explosionParams = [
            SHELL_DATA.explosionDamage,
            SHELL_DATA.explosionRadius[0],
            SHELL_DATA.explosionRadius[1],
            SHELL_DATA.damageFallOff,
            SHELL_DATA.explosionDistanceFromImpact
        ];
    
        // Load Shell data into Weapon
        App.activeWeapon.velocity = SHELL_DATA.velocity;
        App.activeWeapon.decelerationDistance = App.activeWeapon.velocity * App.activeWeapon.decelerationTime - 0.5 * App.activeWeapon.deceleration * Math.pow(App.activeWeapon.decelerationTime, 2);
        App.activeWeapon.minDistance = SHELL_DATA.minDistance;
        App.activeWeapon.moa = SHELL_DATA.moa;
        App.activeWeapon.maxDistance = this.getMaxDistance();
        App.activeWeapon.hundredDamageRadius = App.activeWeapon.calculateDistanceForDamage(...explosionParams, 100);
        App.activeWeapon.twentyFiveDamageRadius = App.activeWeapon.calculateDistanceForDamage(...explosionParams, 25);
        App.activeWeapon.moa = SHELL_DATA.moa;
        // Raw explosion of the shell for the damage with cover (squadDamage.js); radii in meters
        App.activeWeapon.explosion = {
            damage: SHELL_DATA.explosionDamage,
            inner: SHELL_DATA.explosionRadius[0],
            outer: SHELL_DATA.explosionRadius[1],
            falloff: SHELL_DATA.damageFallOff,
            distanceFromImpact: SHELL_DATA.explosionDistanceFromImpact,
        };

        // Update Existsing Targets on Minimap
        App.minimap.updateTargets();
        App.minimap.updateWeapons();
    }

}