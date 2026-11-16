/**
 * The HTML of the calculation popup of a target: the elevation, the obstacle, the rounds to fire and the lines of the
 * settings (bearing, time of flight, distance, height), pure so that the content can be tested without a map.
 */
import { App } from "../app.js";
import i18next from "i18next";
import { compassHTML, compassText } from "./compass.js";

/**
 * Popup line of the height the user chose for the target
 * @param {{kind: string, above: number}|null} heightChoice - the choice of the target dialog, null for the ground
 * @returns {string} - HTML line, empty for a target on the ground
 */
export function formatHeightChoice(heightChoice) {
    if (!heightChoice) return "";
    const { kind, above } = heightChoice;
    const meters = `<span data-i18n="common:m">${i18next.t("common:m")}</span>`;
    return `<br><span class="calcTargetHeight">⌖ ${i18next.t(`common:targetHeight_${kind}`)} ${above >= 0 ? "+" : ""}${above.toFixed(1)}${meters}</span>`;
}

/**
 * Returns the HTML content for the calculation popups
 * @param {SquadFiringSolution} firingSolution
 * @param {String} angleType
 * @param {Object} lines - what the target itself adds to the content
 * @param {function(string[]): string} lines.formatRounds - the rounds line for the shown arcs ("low" / "high")
 * @param {string} lines.targetLines - HTML lines of the target (fire correction, chosen height), empty for the second weapon
 * @returns {String[]} - [HTML content, summary text]
 */
