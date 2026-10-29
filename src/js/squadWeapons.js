import { App } from "../app.js";
import { WEAPONS } from "../data/weapons.js";
import { maxRange } from "./squadBallistics.js";

// Range shown for weapons without gravity (NLAW): they fly straight, beyond the largest map.
const NO_GRAVITY_RANGE = 10000;

export class Weapon {
    constructor(name, deceleration, decelerationTime, gravityScale, minElevation, unit, logo, marker, type, angleType, elevationPrecision, shells = [], heightOffset = 0, angleOffset = 0, projectileLifespan = 100, mod = null, elevationRate = null, heatmap = true, acceleration = 0, accelerationTime = 0, holdElevation = null, ballistics = null, image = null) {
        this.name = name;
        this.deceleration = deceleration;
        this.decelerationTime = decelerationTime;
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
        // Rocket boost (Squad Ballistics model): `acceleration` m/s² during `accelerationTime` s.
        // A deceleration phase (UB-32 S-5 rockets: 50 m/s² for 2 s) is the same model with a negative
        // acceleration, as in Squad Ballistics' weapons.json and the game (ConstantAcceleration < 0)
        if (!acceleration && deceleration && decelerationTime) {
            acceleration = -deceleration;
            accelerationTime = decelerationTime;
        }
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
     * Velocity of the weapon over the distance to the target: the muzzle velocity, or for a boosted
     * or decelerating rocket the equivalent constant velocity (getBoostVelocity).
     * @param {number} [distance] - Distance between the weapon and the target from getDist().
     * @returns {number} - Velocity in m/s.
     */
    getVelocity(distance) {
        if (this.hasBoost()) return this.getBoostVelocity(distance);
        return this.velocity;
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
     * Same as Weapon.velocity_at in Squad Ballistics (ballistics.py). Only the spread uses it: the
     * elevation, time of flight and range come from the exact trajectory (getShot, squadBallistics.js).
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
     * How the weapon fires, for squadBallistics.js
     * @param {number} [gravity] - m/s², default the world gravity × this weapon's gravity scale
     * @param {number} [launchHeight] - pivot height above the ground in meters, default heightOffset
     *   (the obstacle checks launch handheld weapons from the shoulder)
     * @returns {import("./squadBallistics.js").Shot}
     */
    getShot(gravity = App.gravity * this.gravityScale, launchHeight = this.heightOffset) {
        const boosted = this.hasBoost();
        return {
            velocity: this.velocity,
            gravity,
            acceleration: boosted ? this.acceleration : 0,
            boostTime: boosted ? this.accelerationTime : 0,
            pivotHeight: launchHeight,
            muzzleForward: 0,
            muzzleUp: 0,
        };
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
     * Calculate the maximum distance a projectile can travel on flat ground (45° without boost).
     *
     * Reference: https://en.wikipedia.org/wiki/Projectile_motion#Maximum_distance_of_projectile
     * 
     * @returns {number} - The maximum distance the projectile can travel.
     */
    getMaxDistance() {

        const gravity = App.gravity * this.gravityScale;

        if (gravity === 0) return NO_GRAVITY_RANGE;

        // Boosted rockets: the exact trajectory, from the ground (squadBallistics.maxRange)
        if (this.hasBoost()) return maxRange(this.getShot(gravity, 0));

        // Weapons aimed by key press duration (AGS-17) cannot reach the ideal 45° when
        // their mount stops above it: their range is the one of the lowest hold elevation
        if (this.elevationRate) {
            const angle = Math.max(45, this.holdElevation[0]) * Math.PI / 180;
            return (this.velocity ** 2) * Math.sin(2 * angle) / gravity;
        }

        return (this.velocity ** 2) / gravity;
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