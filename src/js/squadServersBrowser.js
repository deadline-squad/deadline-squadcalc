import i18next from "i18next";
import { App } from "../app.js";
import { MAPS } from "../data/maps.js";
import { serverBrowserTooltips } from "./tooltips.js";
import Fuse from "fuse.js";
import { canFollow, fetchServers, followDecision } from "./serversSource.js";

export default class SquadServersBrowser {

    constructor() {
        this.serversData = null;
        this.filteredData = null;
        // Server mode (App.initServerMode, App.leaveServerMode): the id of the server the page follows, or is about
        // to follow while the feed is read; the layer the page has opened for it; the timer of syncWithServer
        this.selectedServer = null;
        this.selectedLayer = null;
        this.syncInterval = null;
    }

    init(){
        this.loadServersInfo();
    }


    /**
     * Reads the feed again and brings the page in line with the followed server (`applyFeed`).
     */
    async syncWithServer() {
        const followed = this.selectedServer;
        if (!followed) return;
        await this.getServers();
        // Not when the user left server mode, or chose another server, while the feed was read
        if (this.selectedServer === followed) this.applyFeed();
    }


    /**
     * Brings the page in line with the followed server in the feed just read (`followDecision`): opens the layer it
     * plays now, or leaves server mode and tells the user why when the feed does not confirm the server.
     * @returns {boolean} whether the page still follows the server
     */
    applyFeed() {
        const { action, reason, server } = followDecision(this.serversData, this.selectedServer, this.selectedLayer);
        if (action === "leave") {
            App.leaveServerMode(reason);
            return false;
        }
        if (action === "switch") {
            console.debug(`[SERVER] ${server.attributes.name}: layer ${this.selectedLayer} -> ${server.attributes.details.map}`);
            this.selectedLayer = server.attributes.details.map;
            this.switchLayer(server);
        }
        return true;
    }


    /**
     * Reads the home servers into `this.serversData`; the menu's dropdown offers what was read.
     */
    async getServers() {
        this.serversData = await fetchServers();
        App.buildServerDropdown(this.serversData);

        // Initiate fuse index
        this.fuse = new Fuse(this.serversData, {
            includeScore: true,
            threshold: 0.4,
            distance: 500,
            keys: ["attributes.name", "attributes.details.map"]
        });
    }


    /**
     * Initial Loads the server and renders the full servers table.
     */
    async loadServersInfo() {
        const serversList = document.getElementById("serversList");
        serversList.innerHTML = `
            <div class="loading-container">
                <div class="loading-spinner"></div>
                <p>${i18next.t("loadingServers", { ns: "common" })}</p>
            </div>
        `;
        await this.getServers();
        this.renderTable(this.serversData);

        // Trigger custom event
        $(document).trigger("servers:loaded");
    }


    /**
     * Refreshes the server table:
     * - Shows a loading message
     * - Fetches the latest server data
     * - Applies the current search filter
     */
    async refreshRows() {
        const tbody = document.getElementById("serversTableBody");
        const searchInput = document.getElementById("serverSearch");
        tbody.innerHTML = `
            <tr>
                <td colspan="4" style="text-align: center; padding: 40px;">
                    <p>${i18next.t("loadingServers", { ns: "common" })}</p>
                </td>
            </tr>
        `;
        await this.getServers();
        this.filterServers(searchInput.value);
    }


    /**
     * Filters servers by name or map and updates the table.
     * Uses Fuse.js for fuzzy matching, so typos like "YEORIVKA" will match "YEHORIVKA".
     * @param {string} query
     */
    filterServers(query) {
        if (!query.trim()) {
            this.filteredData = this.serversData;
            this.renderRows(this.filteredData);
            return;
        }

        if (!this.fuse) return;

        const results = this.fuse.search(query);
        this.filteredData = results.map(r => r.item);
        this.renderRows(this.filteredData);
    }


    /**
     * Returns the players HTML for a server.
     * @param {number|null} players
     * @param {number|null} maxPlayers
     * @returns {string}
     */
    getPlayersHTML(players, maxPlayers) {
        if (players != null && maxPlayers != null) {
            return `${players} / ${maxPlayers}`;
        } else {
            return "-";
        }
    }


    /**
     * Returns the flag icon HTML for a team
     * @param {string|undefined} team - the id of the team's faction, undefined when the feed has none
     * @returns {string}
     */
    getTeamHTML(team) {
        if (!team) return "<img src=\"/img/flags/unknown.webp\" alt=\"Unknown\" class=\"flag-icon\">";
        const faction = App.sanitize(team);
        return `<img title="${faction}" src="/img/flags/${faction}.webp" alt="${faction}" class="flag-icon">`;
    }


