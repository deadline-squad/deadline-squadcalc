import { App } from "../app.js";
import { WEAPONS } from "../data/weapons.js";
import { axisBoostTime, maxRange } from "./squadBallistics.js";

// Range shown for weapons without gravity (NLAW): they fly straight, beyond the largest map.
const NO_GRAVITY_RANGE = 10000;

export class Weapon {
    constructor(name, deceleration, decelerationTime, gravityScale, minElevation, unit, logo, marker, type, angleType, elevationPrecision, shells = [], heightOffset = 0, angleOffset = 0, projectileLifespan = 100, mod = null, elevationRate = null, heatmap = true, acceleration = 0, accelerationTime = 0, holdElevation = null, ballistics = null, image = null, muzzle = null, maxSpeed = 0, rotationFollowsVelocity = true, legacyBallistics = [], ballisticsViews = [], legacyBallisticsViews = {}) {
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
        // Launch point moving with the elevation, from the weapon's skeleton (weapons.js), or null:
        // the projectile starts heightOffset above the ground. {pivotHeight, forward, up} in meters
        this.muzzle = muzzle;
        // The projectile's speed cap in m/s (MaxSpeed of its movement component; 0: none): a shell fired
        // faster is slowed to it at once, a motor holds a rocket at it (squadBallistics.js)
        this.maxSpeed = maxSpeed;
        // The motor pushes along the path (the game's bRotationFollowsVelocity), or along the barrel's
        // axis at launch when false (UB-32)
        this.rotationFollowsVelocity = rotationFollowsVelocity;
        // Names this weapon had in Squad Ballistics before it was renamed (the RMB sights got their view in
        // the name): `selectBallisticsWeapon` still finds it by them, so an older Squad Ballistics works
        this.legacyBallistics = legacyBallistics;
        // Names of the other views of this weapon in Squad Ballistics' weapons.json (the zoom levels of a
        // gunner's sight, the normal view next to an optic): they differ in what its overlay draws, the
        // firing solution is this weapon's. `selectBallisticsWeapon` finds it by them and reports them back
        this.ballisticsViews = ballisticsViews;
        // Names those views had in Squad Ballistics before they were renamed, old name -> the view's name:
        // `selectBallisticsWeapon` finds this weapon by an old one and reports the view
        this.legacyBallisticsViews = legacyBallisticsViews;
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
     * Equivalent constant velocity over `distance` for a boosted rocket flying straight along the
     * barrel: it accelerates by `acceleration` m/s² during the motor's burn time (whole steps, not
     * `accelerationTime`, ended by the cap in a flight without gravity: axisBoostTime in squadBallistics.js),
     * then keeps its speed, held at `maxSpeed`. Same as Weapon.velocity_at in Squad Ballistics (ballistics.py). Only the
     * spread uses it: the elevation, time of flight and range come from the trajectory (getShot,
     * squadBallistics.js).
     * @param {number} distance - Distance to the target in meters.
     * @returns {number} - distance / time of flight, in m/s.
     */
    getBoostVelocity(distance) {
        if (distance <= 0) return this.velocity;

        const a = this.acceleration;
        const boostTime = axisBoostTime(this.getShot());
        const boostDistance = this.velocity * boostTime + 0.5 * a * boostTime ** 2;
        let cruise = this.velocity + a * boostTime;
        if (this.maxSpeed) cruise = Math.min(cruise, this.maxSpeed);
        let time;

        if (distance <= boostDistance) {
            time = 2 * distance / (this.velocity + Math.sqrt(Math.max(0, this.velocity ** 2 + 2 * a * distance)));
        } else {
            time = boostTime + (distance - boostDistance) / cruise;
        }

        return distance / time;
    }


    /**
     * How the weapon fires, for squadBallistics.js
     * @param {number} [gravity] - m/s², default the world gravity × this weapon's gravity scale
     * @param {number} [launchHeight] - launch height above the ground in meters for weapons without
     *   `muzzle`, default heightOffset (the obstacle checks launch handheld weapons from the shoulder)
     * @returns {import("./squadBallistics.js").Shot}
     */
    getShot(gravity = App.gravity * this.gravityScale, launchHeight = this.heightOffset) {
        const boosted = this.hasBoost();
        return {
            velocity: this.velocity,
            gravity,
            acceleration: boosted ? this.acceleration : 0,
            boostTime: boosted ? this.accelerationTime : 0,
            maxSpeed: this.maxSpeed || 0,
            rotationFollowsVelocity: this.rotationFollowsVelocity !== false,
            pivotHeight: this.muzzle ? this.muzzle.pivotHeight : launchHeight,
            muzzleForward: this.muzzle ? this.muzzle.forward : 0,
            muzzleUp: this.muzzle ? this.muzzle.up : 0,
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

        // The searches of maxRange cost milliseconds and this is asked on every drag event, weapon change
        // and coverage: kept until the gravity or the shell's velocity (the only inputs that change) does
        const key = `${gravity}|${this.velocity}`;
        if (this.maxDistanceKey !== key) {
            this.maxDistanceKey = key;
            this.maxDistanceValue = this.computeMaxDistance(gravity);
        }
        return this.maxDistanceValue;
    }


    /**
     * The range of getMaxDistance, computed
     * @param {number} gravity - world gravity times the projectile's gravity scale
     * @returns {number} - meters
     */
    computeMaxDistance(gravity) {

        if (gravity === 0) return NO_GRAVITY_RANGE;

        // Launch point moving with the elevation, boosted rockets, or shells fired faster than their cap:
        // the exact trajectory (squadBallistics.maxRange), from the muzzle or else from the ground
        if (this.muzzle) return maxRange(this.getShot(gravity));
        if (this.hasBoost() || (this.maxSpeed && this.velocity > this.maxSpeed)) return maxRange(this.getShot(gravity, 0));

        // Weapons aimed by key press duration (AGS-17) cannot reach the ideal 45° when
        // their mount stops above it: their range is the one of the lowest hold elevation
        if (this.elevationRate) {
            const angle = Math.max(45, this.holdElevation[0]) * Math.PI / 180;
            return (this.velocity ** 2) * Math.sin(2 * angle) / gravity;
        }

        return (this.velocity ** 2) / gravity;
    }


    /**
     * Return distance at which will be dealt given damage (0 when the explosion never deals it)
     * https://github.com/sh4rkman/SquadCalc/wiki/Deducing-Damage-Radius
     */
    calculateDistanceForDamage(maxDamage, startRadius, endRadius, falloff, distanceFromImpact, targetDamage) {
        // An explosion weaker than the damage asked for (the SMAW's tandem warhead: 80) never deals it
        if (targetDamage > maxDamage) return 0;

        const PLAYERSIZE = 1.8;
        const RADIUS = endRadius - (Math.pow(targetDamage / maxDamage, 1 / falloff) * (endRadius - startRadius));
        // The distance to the soldier's head cannot be below the explosion's height: no zone at all
        return Math.sqrt(Math.max(0, Math.pow(RADIUS, 2) - Math.pow(distanceFromImpact - PLAYERSIZE, 2)));
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
        App.activeWeapon.shellName = SHELL_DATA.name;
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
        App.minimap.activeMarkers.eachLayer((marker) => marker.refreshStructurePopup?.());
    }

}