export function popupContent(firingSolution, angleType, { formatRounds, targetLines }) {
    const DIST = firingSolution.distance;
    const BEARING = firingSolution.bearing;
    let heightDiff = Number.isFinite(firingSolution.heightDiff) ? firingSolution.heightDiff.toFixed(0) : "---";

    // Avoid "-0"
    if (heightDiff !== "---" && (heightDiff == -0 || Math.sign(heightDiff) === 1)) {
        heightDiff = `+${Math.abs(heightDiff)}`;
    }

    /**
     * Formats elevation and time of flight values
     * @param {Object} elevationData 
     * @param {Number} timeOfFlight 
     * @returns {[string, string]} - [elevation, timeOfFlight]
     */
    const formatElevationData = (elevationData, timeOfFlight, arc) => {
        if (isNaN(elevationData?.rad)) return ["---", "---"];

        let convertedElevation;

        // Direct fire flies for fractions of a second: tenths matter to lead a moving target
        const timeDigits = App.activeWeapon.type === "directFire" ? 1 : 0;
        const formattedTime = `${timeOfFlight.toFixed(timeDigits)}<span data-i18n="common:s">${i18next.t("common:s")}</span>`;

        switch (App.activeWeapon.unit) {
        case "sec":
            convertedElevation = `${App.activeWeapon.getHoldTime(elevationData.deg).toFixed(App.activeWeapon.elevationPrecision)}${i18next.t("common:s")}`;
            break;
        case "mil":
            convertedElevation = elevationData.mil.toFixed(App.activeWeapon.elevationPrecision);
            break;
        case "degMin": {
            // Convert degrees to degrees + minutes
            let degrees = Math.floor(elevationData.deg);
            let minutes = Math.round((elevationData.deg - degrees) * 60);
            if (minutes === 60) {
                degrees += 1;
                minutes = 0;
            }
            convertedElevation = `${degrees}°${minutes.toString().padStart(2, "0")}'`;
            break;
        }
        default:
            // Direct fire is aimed relative to the target, not to the horizon
            convertedElevation = (App.activeWeapon.type === "directFire" ? firingSolution.getSightAngle(elevationData.rad) : elevationData.deg).toFixed(App.activeWeapon.elevationPrecision);
        }

        // A trajectory that hits the terrain or a building first is shown struck through
        if (firingSolution.obstacle?.[arc]) convertedElevation = `<span class="calcBlocked">${convertedElevation}</span>`;

        return [convertedElevation, formattedTime];
    };

    /**
     * Where the shown trajectories hit an obstacle first: distance and height above the weapon
     * @param {string[]} arcs - "low" / "high", in the order they are shown
     * @returns {string} - HTML line, empty if every shown trajectory is clear
     */
    const formatObstacles = (arcs) => {
        if (!arcs.some((arc) => firingSolution.obstacle?.[arc])) return "";
        const meters = `<span data-i18n="common:m">${i18next.t("common:m")}</span>`;
        const parts = arcs.map((arc) => {
            const obstacle = firingSolution.obstacle?.[arc];
            if (!obstacle) return "---";
            const height = Math.round(obstacle.height);
            return `${obstacle.distance.toFixed(0)}${meters} (${height >= 0 ? "+" : ""}${height}${meters})`;
        });
        return `<br><span class="calcObstacle">⛔ ${parts.join(" / ")}</span>`;
    };

    let elevation, timeOfFlight, shownArcs;

    if (App.activeWeapon.elevationRate) {
        // Weapons laid by holding a key (AGS-17): hold time of the lob, then the angle to aim at in direct fire
        const [holdTime, timeHigh] = formatElevationData(firingSolution.elevation.high, firingSolution.timeOfFlight.high, "high");
        let directAngle = isNaN(firingSolution.elevation.low.rad) ? "---" : `${firingSolution.getSightAngle(firingSolution.elevation.low.rad).toFixed(1)}°`;
        if (firingSolution.obstacle?.low) directAngle = `<span class="calcBlocked">${directAngle}</span>`;
        elevation = `${holdTime} / ${directAngle}`;
        timeOfFlight = timeHigh;
        shownArcs = ["high", "low"];
    } else if (App.userSettings.lowAndHigh && !["Mortar", "UB-32", "M1064M121", "Mk19"].includes(App.activeWeapon.name)) {
        const [elevationLow, timeLow] = formatElevationData(firingSolution.elevation.low, firingSolution.timeOfFlight.low, "low");
        const [elevationHigh, timeHigh] = formatElevationData(firingSolution.elevation.high, firingSolution.timeOfFlight.high, "high");
        elevation = `${elevationLow} / ${elevationHigh}`;
        timeOfFlight = `${timeLow} / ${timeHigh}`;
        shownArcs = ["low", "high"];
    } else {
        const arc = angleType === "high" ? "high" : "low";
        [elevation, timeOfFlight] = formatElevationData(firingSolution.elevation[arc], firingSolution.timeOfFlight[arc], arc);
        shownArcs = [arc];
    }

    let content;
    
    // Checks if last three elevation digits option is enabled and if selected weapon is "Mortar"
    // TODO move this in the previous if statement when other weapons are supported
    // Text of the elevation without the markup of blocked trajectories (last digits, clipboard)
    const elevationText = elevation.toString().replace(/<[^>]*>/g, "");

    if (App.userSettings.lastDigits && ["Mortar"].includes(App.activeWeapon.name)){
        const lastDigits = elevationText.slice(-3);
        const shown = firingSolution.obstacle?.[shownArcs[0]] ? `<span class="calcBlocked">${lastDigits}</span>` : lastDigits;
        content = `<span class=calcNumber></span></br><span>${shown}</span>`;
    } else {
        content = `<span class="calcNumber"></span><br><span>${elevation}</span>`;
    }

    content += formatObstacles(shownArcs);
    if (!firingSolution.hasHeightData) {
        content += `<br><span class="calcNoHeight">⚠ <span data-i18n="common:noHeightData">${i18next.t("common:noHeightData")}</span></span>`;
    } else if (!firingSolution.hasHeightDetail) {
        content += `<br><span class="calcNoHeight">⚠ <span data-i18n="common:noHeightDetail">${i18next.t("common:noHeightDetail")}</span></span>`;
    }
    content += formatRounds(shownArcs);
    content += targetLines;

    if (App.userSettings.showBearing) content += `<br><span class=bearingUiCalc>${compassHTML(BEARING)}<span data-i18n="common:°">${i18next.t("common:°")}</span></span>`;
    if (App.userSettings.showTimeOfFlight) content += `<br><span class=bearingUiCalc>${timeOfFlight}</span>`;
    if (App.userSettings.showDistance) content += `<br><span class=bearingUiCalc>${DIST.toFixed(0)}<span data-i18n="common:m">${i18next.t("common:m")}</span></span>`;
    if (App.userSettings.showHeight) content += `<br><span class=bearingUiCalc>${heightDiff}<span data-i18n="common:m">${i18next.t("common:m")}</span></span>`;
    const elevationLabel = i18next.t(App.activeWeapon.elevationRate ? "common:holdTime" : "common:elevation");
    return [content, `${elevationLabel}: ${elevationText} - ${i18next.t("common:bearing")}: ${compassText(BEARING)}°`];
}
