

importScripts("https://storage.googleapis.com/workbox-cdn/releases/7.1.0/workbox-sw.js");

const { registerRoute, setCatchHandler } = workbox.routing;
const { CacheFirst, StaleWhileRevalidate, NetworkFirst } = workbox.strategies;
const { ExpirationPlugin } = workbox.expiration;
const { CacheableResponsePlugin } = workbox.cacheableResponse;

workbox.core.skipWaiting();
workbox.core.clientsClaim();

/* --- App shell ---------------------------------------------------------- */
registerRoute(
    ({ request }) =>
        request.mode === "navigate" ||
        ["script", "style", "worker"].includes(request.destination),
    new StaleWhileRevalidate({ cacheName: "osmsg-shell-v2" })
);

/* --- API ---------------------------------------------------------------- */
const API_HOSTS = ["osmsg-1.onrender.com", "osmsg.osgeonepal.org"];

registerRoute(
    ({ url }) =>
        API_HOSTS.includes(url.hostname) &&
        (url.pathname.startsWith("/api/") || url.pathname === "/health"),
    new NetworkFirst({
        cacheName: "osmsg-api-v2",
        // Long enough for a sleeping Render dyno to wake (~50s observed).
        networkTimeoutSeconds: 65,
        plugins: [
            // Status 0 is an opaque response; caching those hides real failures.
            new CacheableResponsePlugin({ statuses: [200] }),
            new ExpirationPlugin({
                maxEntries: 80,
                maxAgeSeconds: 60 * 60 * 24, // a day-old response beats no response
                purgeOnQuotaError: true,
            }),
        ],
    })
);

registerRoute(
    ({ url }) =>
        [
            "fonts.googleapis.com",
            "fonts.gstatic.com",
            "cdn.jsdelivr.net",
            "cdn.tailwindcss.com",
            "storage.googleapis.com",
            "github.com",
            "avatars.githubusercontent.com",
            "a.basemaps.cartocdn.com",
            "b.basemaps.cartocdn.com",
            "c.basemaps.cartocdn.com",
            "d.basemaps.cartocdn.com",
        ].includes(url.hostname),
    new CacheFirst({
        cacheName: "osmsg-cdn-v2",
        plugins: [
            new CacheableResponsePlugin({ statuses: [0, 200] }),
            new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 }),
        ],
    })
);

setCatchHandler(async ({ request }) => {
    if (request.destination === "" || request.headers.get("accept")?.includes("json")) {
        return new Response(
            JSON.stringify({
                error: "offline",
                message:
                    "The OSMSG API could not be reached and no cached response was available.",
            }),
            {
                status: 503,
                statusText: "Service Unavailable",
                headers: { "Content-Type": "application/json" },
            }
        );
    }
    return Response.error();
});
