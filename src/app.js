// Node Modules
import "purecss/build/pure-min.css";
import "purecss/build/grids-responsive-min.css";
import "select2/dist/css/select2.min.css";
import "select2/dist/js/select2.min.js";
import "animate.css";
import "leaflet/dist/leaflet.css";

// Local styles
import "./components/header/header.scss";
import "./components/map/map.scss";
import "./components/map/mapFactionCtxMenu.scss";
import "./components/map/mapObjectives.scss";
import "./components/map/mapButtons.scss";
import "./components/map/mapLogo.scss";

import "./components/legacyui/legacyui.scss";

import "./components/dialogs/dialogs.scss";
import "./components/dialogs/factions.scss";
import "./components/dialogs/settings.scss";
import "./components/dialogs/servers.scss";

import "./components/shared/_tooltips.scss";
import "./components/shared/_responsive.scss";

import "./components/contextMenu/contextMenu.scss";


// JS
import SquadCalc from "./js/squadCalc.js";


/***************/
// Start the App
/***************/

var options = {
    supportedLanguages: [
        ["en", "EN"],
        ["zh", "中文"],
        ["uk", "UKR"],
        ["ru", "РУС"],
        ["fr", "FR"],
        ["de", "DE"]
    ],
    // Squad's world gravity: DefaultGravityZ = -980 cm/s² in the engine config, not overridden by the
    // SQWorldSettings of any of the 219 layers (Squad build 26005357). The 9.78 used before was fitted
    // on in-game shots while the muzzle offset was ignored (weapons.js `muzzle`).
    gravity: 9.80,
    mapSize: 256,
    debug: false,
};

export var App = new SquadCalc(options);
App.init();