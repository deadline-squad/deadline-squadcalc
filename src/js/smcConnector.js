import { App } from "../app.js";

let prevCoorArray = "";
let isConnecting = false;
let socketMap = null;
let socketCoordinates = null;
let connectionInterval = null;

/**
 * Initializes WebSocket connections for map and coordinate data communication
 * Creates two WebSocket connections - one for map data and one for coordinates
 * Handles connection events and data transfer between client and SquadMortarOverlay.exe
 * @returns {Promise<void>} A promise that resolves when initialization is complete
 */
export async function initWebSocket() {
    if (process.env.SMO_WEBSOCKET != "true") return;
    if (isConnecting) return;
    startConnectionAttempts();
}

/**
 * Starts the connection attempt cycle
 */
function startConnectionAttempts() {
    if (!isConnecting) {
        isConnecting = true;
        cleanup();
        connectionInterval = setInterval(async () => {
            const isAvailable = await checkServerAvailability();
            if (isAvailable) await setupWebSockets();
        }, 5000);
    }
}

/**
 * Cleans up existing connections and intervals
 */
function cleanup() {
    if (socketMap) socketMap.close();
    if (socketCoordinates) socketCoordinates.close();
    if (connectionInterval) clearInterval(connectionInterval);
    socketMap = null;
    socketCoordinates = null;
}

/**
 * Sets up WebSocket connections and their event listeners
 */
async function setupWebSockets() {
    try {
        socketMap = new WebSocket("ws://127.0.0.1:12345");
        socketCoordinates = new WebSocket("ws://127.0.0.1:12346");

        setInterval(() => checkCoordinates(socketCoordinates), 1000);

        socketMap.addEventListener("open", () => {
            console.log("Connected to SquadMortarOverlay.exe");
            App.openToast("success", "connectedTo", "squadMortarOverlay");
            isConnecting = false;
            clearInterval(connectionInterval);

            // HD Maps are not compatible with squadmortaroverlay
            if ($(".btn-hd").hasClass("active")) {
                App.userSettings.highQualityImages = false;
                $(".btn-hd").removeClass("active");
                App.minimap.spin(false);
                App.minimap.changeLayer();
            }
            $(".btn-hd").prop("disabled", true);
        });

        socketMap.addEventListener("message", async (event) => {

            if (event.data === "Map" && socketMap.readyState === WebSocket.OPEN) socketMap.send(App.minimap.activeMap.name);

            if (event.data === "MapData") {
                let imageUrl = `${process.env.API_URL}${App.minimap.activeMap.mapURL}basemap.webp`;
                const response = await fetch(imageUrl);
                const imageBlob = await response.blob();
                const reader = new FileReader();
                reader.onload = function () {
                    const arrayBuffer = this.result;
                    socketMap.send(arrayBuffer);
                };
                reader.readAsArrayBuffer(imageBlob);
                App.minimap.changeLayer();
            }

            if (event.data instanceof Blob) {
                const url = URL.createObjectURL(event.data);
                App.minimap.activeLayer.setUrl(url);
                App.openToast("success", "mapUpdated", "");
            }
        });

        // Add error and close event handlers for both sockets
        socketMap.addEventListener("close", handleDisconnect);
        socketMap.addEventListener("error", handleDisconnect);
        socketCoordinates.addEventListener("close", handleDisconnect);
        socketCoordinates.addEventListener("error", handleDisconnect);
    } catch (error) {
        handleDisconnect();
        console.debug("[SMC] Error setting up WebSocket connections", error);
    }
}

/**
 * Handles WebSocket disconnection events
 */
function handleDisconnect() {
    $(".btn-hd").prop("disabled", false);
    startConnectionAttempts();
}

/**
 * Checks and sends updated coordinate information through WebSocket
 * Processes each target marker to extract bearing and elevation data
 * Formats the data as a string and sends it if changed from previous update
 * @param {WebSocket} socketCoordinates - WebSocket connection for sending coordinates
 */
function checkCoordinates(socketCoordinates) {
    const coorArray = getTargetLines();
    if (coorArray != prevCoorArray) {
        prevCoorArray = coorArray;
        if (socketCoordinates && socketCoordinates.readyState === WebSocket.OPEN) {
            socketCoordinates.send(coorArray);
        }
    }
}

/**
 * Builds the text describing every target for an external overlay, one line per target:
 * "<elevation> | <bearing>°[ | <distance>m]" (the elevation is a hold time like "1.20s" for AGS-17,
 * "---" when the target is out of range; the distance only with the "show distance" setting).
 * @returns {string} The lines joined by "\n", empty if there are no targets
 */
