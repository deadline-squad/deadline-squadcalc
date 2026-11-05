/**
 * Accessibility helpers shared by the map controls.
 * @see https://www.w3.org/WAI/ARIA/apg/patterns/button/ (toggle button)
 */

const TOGGLE_ROOTS = ["#mapLayerMenu", "#mapBtnToggles"];

/**
 * Mirror the `active` class of a toggle button into its aria-pressed attribute
 * @param {Element} button - toggle button whose state is carried by the `active` class
 */
export function syncAriaPressed(button) {
    button.setAttribute("aria-pressed", String(button.classList.contains("active")));
}

/**
 * Keep aria-pressed in step with the `active` class of every toggle button under the given roots.
 * The class is changed from many places (layer menu, settings, minimap), so the attribute follows
 * the class through a MutationObserver instead of being set at each call site.
 * @param {string[]} [rootSelectors] - containers holding toggle buttons
 * @returns {MutationObserver[]} the observers, one per root found
 */
export function observeAriaPressed(rootSelectors = TOGGLE_ROOTS) {
    return rootSelectors.map((selector) => document.querySelector(selector)).filter(Boolean).map((root) => {
        const syncButtons = (buttons) => buttons.forEach(syncAriaPressed);
        const toggleButtons = () => root.querySelectorAll("button.layers, button.btn-helpmap, button.btn-coverage, button.btn-hd, button.mapBtnToggle");
        syncButtons(toggleButtons());

        const observer = new MutationObserver((mutations) => {
            mutations.forEach(({ target }) => {
                if (target.matches?.("button.layers, button.btn-helpmap, button.btn-coverage, button.btn-hd, button.mapBtnToggle")) syncAriaPressed(target);
            });
        });
        observer.observe(root, { attributes: true, attributeFilter: ["class"], subtree: true });
        return observer;
    });
}

/**
 * Make a marker icon operable from the keyboard: Enter and Space fire the marker's click,
 * the same way a pointer click does. Leaflet 2 already makes the icon focusable with role="button"
 * when the marker has `keyboard: true`, but never activates it.
 * @param {HTMLElement} icon - the marker's DOM element
 * @param {string} name - accessible name of the marker
 * @param {Function} activate - called when Enter or Space is pressed on the icon
 */
export function makeMarkerIconOperable(icon, name, activate) {
    icon.setAttribute("aria-label", name);
    icon.onkeydown = (event) => {
        if (event.target !== icon || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        event.stopPropagation();
        activate();
    };
}
