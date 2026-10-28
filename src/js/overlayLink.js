import i18next from "i18next";
import { App } from "../app.js";
import { getTargetLines } from "./smcConnector.js";

const CODE_STORAGE_KEY = "overlay-session-code";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I: the code is typed by hand
const CODE_LENGTH = 8;
const SYNC_INTERVAL_MS = 1000;
const RECONNECT_DELAY_MS = 5000;

let sessionCode = null;
let socket = null;
let lastAttempt = 0;
let lastSent = null;

/**
 * Returns the session code shared with the overlay, creating and storing one on first use.
 * The code is the only secret of the session: whoever knows it can read the targets.
 * @returns {string} 8 characters from CODE_ALPHABET
 */
export function getSessionCode() {
    if (sessionCode) return sessionCode;

    let storedCode = null;
    try { storedCode = localStorage.getItem(CODE_STORAGE_KEY); } catch { /* storage blocked: the code lives in memory only */ }
    if (storedCode && storedCode.length === CODE_LENGTH) {
        sessionCode = storedCode;
        return sessionCode;
    }

    const randomValues = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    sessionCode = Array.from(randomValues, (value) => CODE_ALPHABET[value % CODE_ALPHABET.length]).join("");
    try { localStorage.setItem(CODE_STORAGE_KEY, sessionCode); } catch { /* see above */ }
    return sessionCode;
}

/**
 * Sets up the periodic synchronisation with the overlay and the settings controls
 */
export function initOverlayLink() {
    $("#overlayCodeNew").on("click", renewSessionCode);
    $("#overlayCode").on("focus", (event) => event.target.select());
    showCode();
    setStatus("overlayStatusOffline");
    setInterval(syncOverlayLink, SYNC_INTERVAL_MS);

    // Several tabs share the code: the one the user looks at takes over the overlay
    const takeOver = () => {
        if (document.hidden || getTargetLines(true) === "") return;
        lastSent = null;
        syncOverlayLink();
    };
    document.addEventListener("visibilitychange", takeOver);
    window.addEventListener("focus", takeOver);
}

/**
 * Connects (or disconnects) the relay according to the setting and sends the targets when they changed.
 * Called every second and when the setting is toggled.
 */
export function syncOverlayLink() {
    if (!App.userSettings.overlayLink) {
        disconnect();
        return;
    }
    if (!socket) {
        connect();
        return;
    }
    if (socket.readyState !== WebSocket.OPEN) return;

    const text = relayText();
    if (text === lastSent) return;
    lastSent = text;
    socket.send(text);
}

/**
 * Text sent to the overlay: one line per target (see getTargetLines), then "weapon: <name>"
 * with the Squad Ballistics name of the selected weapon when it has one, so the overlay solves
 * the targets for the same weapon. Readers of target lines skip it (it has no "|").
 * @returns {string}
 */
function relayText() {
    const lines = getTargetLines(true);
    const weapon = App.activeWeapon?.ballistics;
    if (!weapon) return lines;
    return lines === "" ? `weapon: ${weapon}` : `${lines}\nweapon: ${weapon}`;
}

function renewSessionCode() {
    sessionCode = null;
    try { localStorage.removeItem(CODE_STORAGE_KEY); } catch { /* see getSessionCode */ }
    disconnect();
    showCode();
    syncOverlayLink();
}

function showCode() {
    const code = getSessionCode();
    $("#overlayCode").val(`${code.slice(0, CODE_LENGTH / 2)}-${code.slice(CODE_LENGTH / 2)}`);
}

function connect() {
    if (Date.now() - lastAttempt < RECONNECT_DELAY_MS) return;
    lastAttempt = Date.now();

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const relay = new WebSocket(`${protocol}://${window.location.host}/relay/${getSessionCode()}?role=page`);
    socket = relay;
    // A (re)connect must not overwrite the overlay with nothing (a new empty tab), and a hidden tab
    // must not race the visible one after a relay restart: only later changes are sent
    lastSent = document.hidden || getTargetLines(true) === "" ? relayText() : "";

    relay.addEventListener("message", (event) => {
        try {
            const message = JSON.parse(event.data);
            if (message.type === "peers") setStatus(message.overlays > 0 ? "overlayStatusConnected" : "overlayStatusWaiting");
        } catch (error) {
            console.debug("[Overlay] Unreadable message from the relay", error);
        }
    });
    relay.addEventListener("close", () => {
        // A replaced socket closing late must not overwrite the state of the new one
        if (socket !== relay) return;
        socket = null;
        setStatus("overlayStatusOffline");
    });
}

function disconnect() {
    if (!socket) return;
    const relay = socket;
    socket = null;
    relay.close();
    setStatus("overlayStatusOffline");
}

function setStatus(key) {
    $("#overlayStatus").attr("data-i18n", `settings:${key}`).text(i18next.t(`settings:${key}`));
}