    /**
     * Renders table rows for the given servers list.
     * @param {Array} servers
     */
    renderRows(servers){
        const tbody = document.getElementById("serversTableBody");
        let rows = "";
        
        if (servers && servers.length > 0) {
            servers.forEach(server => {
                const isSelected = server.id == this.selectedServer ? "selected" : "";
                const unavailable = canFollow(server) ? "" : "unavailable";
                rows += `
                    <tr class="${isSelected} ${unavailable}" data-serverid="${App.sanitize(server.id)}">
                        <td title="${App.sanitize(server.attributes.name)}"><div class="server-name">${App.sanitize(server.attributes.name)}</div></td>
                        <td class="mapdata">${App.sanitize(server.attributes.details.map)}</td>
                        <td>${this.getPlayersHTML(server.attributes.players, server.attributes.maxPlayers)}</td>
                        <td class="teamFlags">
                            ${this.getTeamHTML(server.team1)}
                            ${this.getTeamHTML(server.team2)}
                        </td>
                    </tr>
                `;
            });
        } else {
            rows = `
                <tr>
                    <td colspan="4" style="text-align: center; padding: 40px;" data-i18n="common:noServersFound">
                        ${i18next.t("noServersFound", { ns: "common" })}
                    </td>
                </tr>
                `;
        }
        tbody.innerHTML = rows;
    }


    /**
     * Generates the HTML structure for the server table, search input, and buttons.
     * @returns {string} The full HTML markup for the servers list.
     */
    generateTableHTML() {
        return `
            <div class="container animate__animated animate__fadeIn">
                <div class="search-container">
                    <div class="search-wrapper">
                        <svg class="search-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="11" cy="11" r="8"></circle>
                            <path d="m21 21-4.35-4.35"></path>
                        </svg>
                        <input 
                            type="text" 
                            class="search-input" 
                            data-i18n-placeholder="common:searchServerPlaceholder"
                            placeholder="${i18next.t("searchServerPlaceholder", { ns: "common" })}"
                            id="serverSearch"
                        />
                    </div>
                    <button class="searchBtn refresh-btn" id="refreshBtn">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
                        </svg>
                    </button>
                    <button class="searchBtn info-btn" id="">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><path d="M224 224C224 171 267 128 320 128C373 128 416 171 416 224C416 266.7 388.1 302.9 349.5 315.4C321.1 324.6 288 350.7 288 392L288 416C288 433.7 302.3 448 320 448C337.7 448 352 433.7 352 416L352 392C352 390.3 352.6 387.9 355.5 384.7C358.5 381.4 363.4 378.2 369.2 376.3C433.5 355.6 480 295.3 480 224C480 135.6 408.4 64 320 64C231.6 64 160 135.6 160 224C160 241.7 174.3 256 192 256C209.7 256 224 241.7 224 224zM320 576C342.1 576 360 558.1 360 536C360 513.9 342.1 496 320 496C297.9 496 280 513.9 280 536C280 558.1 297.9 576 320 576z"/></svg>
                    </button>
                </div>
            </div>

            <div id="tableContainer" class="animate__animated animate__fadeIn">
                <table class="servers-table">
                    <thead>
                        <tr>
                            <th class="sortable" data-sort="name" data-i18n="common:serverName">
                                ${i18next.t("serverName", { ns: "common" })} <span class="sort-indicator">⇅</span>
                            </th>
                            <th class="sortable" data-sort="map" data-i18n="common:currentMap">
                                ${i18next.t("currentMap", { ns: "common" })} <span class="sort-indicator">⇅</span>
                            </th>
                            <th data-i18n="common:players">
                                ${i18next.t("players", { ns: "common" })}
                            </th>
                            <th data-i18n="common:teams">
                                ${i18next.t("teams", { ns: "common" })}
                            </th>
                        </tr>
                    </thead>
                    <tbody id="serversTableBody"></tbody>
                </table>
            </div>
        `;
    }


    /**
     * Handles a click on a row of the servers table: the row of the followed server leaves server mode, the row of
     * another server enters it for that server (the feed is read again first, the row may be old).
     * @param {jQuery<HTMLElement>} row - The clicked table row as a jQuery object.
     */
    handleRowClicks(row) {
        // The header, a row without a server (loading, no servers found) and a server the calculator cannot show
        const serverId = row.attr("data-serverid");
        if (!serverId || row.hasClass("unavailable")) return;

        if (row.hasClass("selected")) App.leaveServerMode();
        else App.initServerMode(serverId);
    }