function getTargetLines() {
    let coorArray = "";
    if (App.minimap.activeTargetsMarkers) {
        App.minimap.activeTargetsMarkers.eachLayer(function (target) {
            const BEARING = target.firingSolution1.bearing;
            const DISTANCE = target.firingSolution1.distance;
            let elevation;
            if (App.minimap.activeWeaponsMarkers.getLayers()[0].angleType === "high") {
                elevation = target.firingSolution1.elevation.high;
            }
            else {
                elevation = target.firingSolution1.elevation.low;
            }

            if (isNaN(elevation.rad)) {
                elevation = "---";
            } else {
                if (App.activeWeapon.unit === "sec") {
                    elevation = `${App.activeWeapon.getHoldTime(elevation.deg).toFixed(App.activeWeapon.elevationPrecision)}s`;
                } else if (App.activeWeapon.unit === "mil") {
                    elevation = elevation.mil.toFixed(0);
                } else {
                    elevation = elevation.deg.toFixed(1);
                }
            }
            if (coorArray !== "") {
                coorArray = coorArray + "\n";
            }
            coorArray = coorArray + `${elevation} | ${BEARING.toFixed(1)}°`;

            if (App.userSettings.showDistance) {
                coorArray = coorArray + ` | ${DISTANCE.toFixed(0)}m`;
            }
        });
    }
    return coorArray;
}

// Distance between two heights of a target's profile, in meters (heightmap pixel size)
const PROFILE_STEP = 1;

/**
 * Heights of the heightmap (terrain and buildings) along the line from the weapon to the target, so
 * Squad Ballistics can check its own trajectory against them.
 * @param {SquadFiringSolution} solution - solution of the first weapon marker
 * @returns {{step: number, heights: number[]}|null} - heights every `step` meters from the weapon
 *     (index 0) to the target, relative to the weapon like heightDiff, rounded to the centimeter;
 *     null before the heightmap is loaded
 */
function getProfile(solution) {
    const heightmap = App.minimap.heightmap;
    if (!heightmap?.jsonPng?.length || !(solution.distance > 0)) return null;

    const samples = Math.floor(solution.distance / PROFILE_STEP);
    const latStep = (solution.targetLatLng.lat - solution.weaponLatLng.lat) / solution.distance * PROFILE_STEP;
    const lngStep = (solution.targetLatLng.lng - solution.weaponLatLng.lng) / solution.distance * PROFILE_STEP;
    const heights = [];

    for (let i = 0; i <= samples; i++) {
        const ground = heightmap.getHeight({ lat: solution.weaponLatLng.lat + latStep * i, lng: solution.weaponLatLng.lng + lngStep * i });
        heights.push(Math.round((ground - solution.weaponHeight) * 100) / 100);
    }
    return { step: PROFILE_STEP, heights };
}

/**
 * Geometry of every target relative to the first weapon marker, for Squad Ballistics: its embedded
 * map polls `window.squadBallistics.targets()` and solves the shot for its own weapon.
 * @returns {{distance: number, heightDiff: number|null, bearing: number, profile: Object|null}[]} In the
 *     order the targets were placed; distance in meters (horizontal), heightDiff = target ground minus
 *     weapon (with its height padding) in meters, null when the heightmap failed to load (unknown
 *     height), bearing in degrees, profile from getProfile.
 *     Empty without a weapon marker.
 */
export function getTargetData() {
    const targets = [];
    if (!App.minimap.activeTargetsMarkers || !App.minimap.activeWeaponsMarkers.getLayers().length) return targets;

    App.minimap.activeTargetsMarkers.eachLayer(function (target) {
        const solution = target.firingSolution1;
        if (!solution) return;
        targets.push({
            distance: solution.distance,
            heightDiff: solution.hasHeightData ? solution.heightDiff : null,
            bearing: solution.bearing,
            profile: getProfile(solution),
        });
    });
    return targets;
}

/**
 * Checks if the server is available
 * @param {number} [timeout=2000] - Timeout in milliseconds
 * @returns {Promise<boolean>} True if server is available, false otherwise
 */
async function checkServerAvailability(timeout = 2000) {
    // Using XMLHttpRequest instead of fetch to avoid console errors
    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();

        xhr.onreadystatechange = function () {
            if (xhr.readyState === 4) {
                resolve(xhr.status === 200);
            }
        };

        // Suppress error event
        xhr.onerror = () => {
            resolve(false);
        };

        xhr.ontimeout = () => {
            resolve(false);
        };

        try {
            xhr.open("GET", "http://127.0.0.1:12347/health", true);
            xhr.timeout = timeout;
            xhr.send();
        } catch (error) {
            console.debug("[SMC] Error checking server availability", error);
            resolve(false);
        }
    });
}