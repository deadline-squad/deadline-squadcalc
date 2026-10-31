import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { clientsClaim } from "workbox-core";
import { registerRoute } from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate, NetworkOnly } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);


// NEVER cache HTML documents
registerRoute(
    ({ request }) => request.mode === "navigate",
    new NetworkOnly()
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