    /**
     * Renders the full servers table with search, refresh, info buttons, and event listeners.
     * @param {Array} servers - The array of server objects to display.
     */
    renderTable(servers) {
        const serversList = document.getElementById("serversList");

        // Load the HTML Table
        serversList.innerHTML = this.generateTableHTML();

        // Rows Click Handler
        $(".servers-table").on("click", "tr", (event) => { this.handleRowClicks($(event.currentTarget));});

        // Search input listener
        const searchInput = document.getElementById("serverSearch");
        if (searchInput) searchInput.addEventListener("input", (e) => { this.filterServers(e.target.value);});

        // Refresh Button listener
        const refreshBtn = document.getElementById("refreshBtn");
        if (refreshBtn) refreshBtn.addEventListener("click", () => { this.refreshRows(); });

        // Sortable headers
        const sortableHeaders = serversList.querySelectorAll("th[data-sort]");
        sortableHeaders.forEach(header => {
            header.addEventListener("click", () => {
                const column = header.getAttribute("data-sort");

                // Get sort direction ("asc" or "desc")
                const direction = this.sortTable(column);

                // Reset all headers
                sortableHeaders.forEach(h => {
                    h.classList.remove("sorted");
                    const indicator = h.querySelector(".sort-indicator");
                    if (indicator) indicator.textContent = "⇅";
                });

                // Apply style + arrow to clicked header
                header.classList.add("sorted");
                const indicator = header.querySelector(".sort-indicator");
                if (indicator) indicator.textContent = direction === "asc" ? "▲" : "▼";
                
            });
        });

        this.renderRows(servers);

        // Focus search input at the end
        if (searchInput) searchInput.focus();
        
    }


    /**
     * Switches the map, the layer and the factions to what a server plays. The feed has no unit of a team, so the
     * units stay the factions' default ones.
     * @param {object} server - a home server the calculator can show (`canFollow`)
     */
    switchLayer(server) {
        const { mapName, team1, team2 } = server;
        const layer = server.attributes.details.map;
        const mapIndex = MAPS.findIndex(m => m.name.toLowerCase() === mapName.toLowerCase());
        const currentMapIndex = parseInt(App.MAP_SELECTOR.val());
        const currentLayer = App.LAYER_SELECTOR.val();

        const applyFactions = () => {
            App.FACTION1_SELECTOR.val(team1).trigger($.Event("change", { broadcast: false }));
            App.FACTION2_SELECTOR.val(team2).trigger($.Event("change", { broadcast: false }));
            // Strip any team params that default faction loading may have written
            App.updateUrlParams({ team1: null, team1unit: null, team2: null, team2unit: null });
            serverBrowserTooltips.hide();
            App.openToast("success", "mapUpdated", "");
        };

        const setLayerAndFactions = () => {
            if (!App.LAYER_SELECTOR.find(`option[value="${layer}"]`).length) {
                $(document).one("layers:loaded", setLayerAndFactions);
                return;
            }
            App.LAYER_SELECTOR.val(layer).trigger($.Event("change", { broadcast: true }));
            $(document).one("layer:loaded", applyFactions);
        };

        $("#serversInformation")[0].close();

        // Already on the right map and layer — factions only
        if (currentMapIndex === mapIndex && currentLayer === layer) {
            applyFactions();
            return;
        }

        // Map needs to change — loadLayers() fires layers:loaded
        if (currentMapIndex !== mapIndex) {
            App.MAP_SELECTOR.val(mapIndex).trigger($.Event("change", { broadcast: true }));
            $(document).one("layers:loaded", setLayerAndFactions);
            return;
        }

        // Same map, different layer
        const layersReady = App.LAYER_SELECTOR.find("option[value]:not([value=''])").length > 0;
        if (layersReady) {
            setLayerAndFactions();
        } else {
            $(document).one("layers:loaded", setLayerAndFactions);
        }
    }


    /**
     * Sorts the server table by the given column and re-renders the rows.
     * @param {string} column
     * @returns {"asc"|"desc"}
     */
    sortTable(column) {
        if (!this.serversData) return;

        let sortOrder = this.currentSort === column && this.sortAscending ? -1 : 1;
        const direction = sortOrder === 1 ? "asc" : "desc";
        this.sortAscending = !this.sortAscending;
        this.currentSort = column;

        // Sort from the current filteredData, or full dataset if empty
        const baseData = this.filteredData !== null ? this.filteredData : [...this.serversData];

        const sorted = [...baseData].sort((a, b) => {
            let valA, valB;

            switch (column) {
            case "name":
                valA = a.attributes.name.toLowerCase();
                valB = b.attributes.name.toLowerCase();
                break;
            case "map":
                valA = (a.attributes.details.map || "").toLowerCase();
                valB = (b.attributes.details.map || "").toLowerCase();
                break;
            case "players":
                valA = a.attributes.players;
                valB = b.attributes.players;
                break;
            default:
                return 0;
            }

            if (valA < valB) return -1 * sortOrder;
            if (valA > valB) return 1 * sortOrder;
            return 0;
        });

        this.filteredData = sorted;
        this.renderRows(sorted);
        return direction;
    }

}