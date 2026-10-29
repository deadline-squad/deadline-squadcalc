import i18next from "i18next";
import { App } from "../app.js";
import { getTargetLines } from "./smcConnector.js";

const CODE_STORAGE_KEY = "overlay-session-code";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I: the code is typed by hand
const CODE_LENGTH = 8;
const CODE_PATTERN = /^[A-Z0-9]{6,16}$/; // what the relay accepts (ags17_relay.py); Squad Ballistics' codes are 12 long
const LINK_FRAGMENT_KEY = "link";
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
    if (storedCode && CODE_PATTERN.test(storedCode)) {
        sessionCode = storedCode;
        return sessionCode;
    }

    const randomValues = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    sessionCode = Array.from(randomValues, (value) => CODE_ALPHABET[value % CODE_ALPHABET.length]).join("");
    try { localStorage.setItem(CODE_STORAGE_KEY, sessionCode); } catch { /* see above */ }
    return sessionCode;
}

/**
 * Session code as the relay expects it: separators dropped, upper case ("abcd-efgh-2345" -> "ABCDEFGH2345").
 * @param {string} text - code as typed, shown or passed in a link
 * @returns {string|null} the code, or null when it is not one
 */
export function normalizeSessionCode(text) {
    const code = String(text).replace(/[\s-]/g, "").toUpperCase();
    return CODE_PATTERN.test(code) ? code : null;
}

/**
 * Session code passed by Squad Ballistics' device link (https://<host>/#link=<CODE>, also shown as a QR code).
 * It travels in the URL fragment, which the browser never sends, so the code stays out of server logs.
 * Read before anything rewrites the URL (SquadCalc.updateUrlParams drops the fragment).
 * @returns {string|null} the raw value of the "link" fragment parameter, null without one
 */
export function readLinkFragment() {
    return new URLSearchParams(window.location.hash.slice(1)).get(LINK_FRAGMENT_KEY);
}

/**
 * Sets up the periodic synchronisation with the overlay and the settings controls
 * @param {string|null} linkCode - code from the device link this page was opened with (see readLinkFragment)
 */
export function initOverlayLink(linkCode = null) {
    $("#overlayCodeNew").on("click", renewSessionCode);
    $("#overlayCode").on("focus", (event) => event.target.select());
    showCode();
    setStatus("overlayStatusOffline");
    adoptLinkedCode(linkCode);
    // The link pasted into an open tab only changes the fragment: the page is not reloaded
    window.addEventListener("hashchange", () => adoptLinkedCode(readLinkFragment()));
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

/**
 * Pairs this browser with the Squad Ballistics app that made the link: takes over its session code, turns the
 * link on and remembers both, so later visits reconnect without the link. Removes the code from the address
 * bar (and so from bookmarks and shared URLs).
 * @param {string|null} rawCode - value of the link fragment, null when the page was opened without one
 */
function adoptLinkedCode(rawCode) {
    if (rawCode === null) return;
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);

    const code = normalizeSessionCode(rawCode);
    if (!code) {
        App.openToast("error", "overlayLinkInvalid", "overlayLinkInvalidText");
        return;
    }

    if (code !== getSessionCode()) {
        sessionCode = code;
        try { localStorage.setItem(CODE_STORAGE_KEY, code); } catch { /* see getSessionCode */ }
        disconnect();
        showCode();
    }
    lastAttempt = 0; // join the new session now, not after the reconnect delay
    $("#overlayLinkSetting").prop("checked", true);
    App.userSettings.set("overlayLink", true);
    App.openToast("success", "overlayLinked", "overlayLinkedText");
}

function renewSessionCode() {
    sessionCode = null;
    try { localStorage.removeItem(CODE_STORAGE_KEY); } catch { /* see getSessionCode */ }
    disconnect();
    showCode();
    syncOverlayLink();
}

function showCode() {
    $("#overlayCode").val(getSessionCode().match(/.{1,4}/g).join("-"));
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
