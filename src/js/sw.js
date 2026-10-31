import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { clientsClaim } from "workbox-core";
import { registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst, StaleWhileRevalidate, NetworkOnly } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);


// Cache key of a file whose URL carries a query that does not change its content (?map=, ?server=,
// ?v=<version>): one entry per path, always the latest copy
const keyWithoutQuery = {
    cacheKeyWillBeUsed: async ({ request }) => {
        const url = new URL(request.url);
        return `${url.origin}${url.pathname}`;
    },
};


// HTML documents: always from the network, so a deploy shows at once; the last copy is used only when the
// network fails, so the page still opens offline (its scripts are precached)
registerRoute(
    ({ request }) => request.mode === "navigate",
    new NetworkFirst({
        cacheName: "pages",
        plugins: [
            keyWithoutQuery,
            new ExpirationPlugin({ maxEntries: 5 }),
        ],
    })
);


// Translations (not precached: the precache holds no .json): the network first, so an edit shows at
// once, and the last copy offline
registerRoute(
    ({ url }) => url.pathname.startsWith("/locales/") && url.pathname.endsWith(".json"),
    new NetworkFirst({
        cacheName: "locales",
        plugins: [
            keyWithoutQuery,
            new ExpirationPlugin({ maxEntries: 60 }), // 6 languages x 8 namespaces
        ],
    })
);


// Google Fonts of the page (index.html): the stylesheet is refreshed in the background, the font files never
// change
registerRoute(
    ({ url }) => url.origin === "https://fonts.googleapis.com",
    new StaleWhileRevalidate({ cacheName: "google-fonts-stylesheets" })
);
registerRoute(
    ({ url }) => url.origin === "https://fonts.gstatic.com",
    new CacheFirst({
        cacheName: "google-fonts-files",
        plugins: [
            new ExpirationPlugin({
                maxEntries: 30,
                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
                purgeOnQuotaError: true,
            }),
        ],
    })
);


// Precise heightmaps of this deployment (/heightmaps/<map>/, src/js/heightmapWorker.js). meta.json names the
// files and says which version they are, so it comes from the network first (the last copy offline); the heavy
// file is requested as ?v=<generated of meta.json>, so a URL never changes content and a cached one is
// served first. At most 8 maps are kept (about 7 MB each as WebP), the least recently used one goes first
registerRoute(
    ({ url }) => /^\/heightmaps\/[^/]+\/meta\.json$/.test(url.pathname),
    new NetworkFirst({
        cacheName: "heightmap-meta",
        plugins: [
            keyWithoutQuery,
            new ExpirationPlugin({ maxEntries: 30 }),
        ],
    })
);
registerRoute(
    ({ url }) => /^\/heightmaps\/[^/]+\/heightmap\.(webp|png)$/.test(url.pathname) && url.searchParams.has("v"),
    new CacheFirst({
        cacheName: "precise-heightmaps",
        plugins: [
            new ExpirationPlugin({
                maxEntries: 8,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
                purgeOnQuotaError: true,
            }),
        ],
    })
);


// Font subsets other than latin (latin-ext, cyrillic) are not precached: each is cached the first time a page
// uses it, then served from the cache first. The file names carry the version, so they never change
registerRoute(
    ({ url }) => url.pathname.startsWith("/fonts/"),
    new CacheFirst({
        cacheName: "fonts",
        plugins: [
            new ExpirationPlugin({
                maxEntries: 20,
                maxAgeSeconds: 60 * 60 * 24 * 365, // 1 year
                purgeOnQuotaError: true,
            }),
        ],
    })
);


// Cache map images for 30 days with StaleWhileRevalidate
registerRoute(
    ({ url }) => url.pathname.includes("/maps/") && url.pathname.endsWith(".webp"),
    new StaleWhileRevalidate ({
        cacheName: "map-images",
        plugins: [
            new ExpirationPlugin({
                maxEntries: 30,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
                purgeOnQuotaError: true,
            }),
        ],
    })
);


// Vehicle images (/img/vehicles, 15 MB for the 220 of them) are not precached: each is cached the first
// time a faction or vehicle dialog shows it, for 30 days, and then served from the cache first
registerRoute(
    ({ url }) => url.pathname.startsWith("/img/vehicles/"),
    new CacheFirst({
        cacheName: "vehicle-images",
        plugins: [
            new ExpirationPlugin({
                maxEntries: 300,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
                purgeOnQuotaError: true,
            }),
        ],
    })
);


// Cache binary heightmaps for 30 days with StaleWhileRevalidate
registerRoute(
    ({ url }) => url.pathname.includes("/maps/") && url.pathname.endsWith("heightmap.png"),
    new StaleWhileRevalidate ({
        cacheName: "map-heightmaps",
        plugins: [
            new ExpirationPlugin({
                maxEntries: 30,
                maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
                purgeOnQuotaError: true,
            }),
        ],
    })
);


// Block all OTHER API requests from being cached
registerRoute(
    ({ url }) => url.pathname.startsWith("/api/"),
    new NetworkOnly()
);


// registerRoute(
//     ({ url }) => url.pathname.includes("/maps/") && url.pathname.endsWith("heightmap.json"),
//     new StaleWhileRevalidate({
//         cacheName: "map-heightmap",
//         plugins: [
//             new ExpirationPlugin({
//                 maxEntries: 30,
//                 maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
//                 purgeOnQuotaError: true,
//             }),
//         ],
//     })
// );

// registerRoute(
//     ({ url }) => url.pathname.includes("/locales/") && url.pathname.endsWith(".json"),
//     new StaleWhileRevalidate({
//         cacheName: "locales",
//         plugins: [
//             new ExpirationPlugin({
//                 maxEntries: 30,
//                 maxAgeSeconds: 60 * 60 * 24 * 30, // 30 days
//                 purgeOnQuotaError: true,
//             }),
//         ],
//     })
// );
