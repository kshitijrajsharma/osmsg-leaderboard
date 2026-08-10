(function () {

  var API_ENVIRONMENTS = {
    render: {
      label: "Render (development)",
      baseUrl: "https://osmsg-1.onrender.com",
      coldStart: true
    },
    production: {
      label: "OSGeo Nepal (production)",
      baseUrl: "https://osmsg.osgeonepal.org",
      coldStart: false
    }
  };

  var ACTIVE_ENV = "render";

  var apiOverride = new URLSearchParams(location.search).get("api");
  var envKey = (apiOverride && API_ENVIRONMENTS[apiOverride]) ? apiOverride : ACTIVE_ENV;
  var env = API_ENVIRONMENTS[envKey] || API_ENVIRONMENTS.production;
  var baseUrl =
    (apiOverride && /^https?:\/\//i.test(apiOverride) && apiOverride.replace(/\/+$/, "")) ||
    env.baseUrl;

  var CONFIG = Object.freeze({
    env: envKey,
    envLabel: env.label,
    isProduction: envKey === "production",
    apiBase: baseUrl,
    apiHost: new URL(baseUrl).hostname,
    apiDocsUrl: baseUrl + "/docs/swagger",
    environments: API_ENVIRONMENTS,

    endpoints: Object.freeze({
      health: "/health",
      stats: "/api/v1/stats",
      hashtagStats: "/api/v1/hashtag-stats",
      editorStats: "/api/v1/editor-stats",
      map: "/api/v1/map"
    }),

    http: Object.freeze({
      timeoutMs: env.coldStart ? 60000 : 20000,
      retries: env.coldStart ? 2 : 1,
      retryBaseDelayMs: 1500,
      cacheTtlMs: 60000
    }),

    window: Object.freeze({
      clampToServerClock: true,
      clampThresholdMs: 60 * 60 * 1000,
      staleWarnMs: 6 * 60 * 60 * 1000,
      allTimeStart: "2004-08-09T00:00:00Z"
    }),

    features: Object.freeze({
      topHashtags: Object.freeze({ limit: 10 }),
      topEditors: Object.freeze({ limit: 10 }),
      changesetClusters: Object.freeze({ limit: 2000 })
    }),

    demo: Object.freeze({
      enabled: false,
      fallbackOnFailure: false,
      globalName: "OSMSG_DEMO",
      badgeLabel: "demo data"
    })
  });

  window.OSMSG_CONFIG = CONFIG;

  var RANGE_HOURS = { "1h": 1, "24h": 24, "7d": 168, "30d": 720, "90d": 2160 };
  var serverLastTs = null;

  function setServerClock(lastTs) {
    serverLastTs = (lastTs instanceof Date && !isNaN(lastTs)) ? lastTs : null;
  }

  function lagMs() {
    if (!serverLastTs) return 0;
    return Math.max(0, Date.now() - serverLastTs.getTime());
  }

  function isStale() {
    return lagMs() >= CONFIG.window.staleWarnMs;
  }

  function lagLabel() {
    var ms = lagMs();
    if (!ms) return "";
    var mins = Math.round(ms / 60000);
    if (mins < 60) return mins + "m behind";
    var hrs = Math.round(mins / 60);
    if (hrs < 48) return hrs + "h behind";
    return Math.round(hrs / 24) + "d behind";
  }

  function resolveWindow(rangeKey, opts) {
    opts = opts || {};
    var now = new Date();

    if (rangeKey === "custom") {
      return {
        start: opts.customStart || new Date(now - 86400000),
        end: opts.customEnd || now,
        anchor: "client",
        clamped: false,
        lagMs: lagMs()
      };
    }

    var shouldClamp =
      CONFIG.window.clampToServerClock &&
      serverLastTs &&
      lagMs() >= CONFIG.window.clampThresholdMs;

    var end = shouldClamp ? new Date(serverLastTs.getTime()) : now;
    var start = rangeKey === "all"
      ? new Date(CONFIG.window.allTimeStart)
      : new Date(end.getTime() - (RANGE_HOURS[rangeKey] || 24) * 3600000);

    return {
      start: start,
      end: end,
      anchor: shouldClamp ? "server" : "client",
      clamped: !!shouldClamp,
      lagMs: lagMs()
    };
  }

  window.OSMSGTime = {
    RANGE_HOURS: RANGE_HOURS,
    resolve: resolveWindow,
    setServerClock: setServerClock,
    getServerClock: function () { return serverLastTs; },
    lagMs: lagMs,
    lagLabel: lagLabel,
    isStale: isStale
  };

  function ApiError(message, opts) {
    opts = opts || {};
    var e = new Error(message);
    e.name = "ApiError";
    e.kind = opts.kind || "network";
    e.status = opts.status || null;
    e.url = opts.url || null;
    e.cause = opts.cause || null;
    e.userMessage = (function () {
      switch (e.kind) {
        case "timeout":
          return "The API took too long to respond. Please try again.";
        case "http":
          return "The API responded with " + e.status + ".";
        case "parse":
          return "The API returned a response that could not be read.";
        default:
          return "Could not reach the API. Check your connection or try again.";
      }
    })();
    return e;
  }

  function buildUrl(endpoint, params) {
    var url = new URL(endpoint, CONFIG.apiBase);
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v == null || v === "") return;
      if (Array.isArray(v)) v.forEach(function (x) { url.searchParams.append(k, String(x)); });
      else url.searchParams.set(k, String(v));
    });
    return url;
  }

  var responseCache = new Map();
  var inflight = new Map();
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  function getJson(url, options) {
    options = options || {};
    var href = String(url);
    var retries = options.retries != null ? options.retries : CONFIG.http.retries;
    var useCache = options.cache !== false;

    if (useCache) {
      var hit = responseCache.get(href);
      if (hit && Date.now() - hit.at < CONFIG.http.cacheTtlMs) return Promise.resolve(hit.data);
      var pending = inflight.get(href);
      if (pending) return pending;
    }

    var run = (async function () {
      var lastError = null;

      for (var attempt = 0; attempt <= retries; attempt++) {
        var ctrl = new AbortController();
        var onAbort = function () { ctrl.abort(); };
        if (options.signal) options.signal.addEventListener("abort", onAbort, { once: true });
        var timedOut = false;
        var timer = setTimeout(function () { timedOut = true; ctrl.abort(); }, CONFIG.http.timeoutMs);

        try {
          var res = await fetch(href, {
            headers: { accept: "application/json" },
            mode: "cors",
            credentials: "omit",
            signal: ctrl.signal
          });

          if (!res.ok) {
            throw ApiError("HTTP " + res.status + " " + (res.statusText || ""),
              { kind: "http", status: res.status, url: href });
          }

          try {
            var data = await res.json();
          } catch (parseErr) {
            throw ApiError("Malformed JSON response", { kind: "parse", url: href, cause: parseErr });
          }

          if (useCache) responseCache.set(href, { at: Date.now(), data: data });
          return data;

        } catch (err) {
          if (options.signal && options.signal.aborted) {
            throw ApiError("Request cancelled", { kind: "abort", url: href, cause: err });
          }

          lastError = err && err.name === "ApiError"
            ? err
            : ApiError(timedOut ? "Request timed out" : (err && err.message) || "Network error",
                { kind: timedOut ? "timeout" : "network", url: href, cause: err });

          if (lastError.kind === "http" && lastError.status < 500) throw lastError;

          if (attempt < retries) {
            await sleep(CONFIG.http.retryBaseDelayMs * Math.pow(2, attempt));
            continue;
          }
          throw lastError;

        } finally {
          clearTimeout(timer);
          if (options.signal) options.signal.removeEventListener("abort", onAbort);
        }
      }

      throw lastError;
    })();

    if (useCache) {
      inflight.set(href, run);
      run.then(function () { inflight.delete(href); },
               function () { inflight.delete(href); });
    }
    return run;
  }

  function toApiTime(d) {
    return (d instanceof Date ? d : new Date(d)).toISOString().replace(/\.\d+Z$/, "Z");
  }

  var EP = CONFIG.endpoints;

  var API = {
    health: function (o) {
      o = o || {};
      return getJson(buildUrl(EP.health, {}), { signal: o.signal });
    },
    hashtagStats: function (o) {
      o = o || {};
      return getJson(buildUrl(EP.hashtagStats, {
        start: toApiTime(o.start), end: toApiTime(o.end),
        limit: o.limit != null ? o.limit : CONFIG.features.topHashtags.limit
      }), { signal: o.signal });
    },
    editorStats: function (o) {
      o = o || {};
      return getJson(buildUrl(EP.editorStats, {
        start: toApiTime(o.start), end: toApiTime(o.end),
        limit: o.limit != null ? o.limit : CONFIG.features.topEditors.limit
      }), { signal: o.signal });
    },
    changesetCentroids: function (o) {
      o = o || {};
      return getJson(buildUrl(EP.map, {
        start: toApiTime(o.start), end: toApiTime(o.end),
        limit: o.limit != null ? o.limit : CONFIG.features.changesetClusters.limit
      }), { signal: o.signal });
    }
  };

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  function normaliseTag(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return null;
    var bare = s.replace(/^#+/, "");
    return bare ? "#" + bare : null;
  }

  function adaptHashtagStats(payload) {
    var raw =
      (payload && Array.isArray(payload.hashtags) && payload.hashtags) ||
      (payload && payload.pagination && Array.isArray(payload.pagination.items) && payload.pagination.items) ||
      (Array.isArray(payload) ? payload : []);

    var items = [];
    raw.forEach(function (row) {
      var tag = normaliseTag(row && (row.hashtag || row.tag || row.name));
      if (!tag) return;
      var rec = {
        tag: tag,
        label: tag,
        changes: num(row.map_changes),
        changesets: num(row.changesets),
        users: num(row.users),
        rank: num(row.rank) || null
      };
      if (rec.changes || rec.changesets || rec.users) items.push(rec);
    });

    items.sort(function (a, b) {
      return (a.rank && b.rank) ? a.rank - b.rank : b.changes - a.changes;
    });

    var totalChanges = 0;
    items.forEach(function (r) { totalChanges += r.changes; });
    items.forEach(function (r, i) {
      r.rank = i + 1;
      r.share = totalChanges ? (r.changes / totalChanges) * 100 : 0;
    });

    var totalChangesets = 0;
    items.forEach(function (r) { totalChangesets += r.changesets; });

    return {
      items: items,
      totalChanges: totalChanges,
      totalChangesets: totalChangesets,
      totalHashtags: (payload && payload.pagination && num(payload.pagination.total)) || items.length
    };
  }

  function editorFamilyOf(raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (!s) return "Unknown";
    if (/streetcomplete/i.test(s)) return "StreetComplete";
    if (/every\s*door/i.test(s)) return "Every Door";
    if (/go\s*map/i.test(s)) return "Go Map!!";
    if (/vespucci/i.test(s)) return "Vespucci";
    if (/rapid/i.test(s)) return "Rapid";
    if (/josm/i.test(s)) return "JOSM";
    if (/organic\s*maps/i.test(s)) return "Organic Maps";
    if (/maps\.?me/i.test(s)) return "MAPS.ME";
    if (/osmand/i.test(s)) return "OsmAnd";
    if (/potlatch/i.test(s)) return "Potlatch";
    if (/\biD\b/.test(s)) return "iD";
    var token = s.split(/[;/(]/)[0].trim();
    return token.length > 22 ? token.slice(0, 20) + "…" : (token || "Unknown");
  }

  function adaptEditorStats(payload) {
    var raw =
      (payload && Array.isArray(payload.editors) && payload.editors) ||
      (payload && payload.pagination && Array.isArray(payload.pagination.items) && payload.pagination.items) ||
      (Array.isArray(payload) ? payload : []);

    var merged = new Map();
    raw.forEach(function (row) {
      var family = editorFamilyOf(row && (row.editor || row.name));
      var e = merged.get(family) || {
        editor: family, label: family, family: family,
        users: 0, changes: 0, changesets: 0, variants: []
      };
      e.users += num(row.users);
      e.changes += num(row.map_changes);
      e.changesets += num(row.changesets);
      if (row && row.editor && row.editor !== family) e.variants.push(String(row.editor));
      merged.set(family, e);
    });

    var items = [];
    merged.forEach(function (e) {
      if (e.users || e.changes || e.changesets) items.push(e);
    });
    items.sort(function (a, b) { return b.changes - a.changes; });

    var totalChanges = 0, totalUsers = 0, totalChangesets = 0;
    items.forEach(function (e) {
      totalChanges += e.changes; totalUsers += e.users; totalChangesets += e.changesets;
    });
    items.forEach(function (e, i) {
      e.rank = i + 1;
      e.share = totalChanges ? (e.changes / totalChanges) * 100 : 0;
      e.changesPerUser = e.users ? Math.round(e.changes / e.users) : 0;
    });

    return {
      items: items,
      totalUsers: totalUsers,
      totalChanges: totalChanges,
      totalChangesets: totalChangesets,
      totalEditors: items.length
    };
  }

  function validLatLon(lat, lon) {
    return isFinite(lat) && isFinite(lon) &&
      lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
      !(lat === 0 && lon === 0);
  }

  function adaptChangesetCentroids(payload) {
    var features =
      (payload && Array.isArray(payload.features) && payload.features) ||
      (payload && payload.pagination && Array.isArray(payload.pagination.items) && payload.pagination.items) ||
      (Array.isArray(payload) ? payload : []);

    var points = [];
    var minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;

    features.forEach(function (f) {
      var coords = f && f.geometry && f.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) return;

      var lon = Number(coords[0]), lat = Number(coords[1]);
      if (!validLatLon(lat, lon)) return;

      var p = f.properties || {};

      var derived =
        num(p.nodes_create) + num(p.nodes_modify) + num(p.nodes_delete) +
        num(p.ways_create) + num(p.ways_modify) + num(p.ways_delete) +
        num(p.rels_create) + num(p.rels_modify) + num(p.rels_delete);

      points.push({
        id: p.changeset_id != null ? p.changeset_id : (lat + "," + lon + "," + points.length),
        lat: lat,
        lon: lon,
        user: p.name || "Unknown",
        uid: p.uid != null ? p.uid : null,
        editor: p.editor || null,
        hashtags: Array.isArray(p.hashtags) ? p.hashtags : [],
        changes: num(p.map_changes) || derived,
        at: p.created_at ? new Date(p.created_at) : null
      });

      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    });

    return {
      points: points,
      returned: points.length,
      total: (payload && payload.pagination && num(payload.pagination.total)) || points.length,
      bounds: points.length ? [[minLat, minLon], [maxLat, maxLon]] : null
    };
  }

  function demoBag() {
    if (!CONFIG.demo.enabled && !CONFIG.demo.fallbackOnFailure) return null;
    return window[CONFIG.demo.globalName] || null;
  }

  function isEmptyModel(kind, data) {
    if (!data) return true;
    if (kind === "changesets") return !data.points || data.points.length === 0;
    return !data.items || data.items.length === 0;
  }

  function tryDemo(kind, adapt, pick) {
    var bag = demoBag();
    if (!bag) return null;
    try {
      var raw = pick(bag);
      if (!raw) return null;
      var data = adapt(raw);
      if (isEmptyModel(kind, data)) return null;
      return { status: "ok", data: data, source: "demo", error: null };
    } catch (err) {
      console.warn("[OSMSG] Demo fixture could not be read:", err);
      return null;
    }
  }

  async function resolveSource(kind, fetchLive, adapt, pick) {
    if (CONFIG.demo.enabled) {
      var only = tryDemo(kind, adapt, pick);
      if (only) return only;
      return {
        status: "error", data: null, source: "demo",
        error: new Error("Demo mode is on but window." + CONFIG.demo.globalName + " is missing.")
      };
    }

    try {
      var raw = await fetchLive();
      var data = adapt(raw);
      if (!isEmptyModel(kind, data)) {
        return { status: "ok", data: data, source: "live", error: null };
      }
      var fb = tryDemo(kind, adapt, pick);
      if (fb) { fb.reason = "empty-window"; return fb; }
      return { status: "empty", data: data, source: "live", error: null };

    } catch (error) {
      if (error && error.kind === "abort") throw error;
      var fb2 = tryDemo(kind, adapt, pick);
      if (fb2) { fb2.reason = "api-error"; fb2.error = error; return fb2; }
      return { status: "error", data: null, source: "live", error: error };
    }
  }

  window.OSMSGData = {
    getTopHashtags: function (o) {
      o = o || {};
      return resolveSource("hashtags",
        function () { return API.hashtagStats(o); },
        adaptHashtagStats,
        function (d) { return d.hashtagStats; });
    },

    getTopEditors: function (o) {
      o = o || {};
      return resolveSource("editors",
        function () { return API.editorStats(o); },
        adaptEditorStats,
        function (d) { return d.editorStats; });
    },

    getChangesetClusters: function (o) {
      o = o || {};
      return resolveSource("changesets",
        function () { return API.changesetCentroids(o); },
        adaptChangesetCentroids,
        function (d) { return d.changesetCentroids; });
    },

    _api: API,
    _adapters: {
      hashtags: adaptHashtagStats,
      editors: adaptEditorStats,
      changesets: adaptChangesetCentroids,
      editorFamilyOf: editorFamilyOf
    }
  };

})();

const CONFIG = window.OSMSG_CONFIG;
if (!CONFIG) throw new Error("OSMSG: the configuration block at the top of app.js failed to run.");

const API_BASE = CONFIG.apiBase;
const ENDPOINTS = CONFIG.endpoints;
const API_DOCS_URL = CONFIG.apiDocsUrl;
const API_HOST = CONFIG.apiHost;

const OSM_API_BASE = "https://api.openstreetmap.org";

const ALL_TIME_START = CONFIG.window.allTimeStart;
const RANGE_HOURS = window.OSMSGTime.RANGE_HOURS;
const RANGE_LABELS = {
  "1h": "last hour",
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
  all: "all-time",
  custom: "custom range",
};
const REFRESH_INTERVAL_MS = 60_000;
const FETCH_TIMEOUT_MS = CONFIG.http.timeoutMs;
const FETCH_RETRIES = CONFIG.http.retries;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const fmt = new Intl.NumberFormat("en-US");

const dtf = (opts) =>
  new Intl.DateTimeFormat(undefined, { ...opts, hour12: false, timeZone: TZ });
const dtfFull = dtf({
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});
const dtfShort = dtf({
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const dtfDate = dtf({ year: "numeric", month: "short", day: "2-digit" });
const dtfClock = dtf({ hour: "2-digit", minute: "2-digit", second: "2-digit" });

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const refreshIcons = (root) =>
  window.lucide?.createIcons?.(
    root
      ? {
          attrs: { "stroke-width": 2 },
          nameAttr: "data-lucide",
          icons: window.lucide.icons,
        }
      : { attrs: { "stroke-width": 2 } }
  );

const isoUTC = (d) => d.toISOString().replace(/\.\d+Z$/, "Z");
const nowUTC = () => new Date();

function tzOffsetLabel() {
  const m = -new Date().getTimezoneOffset(),
    s = m >= 0 ? "+" : "−",
    a = Math.abs(m);
  return `UTC${s}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

function ago(d) {
  if (!d) return "never";
  const s = Math.max(0, Math.round((Date.now() - d) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = (s / 60) | 0;
  if (m < 60) return `${m}m ago`;
  const h = (m / 60) | 0;
  if (h < 24) return `${h}h ago`;
  return `${(h / 24) | 0}d ago`;
}

function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return ["#2D5F3F", "#3A6E4A", "#1F4D2E", "#4A7C5C", "#1F5C3D"][h % 5];
}

function initials(name) {
  if (!name) return "?";
  const p = name
    .replace(/[_\-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return (
    p.length === 1 ? p[0].slice(0, 2) : p[0][0] + p.at(-1)[0]
  ).toUpperCase();
}

function shortEditor(s) {
  if (!s) return "Unknown";
  const iD = s.match(/iD\s*([\d.]+)/i);   if (iD)   return "iD " + iD[1];
  const josm = s.match(/JOSM\/([\d.]+)/i); if (josm) return "JOSM " + josm[1];
  const rapid = s.match(/Rapid\s*([\d.]+)/i); if (rapid) return "Rapid " + rapid[1];
  if (/Vespucci/i.test(s))       return "Vespucci";
  if (/StreetComplete/i.test(s)) return "StreetComplete";
  if (/OsmAnd/i.test(s))        return "OsmAnd";
  return s.length > 22 ? s.slice(0, 20) + "…" : s;
}

function editorFamily(s) {
  if (!s) return null;
  if (/iD/i.test(s))            return "iD";
  if (/JOSM/i.test(s))          return "JOSM";
  if (/Rapid/i.test(s))         return "Rapid";
  if (/Vespucci/i.test(s))      return "Vespucci";
  if (/StreetComplete/i.test(s)) return "StreetComplete";
  return null;
}

function editorColor(family) {
  const map = {
    iD:             ["#E6F1FB", "#185FA5"],
    JOSM:           ["#FAEEDA", "#854F0B"],
    Rapid:          ["#EEEDFE", "#534AB7"],
    Vespucci:       ["#EAF3DE", "#3B6D11"],
    StreetComplete: ["#FAECE7", "#993C1D"],
  };
  return map[family] || ["#F1EFE8", "#5F5E5A"];
}

const state = {
  hashtags: [],
  range: "24h",
  customStart: null,
  customEnd: null,
  live: true,
  rows: [],
  filteredRows: [],
  sort: { key: "map_changes", dir: "desc" },
  filter: "all",
  search: "",
  windowStart: null,
  windowEnd: null,
  lastFetched: null,
  lastError: null,
  health: null,
  loading: false,
  status: "loading",
  refreshTimer: null,
  agoTimer: null,
  clockTimer: null,
  inflight: null,
  page: 1,
  pageSize: 25,
  windowAnchor: "client",
  windowClamped: false,
};

function rangeWindow(k) {
  const r = window.OSMSGTime.resolve(k, {
    customStart: state.customStart,
    customEnd: state.customEnd,
  });
  state.windowAnchor = r.anchor;
  state.windowClamped = r.clamped;
  return { start: r.start, end: r.end };
}

function apiUrl(endpoint, params = {}) {
  const url = new URL(endpoint, API_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, String(x)));
    else url.searchParams.set(k, String(v));
  }
  return url;
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { signal, retries = FETCH_RETRIES } = {}) {
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        mode: "cors",
        credentials: "omit",
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} ${res.statusText || ""}`.trim());
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      if (signal?.aborted) {
        const abortErr = new Error("Request cancelled");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      lastErr = err;
      if (err.status >= 400 && err.status < 500) throw err;
      if (attempt < retries) {
        await _sleep(CONFIG.http.retryBaseDelayMs * Math.pow(2, attempt));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  throw lastErr;
}

const fetchHealth = () => getJson(apiUrl(ENDPOINTS.health));

const fetchStats = ({ start, end, hashtags = [], tags, limit, signal } = {}) =>
  getJson(
    apiUrl(ENDPOINTS.stats, {
      start: isoUTC(start),
      end: isoUTC(end),
      hashtag: hashtags,
      tags,
      limit,
    }),
    { signal }
  );

const osmAvatarCache = new Map();
function fetchOsmAvatar(uid) {
  if (uid == null) return Promise.resolve(null);
  const key = String(uid);
  if (osmAvatarCache.has(key)) return osmAvatarCache.get(key);
  const p = fetch(
    `${OSM_API_BASE}/api/0.6/user/${encodeURIComponent(key)}.json`,
    { headers: { Accept: "application/json" } }
  )
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => j?.user?.img?.href || null)
    .catch(() => null);
  osmAvatarCache.set(key, p);
  return p;
}

const userEditorCache = new Map();
async function fetchUserEditor(uid, start, end) {
  const key = String(uid);
  if (userEditorCache.has(key)) return userEditorCache.get(key);
  try {
    const url = `${OSM_API_BASE}/api/0.6/changesets.json?user=${encodeURIComponent(key)}&time=${isoUTC(start)},${isoUTC(end)}&limit=1`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error();
    const json = await res.json();
    const editor = json?.changesets?.[0]?.tags?.created_by || null;
    userEditorCache.set(key, editor);
    return editor;
  } catch {
    userEditorCache.set(key, null);
    return null;
  }
}

const api = { apiUrl, fetchHealth, fetchStats, fetchOsmAvatar, fetchUserEditor };

function sumTagKey(ts, k) {
  const n = ts[k];
  if (!n) return { c: 0, m: 0 };
  let c = 0, m = 0;
  for (const v in n) {
    c += n[v].c;
    m += n[v].m;
  }
  return { c, m };
}

function transform(row) {
  const ts = row.tag_stats || {};
  const b = sumTagKey(ts, "building"),
    h = sumTagKey(ts, "highway");
  const lu = sumTagKey(ts, "landuse"),
    wt = sumTagKey(ts, "waterway");
  const nt = sumTagKey(ts, "natural"),
    am = sumTagKey(ts, "amenity");
  return {
    uid: row.uid,
    username: row.name,
    hashtags: row.hashtags || [],
    rank: row.rank,
    changesets: row.changesets,
    map_changes: row.map_changes,
    nodes_created: row.nodes_create,
    nodes_modified: row.nodes_modify,
    nodes_deleted: row.nodes_delete,
    ways_created: row.ways_create,
    ways_modified: row.ways_modify,
    ways_deleted: row.ways_delete,
    rels_created: row.rels_create,
    rels_modified: row.rels_modify,
    rels_deleted: row.rels_delete,
    pois_created: row.poi_create,
    pois_modified: row.poi_modify,
    buildings_created: b.c,
    buildings_modified: b.m,
    highways_created: h.c,
    highways_modified: h.m,
    landuse_created: lu.c,
    landuse_modified: lu.m,
    waterways_created: wt.c,
    waterways_modified: wt.m,
    natural_created: nt.c,
    natural_modified: nt.m,
    amenities_created: am.c,
    amenities_modified: am.m,
    created: row.nodes_create + row.ways_create + row.rels_create,
    modified: row.nodes_modify + row.ways_modify + row.rels_modify,
    deleted: row.nodes_delete + row.ways_delete + row.rels_delete,
    tag_stats: ts,
  };
}

function aggregateTagStats(rows) {
  const agg = {};
  for (const r of rows) {
    const ts = r.tag_stats;
    for (const key in ts) {
      const vals = ts[key];
      const a = (agg[key] ||= { values: {}, totalC: 0, totalM: 0 });
      for (const v in vals) {
        const c = vals[v].c, m = vals[v].m;
        const slot = (a.values[v] ||= { c: 0, m: 0 });
        slot.c += c;
        slot.m += m;
        a.totalC += c;
        a.totalM += m;
      }
    }
  }
  return agg;
}

function applyAvatar(el, uid, fallbackText) {
  if (!el) return;
  api.fetchOsmAvatar(uid).then((url) => {
    if (!url) return;
    if (el.dataset.osmUid !== String(uid)) return;
    el.innerHTML = `<img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.parentNode.textContent=${JSON.stringify(fallbackText)}">`;
  });
}

const hashtagInput = $("#hashtag-input"),
  chipsEl = $("#chips");
function renderChips() {
  chipsEl.innerHTML = state.hashtags
    .map(
      (h, i) =>
        `<span class="chip">#${escapeHtml(h)}<button type="button" data-i="${i}" aria-label="Remove ${escapeHtml(h)}"><i data-lucide="x"></i></button></span>`
    )
    .join("");
  chipsEl.querySelectorAll("button").forEach(
    (b) =>
      (b.onclick = () => {
        state.hashtags.splice(+b.dataset.i, 1);
        renderChips();
        apply();
      })
  );
  refreshIcons();
}
function addHashtag(raw) {
  const h = raw.trim().replace(/^#/, "").toLowerCase();
  if (!h || state.hashtags.includes(h)) return false;
  state.hashtags.push(h);
  renderChips();
  return true;
}
hashtagInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    if (hashtagInput.value.trim() && addHashtag(hashtagInput.value)) {
      hashtagInput.value = "";
      apply();
    } else hashtagInput.value = "";
  } else if (
    e.key === "Backspace" &&
    !hashtagInput.value &&
    state.hashtags.length
  ) {
    state.hashtags.pop();
    renderChips();
    apply();
  }
});
hashtagInput.addEventListener("blur", () => {
  if (hashtagInput.value.trim() && addHashtag(hashtagInput.value)) {
    hashtagInput.value = "";
    apply();
  }
});

const customRangePanel = $("#custom-range"),
  crRangeInput = $("#cr-range"),
  crClearBtn = $("#cr-clear");

const dateToUtcInput = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};
const utcInputToDate = (d) =>
  new Date(
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), 0)
  );

let crPicker = null;
function initCustomRangePicker() {
  if (crPicker || typeof window.flatpickr !== "function") return;
  crPicker = window.flatpickr(crRangeInput, {
    mode: "range",
    enableTime: true,
    time_24hr: true,
    dateFormat: "Y-m-d H:i",
    minuteIncrement: 5,
    allowInput: false,
    disableMobile: true,
    onChange: (dates) => {
      crClearBtn.hidden = dates.length === 0;
      if (dates.length !== 2) return;
      const s = utcInputToDate(dates[0]),
        e = utcInputToDate(dates[1]);
      if (s >= e)
        return toast({ msg: "Start must be before end", icon: "alert-triangle", err: true });
      state.customStart = s;
      state.customEnd = e;
      state.range = "custom";
      apply();
    },
  });
}
crClearBtn?.addEventListener("click", () => {
  crPicker?.clear();
  state.customStart = state.customEnd = null;
  crClearBtn.hidden = true;
});

function setRangePreset(k) {
  $$(".preset button").forEach((b) =>
    b.setAttribute("aria-pressed", b.dataset.range === k ? "true" : "false")
  );
  state.range = k;
  customRangePanel.classList.toggle("show", k === "custom");
  if (k === "custom") {
    initCustomRangePicker();
    if (!state.customStart || !state.customEnd) {
      const end = nowUTC(),
        start = new Date(end - 86400000);
      crPicker?.setDate([dateToUtcInput(start), dateToUtcInput(end)], false);
      crClearBtn.hidden = false;
    } else {
      crPicker?.setDate(
        [dateToUtcInput(state.customStart), dateToUtcInput(state.customEnd)],
        false
      );
      crClearBtn.hidden = false;
    }
  }
}
$$(".preset button").forEach(
  (b) =>
    (b.onclick = () => {
      setRangePreset(b.dataset.range);
      if (b.dataset.range !== "custom") {
        state.customStart = state.customEnd = null;
        apply();
      }
    })
);

const statusPill = $("#status-pill"),
  statusIconEl = $("#status-icon"),
  statusText = $("#status-text");
const STATUS_CFG = {
  loading: ["loader", true, "Connecting", "Fetching latest stats from the OSMSG API…"],
  live: ["cloud", false, "Connected", "Connected. Auto-refreshing every 60 seconds. Click to pause."],
  paused: ["pause", false, "Paused", "Auto-refresh paused. Click to resume."],
  error: ["cloud-off", false, "Disconnected", "Couldn't reach the OSMSG API. Click to retry."],
};
function setStatus(s) {
  state.status = s;
  statusPill.dataset.state = s;
  const [ic, spin, txt, title] = STATUS_CFG[s];
  statusIconEl.setAttribute("data-lucide", ic);
  statusIconEl.classList.toggle("ico-spin", spin);
  statusText.textContent = txt;
  statusPill.title = title;
  refreshIcons();
}
statusPill.addEventListener("click", () => {
  if (state.status === "loading") return;
  if (state.status === "error") return fetchData({});
  state.live = !state.live;
  if (state.live) {
    setStatus("live");
    startAutoRefresh();
    fetchData({ silent: true });
  } else {
    setStatus("paused");
    stopAutoRefresh();
  }
});

const startAutoRefresh = () => {
  stopAutoRefresh();
  if (state.range === "all" || state.range === "custom") return;
  state.refreshTimer = setInterval(() => fetchData({ silent: true }), REFRESH_INTERVAL_MS);
};
const stopAutoRefresh = () => {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = null;
};

$("#query-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (hashtagInput.value.trim()) {
    addHashtag(hashtagInput.value);
    hashtagInput.value = "";
  }
  apply();
});

function apply() {
  state.page = 1;
  writeURL();
  fetchData({});
  state.live ? startAutoRefresh() : stopAutoRefresh();
}

document.addEventListener("osmsg:filter-hashtag", (e) => {
  const tag = e.detail?.tag;
  if (!tag) return;
  addHashtag(tag);
  apply();
  document.querySelector(".search-card")?.scrollIntoView({
    behavior: "smooth",
    block: "center",
  });
  toast({ msg: `Filtering by ${tag}`, icon: "hash" });
});

function publishWindow(start, end) {
  window.OSMSG_ACTIVE_WINDOW = { start, end, range: state.range };
  document.dispatchEvent(
    new CustomEvent("osmsg:window", {
      detail: { start, end, range: state.range, hashtags: state.hashtags.slice() },
    })
  );
}

async function fetchData({ silent = false } = {}) {
  state.inflight?.abort();
  state.loading = true;
  if (!silent) showLoading();
  setStatus("loading");

  if (!state.healthCheckedAt || Date.now() - state.healthCheckedAt > 60_000) {
    await refreshHealth();
  }

  const { start, end } = rangeWindow(state.range);
  state.windowStart = start;
  state.windowEnd = end;
  const ctrl = new AbortController();
  state.inflight = ctrl;
  renderWindowBar();
  publishWindow(start, end);

  try {
    const json = await api.fetchStats({
      start,
      end,
      hashtags: state.hashtags,
      signal: ctrl.signal,
    });
    state.rows = (json.users || []).map(transform);
    state.lastFetched = new Date();
    state.lastError = null;
    render();
    updateLastUpdated();
    if (!silent && state.rows.length)
      toast({ msg: "Updated", icon: "check-circle-2" });
    setStatus(state.live ? "live" : "paused");
  } catch (err) {
    if (err?.name === "AbortError" && state.inflight !== ctrl) return;
    console.warn("OSMSG API fetch failed:", err);
    state.lastError = err;
    setStatus("error");
    if (!silent) showError(err);
    else toast({ msg: "Reconnect failed", icon: "cloud-off", err: true });
  } finally {
    state.loading = false;
    if (state.inflight === ctrl) state.inflight = null;
  }
}

let toastTimer;
function toast({ msg, icon = "info", err = false } = {}) {
  const t = $("#toast");
  t.innerHTML = `<i data-lucide="${icon}"></i>${escapeHtml(msg)}`;
  t.classList.toggle("err", !!err);
  t.classList.add("show");
  refreshIcons();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

function applyDerivedFilters() {
  const q = state.search.trim().toLowerCase();
  let rows = state.rows.slice();
  if (q) rows = rows.filter((r) => r.username.toLowerCase().includes(q));
  if (state.filter === "creators")
    rows = rows.filter((r) => r.created > r.modified);
  if (state.filter === "modifiers")
    rows = rows.filter((r) => r.modified >= r.created);
  const { key, dir } = state.sort,
    mul = dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    let av = a[key] ?? 0,
      bv = b[key] ?? 0;
    if (typeof av === "string") {
      av = av.toLowerCase();
      bv = (bv || "").toLowerCase();
    }
    return av < bv ? -mul : av > bv ? mul : 0;
  });
  state.filteredRows = rows;
  state.page = Math.min(
    state.page,
    Math.max(1, Math.ceil(rows.length / state.pageSize))
  );
}

function render() {
  applyDerivedFilters();
  renderOverview();
  renderPodium();
  renderTable();
  renderWindowBar();
}

function tagBreakdownHtml(agg, { maxKeys = 10 } = {}) {
  const keys = Object.entries(agg)
    .filter(([, v]) => v.totalC + v.totalM > 0)
    .sort((a, b) => b[1].totalC + b[1].totalM - (a[1].totalC + a[1].totalM));
  if (!keys.length) return { html: "", keyCount: 0, valueCount: 0 };
  const valueCount = keys.reduce((s, [, v]) => s + Object.keys(v.values).length, 0);
  const pct = (n, t) => (t ? (n / t) * 100 : 0);
  const segDiv = (cls, w) => (w > 0 ? `<div class="${cls}" style="width:${w}%"></div>` : "");
  const cntC = (n) => (n ? `<span class="c">+${fmt.format(n)}</span>` : "");
  const cntM = (n) => (n ? `<span class="m">~${fmt.format(n)}</span>` : "");

  let html =
    `<div class="tag-breakdown-grid">` +
    keys
      .slice(0, maxKeys)
      .map(([key, d]) => {
        const t = d.totalC + d.totalM;
        return `<div class="tag-key-card">
      <div class="tag-key-head">
        <span class="tag-key-name">${escapeHtml(key)}</span>
        <span class="tag-key-totals">${cntC(d.totalC)}${cntM(d.totalM)}</span>
      </div>
      <div class="tag-key-bar" title="${d.totalC} created · ${d.totalM} modified">
        ${segDiv("seg-c", pct(d.totalC, t))}${segDiv("seg-m", pct(d.totalM, t))}
      </div>
    </div>`;
      })
      .join("") +
    `</div>`;
  if (keys.length > maxKeys)
    html += `<div class="tag-key-more" style="margin-top:10px;text-align:center">+ ${fmt.format(keys.length - maxKeys)} more key${keys.length - maxKeys === 1 ? "" : "s"} not shown</div>`;
  return { html, keyCount: keys.length, valueCount };
}

const OV_CELLS_TOTALS = [
  ["Created", "created", "plus-square", "ov-add"],
  ["Modified", "modified", "edit-3", "ov-mod"],
  ["Deleted", "deleted", "trash-2", "ov-del"],
  ["Mappers", "mappers", "users", ""],
  ["Changesets", "changesets", "git-commit-horizontal", ""],
];
const OV_CELLS = [
  ["Nodes", "nodes", "circle-dot", "elem"],
  ["Ways", "ways", "spline", "elem"],
  ["Relations", "rels", "share-2", "elem"],
  ["Buildings", "buildings", "building-2", "split"],
  ["Highways", "highways", "route", "split"],
  ["POIs", "pois", "map-pin", "split"],
  ["Landuse", "landuse", "layers", "split"],
  ["Waterways", "waterways", "waves", "split"],
  ["Natural", "natural", "trees", "split"],
  ["Amenities", "amenities", "coffee", "split"],
];
const renderOvCell =
  (data) =>
  ([l, k, ic, mod]) => {
    if (mod === "split") {
      const c = data[k] || 0, m = data[k + "_mod"] || 0;
      const isZero = !c && !m;
      return `<div class="ov-cell ov-split${isZero ? " is-zero" : ""}">
      <div class="lbl"><i data-lucide="${ic}"></i>${l}</div>
      <div class="val"><span class="c">+${fmt.format(c)}</span><span class="m">~${fmt.format(m)}</span></div>
    </div>`;
    }
    if (mod === "elem") {
      const c = data[k + "_c"] || 0, m = data[k + "_m"] || 0, d = data[k + "_d"] || 0;
      const isZero = !c && !m && !d;
      return `<div class="ov-cell ov-elem${isZero ? " is-zero" : ""}">
      <div class="lbl"><i data-lucide="${ic}"></i>${l}</div>
      <div class="val"><span class="c" title="created">+${fmt.format(c)}</span><span class="m" title="modified">~${fmt.format(m)}</span><span class="d" title="deleted">−${fmt.format(d)}</span></div>
    </div>`;
    }
    return `<div class="ov-cell${mod ? " " + mod : ""}${data[k] ? "" : " is-zero"}">
    <div class="lbl"><i data-lucide="${ic}"></i>${l}</div>
    <div class="val">${fmt.format(data[k] || 0)}</div>
  </div>`;
  };
const ovCellsHtml = (data) => OV_CELLS.map(renderOvCell(data)).join("");
const ovTotalsHtml = (data) => OV_CELLS_TOTALS.map(renderOvCell(data)).join("");
const rowTotals = (rows) =>
  rows.reduce(
    (a, r) => {
      a.created += r.created;
      a.modified += r.modified;
      a.deleted += r.deleted;
      a.changesets += r.changesets;
      a.nodes_c += r.nodes_created;
      a.nodes_m += r.nodes_modified;
      a.nodes_d += r.nodes_deleted;
      a.ways_c += r.ways_created;
      a.ways_m += r.ways_modified;
      a.ways_d += r.ways_deleted;
      a.rels_c += r.rels_created;
      a.rels_m += r.rels_modified;
      a.rels_d += r.rels_deleted;
      a.buildings += r.buildings_created;
      a.buildings_mod += r.buildings_modified;
      a.highways += r.highways_created;
      a.highways_mod += r.highways_modified;
      a.pois += r.pois_created;
      a.pois_mod += r.pois_modified;
      a.landuse += r.landuse_created;
      a.landuse_mod += r.landuse_modified;
      a.waterways += r.waterways_created;
      a.waterways_mod += r.waterways_modified;
      a.natural += r.natural_created;
      a.natural_mod += r.natural_modified;
      a.amenities += r.amenities_created;
      a.amenities_mod += r.amenities_modified;
      return a;
    },
    {
      created: 0, modified: 0, deleted: 0, changesets: 0,
      nodes_c: 0, nodes_m: 0, nodes_d: 0,
      ways_c: 0, ways_m: 0, ways_d: 0,
      rels_c: 0, rels_m: 0, rels_d: 0,
      buildings: 0, buildings_mod: 0,
      highways: 0, highways_mod: 0,
      pois: 0, pois_mod: 0,
      landuse: 0, landuse_mod: 0,
      waterways: 0, waterways_mod: 0,
      natural: 0, natural_mod: 0,
      amenities: 0, amenities_mod: 0,
    }
  );

function renderOverview() {
  const strip = $("#ov-strip"),
    totals = $("#ov-strip-totals"),
    breakdown = $("#ov-breakdown");
  const details = $("#ov-details");
  const meta = $("#ov-breakdown-meta"),
    btn = $("#ov-toggle-btn"),
    label = $("#ov-toggle-label");
  if (!state.rows.length) {
    totals.innerHTML = `<div class="tag-stats-empty" style="grid-column:1/-1">No data in this window. Try a wider time range or a different hashtag.</div>`;
    strip.innerHTML = "";
    breakdown.innerHTML = "";
    details.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    btn.disabled = true;
    meta.textContent = "";
    return;
  }
  const data = { ...rowTotals(state.rows), mappers: state.rows.length };
  totals.innerHTML = ovTotalsHtml(data);
  strip.innerHTML = ovCellsHtml(data);
  const { html, keyCount, valueCount } = tagBreakdownHtml(aggregateTagStats(state.rows));
  if (keyCount) {
    breakdown.innerHTML = html;
    meta.textContent = `${fmt.format(keyCount)} tag key${keyCount === 1 ? "" : "s"} · ${fmt.format(valueCount)} value${valueCount === 1 ? "" : "s"} available`;
  } else {
    breakdown.innerHTML = `<div class="tag-stats-empty">No detailed tag stats reported in this window.</div>`;
    meta.textContent = "element breakdown only";
  }
  btn.disabled = false;
  const expanded = btn.getAttribute("aria-expanded") === "true";
  details.hidden = !expanded;
  label.textContent = expanded ? "Hide details" : "Show details";
  refreshIcons();
}

function renderPodium() {
  const top3 = state.rows
    .slice()
    .sort((a, b) => b.map_changes - a.map_changes)
    .slice(0, 3);
  const el = $("#podium");

  if (!top3.length) {
    el.innerHTML = `<div class="empty" style="grid-column:1/-1"><i data-lucide="users"></i><h3>No contributors yet</h3><p>Try a different time range or hashtag.</p></div>`;
    return refreshIcons(el);
  }

  el.innerHTML = "";

  for (let i = 0; i < 3; i++) {
    const r = top3[i];
    const place = i + 1;
    const div = document.createElement("div");
    div.className = `pod pod-${place} fade-in`;

    if (!r) {
      div.style.opacity = "0.4";
      div.innerHTML = `<span class="pod-rank">${place}</span><span class="pod-avatar">·</span><span class="pod-name">—</span><span class="pod-score-wrap"><span class="pod-score">0</span></span>`;
      el.appendChild(div);
      continue;
    }

    const created  = (r.nodes_created  || 0) + (r.ways_created  || 0) + (r.rels_created  || 0);
    const modified = (r.nodes_modified || 0) + (r.ways_modified || 0) + (r.rels_modified || 0);
    const deleted  = (r.nodes_deleted  || 0) + (r.ways_deleted  || 0) + (r.rels_deleted  || 0);

    div.innerHTML = `
      <span class="pod-rank">${place}</span>
      <span class="pod-avatar" data-osm-uid="${r.uid}" style="background:${avatarColor(r.username)}">${initials(r.username)}</span>
      <span class="pod-name" title="${escapeHtml(r.username)}">${escapeHtml(r.username)}</span>
      <span class="pod-score-wrap">
        <div class="pod-score-line">
          <span class="pod-score">${fmt.format(r.map_changes)}</span>
          <span class="pod-cs" title="changesets">
            <i data-lucide="git-commit-horizontal"></i>${fmt.format(r.changesets || 0)}
          </span>
        </div>
        <div class="pod-score-label">changes · changesets</div>
      </span>
      <div class="pod-mini" aria-label="Created, modified, deleted">
        <span class="c" title="created"><i data-lucide="plus"></i>${fmt.format(created)}</span>
        <span class="m" title="modified"><i data-lucide="pencil"></i>${fmt.format(modified)}</span>
        <span class="d" title="deleted"><i data-lucide="minus"></i>${fmt.format(deleted)}</span>
      </div>`;

    applyAvatar(div.querySelector(".pod-avatar"), r.uid, initials(r.username));
    div.addEventListener("click", () => openUserModal(r.username));
    div.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openUserModal(r.username); }
    });
    el.appendChild(div);
  }
  refreshIcons(el);
}

const USER_TOTAL_CELLS = [
  ["Created", "created", "plus-square", "ov-add"],
  ["Modified", "modified", "edit-3", "ov-mod"],
  ["Deleted", "deleted", "trash-2", "ov-del"],
  ["Changesets", "changesets", "git-commit-horizontal", ""],
  ["Buildings", "buildings", "building-2", "split"],
  ["Highways", "highways", "route", "split"],
  ["POIs", "pois", "map-pin", "split"],
  ["Landuse", "landuse", "layers", "split"],
  ["Waterways", "waterways", "waves", "split"],
  ["Natural", "natural", "trees", "split"],
  ["Amenities", "amenities", "coffee", "split"],
];
const USER_ELEM_GROUPS = [
  ["Nodes", "circle-dot", "nodes_created", "nodes_modified", "nodes_deleted"],
  ["Ways", "spline", "ways_created", "ways_modified", "ways_deleted"],
  ["Relations", "share-2", "rels_created", "rels_modified", "rels_deleted"],
];
const elemCellsHtml = (r) =>
  USER_ELEM_GROUPS.map(([l, ic, ck, mk, dk]) => {
    const c = r[ck] || 0, m = r[mk] || 0, d = r[dk] || 0;
    const isZero = !c && !m && !d;
    return `<div class="ov-cell ov-elem${isZero ? " is-zero" : ""}">
    <div class="lbl"><i data-lucide="${ic}"></i>${l}</div>
    <div class="val">
      <span class="c" title="created">+${fmt.format(c)}</span>
      <span class="m" title="modified">~${fmt.format(m)}</span>
      <span class="d" title="deleted">−${fmt.format(d)}</span>
    </div>
  </div>`;
  }).join("");

const SPLIT_KEY_MAP = {
  buildings: ["buildings_created", "buildings_modified"],
  highways: ["highways_created", "highways_modified"],
  pois: ["pois_created", "pois_modified"],
  landuse: ["landuse_created", "landuse_modified"],
  waterways: ["waterways_created", "waterways_modified"],
  natural: ["natural_created", "natural_modified"],
  amenities: ["amenities_created", "amenities_modified"],
};
const cellsHtml = (cells, r) =>
  cells
    .map(([l, k, ic, mod]) => {
      if (mod === "split") {
        const [ck, mk] = SPLIT_KEY_MAP[k];
        const c = r[ck] || 0, m = r[mk] || 0;
        const isZero = !c && !m;
        return `<div class="ov-cell ov-split${isZero ? " is-zero" : ""}">
      <div class="lbl"><i data-lucide="${ic}"></i>${l}</div>
      <div class="val"><span class="c">+${fmt.format(c)}</span><span class="m">~${fmt.format(m)}</span></div>
    </div>`;
      }
      return `<div class="ov-cell${mod ? " " + mod : ""}${r[k] ? "" : " is-zero"}">
    <div class="lbl"><i data-lucide="${ic}"></i>${l}</div>
    <div class="val">${fmt.format(r[k] || 0)}</div>
  </div>`;
    })
    .join("");

function openUserModal(username) {
  const r = state.rows.find((x) => x.username === username);
  if (!r) return;
  const modal = $("#user-modal");

  $("#user-modal-name").innerHTML = `
    <a href="https://www.openstreetmap.org/user/${encodeURIComponent(r.username)}"
       target="_blank" rel="noopener">${escapeHtml(r.username)}</a>`;

  const subEl = $("#user-modal-sub");
  subEl.textContent = `rank #${state.rows.findIndex((x) => x.username === username) + 1} · ${fmt.format(r.map_changes)} map changes · ${fmt.format(r.changesets)} changesets`;

  const av = $("#user-modal-avatar");
  av.style.background = avatarColor(r.username);
  av.textContent = initials(r.username);
  av.dataset.osmUid = String(r.uid);
  applyAvatar(av, r.uid, initials(r.username));

  const userHashtags = (r.hashtags || []).filter(Boolean).map((h) => String(h).replace(/^#/, ""));
  let hashtagHtml = "";
  if (userHashtags.length) {
    hashtagHtml = `
  <div class="ov-cell ov-split" style="margin-bottom:10px;">
    <div class="hashtag-grid">
      ${userHashtags.map((h) => `<div class="hashtag-item"><span class="hash">#</span>${escapeHtml(h)}</div>`).join("")}
    </div>
  </div>`;
  }

  const editorCellId = `editor-cell-${r.uid}`;
  const editorCellHtml = `
  <div class="overview-strip" style="margin-top:6px">
    <div class="ov-cell" id="${editorCellId}">
      <div class="lbl"><i data-lucide="pen-tool"></i>Editor</div>
      <div class="val" style="font-size:13px;color:var(--muted)">loading…</div>
    </div>
  </div>`;

  const { html: tagHtml, keyCount, valueCount } = tagBreakdownHtml(aggregateTagStats([r]), { maxKeys: 24 });
  let html = hashtagHtml;
  html += `<div class="overview-strip">${cellsHtml(USER_TOTAL_CELLS, r)}</div>`;
  html += editorCellHtml;
  html += `<div class="overview-strip" style="margin-top:6px">${elemCellsHtml(r)}</div>`;

  const { start, end } = rangeWindow(state.range);
  api.fetchUserEditor(r.uid, start, end).then((editor) => {
    const cell = document.getElementById(editorCellId);
    if (!cell) return;
    const valEl = cell.querySelector(".val");
    if (!valEl) return;
    if (!editor) {
      valEl.textContent = "Unknown";
      valEl.style.color = "var(--muted)";
      return;
    }
    const short = shortEditor(editor);
    const family = editorFamily(editor);
    const [ebg, efg] = editorColor(family);
    valEl.innerHTML = `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600;background:${ebg};color:${efg};border:0.5px solid ${efg}44" title="${escapeHtml(editor)}">${escapeHtml(short)}</span>`;
  });
  if (keyCount) {
    html += `
      <div class="ov-toggle" style="border-bottom:none">
        <span class="ov-breakdown-meta">${fmt.format(keyCount)} tag key${keyCount === 1 ? "" : "s"} · ${fmt.format(valueCount)} value${valueCount === 1 ? "" : "s"}</span>
        <span style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.1em;font-weight:600;display:flex;align-items:center;gap:5px;">
          <i data-lucide="tags"></i>Detailed tag contributions
        </span>
      </div>
      <div class="ov-breakdown" style="margin-top:8px">${tagHtml}</div>`;
  } else {
    html += `<div class="tag-stats-empty" style="margin-top:14px">No detailed tag stats reported for this contributor in this window.</div>`;
  }

  $("#user-modal-body").innerHTML = html;
  modal.hidden = false;
  modal.classList.add("open");
  document.body.style.overflow = "hidden";
  refreshIcons(modal);
  $("#user-modal-close").focus();
}

function closeUserModal() {
  const m = $("#user-modal");
  m.hidden = true;
  m.classList.remove("open");
  document.body.style.overflow = "";
}

function renderTable() {
  const tb = $("#lb-body"), allRows = state.filteredRows;
  if (!allRows.length) {
    tb.innerHTML = `<tr><td colspan="8"><div class="empty"><i data-lucide="search-x"></i><h3>Nothing to show</h3><p>${state.rows.length ? "Try clearing your search." : "No data for this time range and hashtag combination yet."}</p></div></td></tr>`;
    refreshIcons(tb);
    renderPagination(0, 0, 0);
    return;
  }
  $$("th.sortable").forEach((th) => {
    const k = th.dataset.sort, arrow = th.querySelector(".arrow");
    if (k === state.sort.key) {
      th.setAttribute("aria-sort", state.sort.dir === "asc" ? "ascending" : "descending");
      arrow.setAttribute("data-lucide", state.sort.dir === "asc" ? "arrow-up" : "arrow-down");
    } else {
      th.removeAttribute("aria-sort");
      arrow.setAttribute("data-lucide", "chevrons-up-down");
    }
  });
  const total = allRows.length;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  state.page = Math.min(Math.max(1, state.page), totalPages);
  const startIdx = (state.page - 1) * state.pageSize;
  const endIdx = Math.min(total, startIdx + state.pageSize);
  tb.innerHTML = allRows
    .slice(startIdx, endIdx)
    .map((r, i) => {
      const rank = startIdx + i + 1, rc = rank <= 3 ? `r${rank}` : "";
      const t = Math.max(1, r.map_changes);
      const cP = (r.created / t) * 100, mP = (r.modified / t) * 100, dP = (r.deleted / t) * 100;
      return `<tr data-user="${escapeHtml(r.username)}" class="lb-row" tabindex="0" role="button" aria-label="View ${escapeHtml(r.username)} contributions">
      <td class="col-rank ${rc}">${rank <= 3 ? `<span class="top">${rank}</span>` : rank}</td>
      <td class="col-user"><div class="user-cell">
        <span class="avatar" style="background:${avatarColor(r.username)}">${initials(r.username)}</span>
        <a class="username" href="https://www.openstreetmap.org/user/${encodeURIComponent(r.username)}" target="_blank" rel="noopener" title="${escapeHtml(r.username)}" onclick="event.stopPropagation()">${escapeHtml(r.username)}</a><i data-lucide="external-link" class="ext-link"></i>
      </div></td>
      <td class="col-num primary">${fmt.format(r.map_changes)}</td>
      <td class="col-num col-c${r.created ? "" : " is-zero"}">${fmt.format(r.created)}</td>
      <td class="col-num col-m${r.modified ? "" : " is-zero"}">${fmt.format(r.modified)}</td>
      <td class="col-num col-d${r.deleted ? "" : " is-zero"}">${fmt.format(r.deleted)}</td>
      <td class="col-num col-cs">${fmt.format(r.changesets)}</td>
      <td class="col-spark"><div class="stack-bar" title="${r.created} created · ${r.modified} modified · ${r.deleted} deleted">
        <div class="seg-c" style="width:${cP}%"></div><div class="seg-m" style="width:${mP}%"></div><div class="seg-d" style="width:${dP}%"></div>
      </div></td>
    </tr>`;
    })
    .join("");
  refreshIcons(tb);
  tb.querySelectorAll(".lb-row").forEach((tr) => {
    tr.addEventListener("click", () => openUserModal(tr.dataset.user));
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openUserModal(tr.dataset.user); }
    });
  });
  renderPagination(total, startIdx + 1, endIdx);
}

function renderPagination(total, from, to) {
  const wrap = $("#pagination"), info = $("#pg-info"), ctrls = $("#pg-controls");
  if (!total) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize)), cur = state.page;
  info.innerHTML = `Showing <b>${fmt.format(from)}</b>–<b>${fmt.format(to)}</b> of <b>${fmt.format(total)}</b>`;
  const pages = [1];
  if (cur - 1 > 2) pages.push("…");
  for (let p = Math.max(2, cur - 1); p <= Math.min(totalPages - 1, cur + 1); p++) pages.push(p);
  if (cur + 1 < totalPages - 1) pages.push("…");
  if (totalPages > 1) pages.push(totalPages);
  const btn = (lab, p, { dis = false, active = false } = {}) =>
    `<button class="pg-btn${active ? " active" : ""}" data-page="${p}"${dis ? " disabled" : ""}${active ? ' aria-current="page"' : ""}>${lab}</button>`;
  ctrls.innerHTML =
    btn(`<i data-lucide="chevron-left"></i>`, cur - 1, { dis: cur <= 1 }) +
    pages.map((p) => p === "…" ? `<span class="pg-ellipsis">…</span>` : btn(String(p), p, { active: p === cur })).join("") +
    btn(`<i data-lucide="chevron-right"></i>`, cur + 1, { dis: cur >= totalPages });
  refreshIcons(ctrls);
  ctrls.querySelectorAll(".pg-btn").forEach(
    (b) => (b.onclick = () => {
      if (b.disabled) return;
      const p = parseInt(b.dataset.page, 10);
      if (!isFinite(p)) return;
      state.page = p;
      renderTable();
      document.querySelector(".table-wrap").scrollIntoView({ behavior: "smooth", block: "start" });
    })
  );
}

$("#pg-size").addEventListener("change", (e) => {
  state.pageSize = parseInt(e.target.value, 10) || 25;
  state.page = 1;
  writeURL();
  renderTable();
});
$("#search").addEventListener("input", (e) => {
  state.search = e.target.value;
  state.page = 1;
  applyDerivedFilters();
  renderTable();
});
$$(".pill-toggle button").forEach(
  (b) => (b.onclick = () => {
    $$(".pill-toggle button").forEach((x) => x.removeAttribute("aria-pressed"));
    b.setAttribute("aria-pressed", "true");
    state.filter = b.dataset.filter;
    state.page = 1;
    applyDerivedFilters();
    renderTable();
  })
);
$$("th.sortable").forEach(
  (th) => (th.onclick = () => {
    const k = th.dataset.sort;
    if (state.sort.key === k)
      state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
    else { state.sort.key = k; state.sort.dir = k === "username" ? "asc" : "desc"; }
    state.page = 1;
    applyDerivedFilters();
    renderTable();
  })
);

$("#export-btn").addEventListener("click", () => {
  if (!state.rows.length)
    return toast({ msg: "Nothing to export", icon: "alert-triangle", err: true });
  const cols = [
    "rank", "uid", "username", "map_changes", "created", "modified", "deleted", "changesets",
    "nodes_created", "nodes_modified", "nodes_deleted",
    "ways_created", "ways_modified", "ways_deleted",
    "rels_created", "rels_modified", "rels_deleted",
    "pois_created", "pois_modified",
    "buildings_created", "buildings_modified",
    "highways_created", "highways_modified",
  ];
  const sorted = state.rows.slice().sort((a, b) => b.map_changes - a.map_changes);
  const lines = [cols.join(",")];
  sorted.forEach((r, i) => {
    const row = { ...r, rank: i + 1 };
    lines.push(cols.map((c) => {
      const s = String(row[c]);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const tag = state.hashtags.length ? state.hashtags.join("-") : "all";
  a.href = url;
  a.download = `osmsg-leaderboard-${tag}-${state.range}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast({ msg: "CSV downloaded", icon: "download" });
});

function showLoading() {
  $("#lb-body").innerHTML = Array.from(
    { length: 6 },
    () => `<tr>
    <td class="col-rank"><div class="skeleton" style="height:14px;width:24px"></div></td>
    <td><div class="user-cell"><div class="skeleton" style="width:28px;height:28px;border-radius:50%"></div><div class="skeleton" style="height:12px;width:120px"></div></div></td>
    <td><div class="skeleton" style="height:12px;width:50px;margin-left:auto"></div></td>
    <td><div class="skeleton" style="height:12px;width:40px;margin-left:auto"></div></td>
    <td><div class="skeleton" style="height:12px;width:40px;margin-left:auto"></div></td>
    <td><div class="skeleton" style="height:12px;width:30px;margin-left:auto"></div></td>
    <td class="col-cs"><div class="skeleton" style="height:12px;width:40px;margin-left:auto"></div></td>
    <td class="col-spark"><div class="skeleton" style="height:8px;width:120px"></div></td>
  </tr>`
  ).join("");
  $("#pagination").hidden = true;
}
function showError(err) {
  const tb = $("#lb-body");
  const msg = err?.message || "Network error";
  const isAbort = err?.name === "AbortError";
  tb.innerHTML = `<tr><td colspan="8"><div class="errbox">
    <i data-lucide="cloud-off"></i>
    <h3>${isAbort ? "Request timed out" : "Couldn't reach the OSMSG API"}</h3>
    <p style="margin-top:8px"><code style="font-family:var(--mono);font-size:12px;background:#F4F0E6;padding:2px 6px;border-radius:4px;color:#3A4744">${escapeHtml(msg)}</code></p>
    <p style="margin-top:14px;color:#717D78">If this is a CORS error and you're hosting this page off the API origin, the API needs to allow your origin. The status pill above will keep retrying when you click it.</p>
    <p style="margin-top:18px"><a href="${API_DOCS_URL}" target="_blank" rel="noopener">Open the API docs <i data-lucide="external-link" class="ico-sm" style="vertical-align:-2px"></i></a></p>
  </div></td></tr>`;
  $("#ov-strip").innerHTML = `<div class="tag-stats-empty" style="grid-column:1/-1">·</div>`;
  $("#ov-breakdown").innerHTML = "";
  $("#ov-breakdown").hidden = true;
  $("#ov-breakdown-meta").textContent = "";
  $("#ov-toggle-btn").setAttribute("aria-expanded", "false");
  $("#ov-toggle-btn").disabled = true;
  $("#ov-toggle-label").textContent = "Show tag breakdown";
  $("#podium").innerHTML = "";
  $("#pagination").hidden = true;
  refreshIcons(tb);
}

function updateLastUpdated() {
  const txt = $("#last-updated-text");
  const chip = $("#last-updated");
  const h = state.health;
  if (h?.last_ts) {
    const t = dtfClock.format(h.last_ts);
    txt.innerHTML = `Server ${ago(h.last_ts)} · <time datetime="${h.last_ts.toISOString()}">${t}</time>`;
    const lines = [
      `OSM diff timestamp (last_ts): ${h.last_ts.toISOString()}`,
      h.updated_at ? `Server processed at: ${h.updated_at.toISOString()}` : null,
      h.last_seq != null ? `Sequence: ${h.last_seq}` : null,
      state.lastFetched ? `Browser last refresh: ${dtfClock.format(state.lastFetched)}` : null,
    ].filter(Boolean);
    if (chip) chip.title = lines.join("\n");
  } else if (state.lastFetched) {
    const t = dtfClock.format(state.lastFetched);
    txt.innerHTML = `Updated ${ago(state.lastFetched)} · <time datetime="${state.lastFetched.toISOString()}">${t}</time>`;
    if (chip) chip.title = "";
  } else {
    txt.textContent = "never";
    if (chip) chip.title = "";
  }
}

async function refreshHealth() {
  try {
    const j = await api.fetchHealth();
    state.health = {
      status: j.status ?? null,
      last_seq: j.last_seq ?? null,
      last_ts: j.last_ts ? new Date(j.last_ts) : null,
      updated_at: j.updated_at ? new Date(j.updated_at) : null,
    };
    state.healthCheckedAt = Date.now();
    window.OSMSGTime.setServerClock(state.health.last_ts);
    updateLastUpdated();
    renderStaleNotice();
  } catch (err) {
    state.healthCheckedAt = Date.now();
    console.warn("OSMSG health fetch failed:", err);
  }
}

function renderStaleNotice() {
  const bar = $(".windowbar");
  if (!bar) return;

  let el = $("#wb-stale");
  const stale = window.OSMSGTime.isStale();

  if (!stale) {
    el?.remove();
    return;
  }

  if (!el) {
    el = document.createElement("div");
    el.className = "wb-item";
    el.id = "wb-stale";
    el.style.color = "var(--warn-ink)";
    bar.appendChild(el);
  }

  const last = state.health?.last_ts;
  el.innerHTML =
    `<i data-lucide="alert-triangle" class="ico-sm"></i>` +
    `<span class="k">Data</span>` +
    `<span class="v">${escapeHtml(window.OSMSGTime.lagLabel())}</span>`;
  el.title = last
    ? `The OSMSG ingest has not advanced since ${last.toISOString()}.\n` +
      `Time presets are anchored to that timestamp so they return data instead of an empty window.`
    : "";
  refreshIcons(el);
}

function renderWindowBar() {
  const { start, end } =
    state.windowStart && state.windowEnd
      ? { start: state.windowStart, end: state.windowEnd }
      : rangeWindow(state.range);
  const useDate = state.range === "all" || end - start > 60 * 86400 * 1000;
  const f = useDate ? dtfDate : dtfShort;
  $("#wb-window-text").textContent = `${f.format(start)} → ${f.format(end)}`;
  $("#wb-window").title = `Time window\nUTC: ${start.toISOString()} → ${end.toISOString()}\nLocal (${TZ}): ${dtfFull.format(start)} → ${dtfFull.format(end)}`;
  $("#wb-localtime").textContent = dtfClock.format(new Date());
  $("#wb-tzname").textContent = `${TZ} · ${tzOffsetLabel()}`;
}

function readURL() {
  const p = new URLSearchParams(location.search);
  const r = p.get("range");
  if (r && (RANGE_HOURS[r] || r === "all" || r === "custom")) {
    state.range = r;
    setRangePreset(r);
  }
  if (r === "custom") {
    const s = p.get("start"), e = p.get("end");
    if (s && e) {
      const sd = new Date(s), ed = new Date(e);
      if (!isNaN(sd) && !isNaN(ed)) {
        state.customStart = sd;
        state.customEnd = ed;
      }
    }
  }
  const tags = p.getAll("hashtag").concat(p.getAll("hashtags"));
  if (tags.length)
    state.hashtags = [...new Set(tags.map((t) => t.replace(/^#/, "").toLowerCase()))];
  const ps = parseInt(p.get("size") || "", 10);
  if ([10, 25, 50, 100].includes(ps)) {
    state.pageSize = ps;
    $("#pg-size").value = String(ps);
  }
}
function writeURL() {
  const p = new URLSearchParams();
  p.set("range", state.range);
  if (state.range === "custom" && state.customStart && state.customEnd) {
    p.set("start", isoUTC(state.customStart));
    p.set("end", isoUTC(state.customEnd));
  }
  state.hashtags.forEach((h) => p.append("hashtag", h));
  if (state.pageSize !== 25) p.set("size", String(state.pageSize));
  history.replaceState(null, "", `${location.pathname}?${p}`);
}

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker
    .register("sw.js", { scope: "./" })
    .catch((err) => console.info("Service worker not registered:", err.message));
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopAutoRefresh();
  else if (state.live) {
    fetchData({ silent: true });
    startAutoRefresh();
  }
});

$("#ov-toggle-btn").addEventListener("click", () => {
  const btn = $("#ov-toggle-btn");
  if (btn.disabled) return;
  const expanded = btn.getAttribute("aria-expanded") === "true";
  btn.setAttribute("aria-expanded", expanded ? "false" : "true");
  $("#ov-details").hidden = expanded;
  $("#ov-toggle-label").textContent = expanded ? "Show details" : "Hide details";
  const ico = btn.querySelector('[data-lucide="plus"], [data-lucide="minus"]');
  if (ico) ico.setAttribute("data-lucide", expanded ? "plus" : "minus");
  refreshIcons(btn);
});

const userModal = $("#user-modal");
$("#user-modal-close").addEventListener("click", closeUserModal);
userModal.addEventListener("click", (e) => {
  if (e.target === userModal) closeUserModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && userModal.classList.contains("open")) closeUserModal();
});

function boot() {

  const apiHostEl = $("#wb-api-host");
  if (apiHostEl) apiHostEl.textContent = API_HOST;
  const apiDocsLink = $("#api-docs-link");
  if (apiDocsLink) apiDocsLink.href = API_DOCS_URL;

  readURL();
  renderChips();
  renderWindowBar();
  refreshIcons();
  refreshHealth();
  fetchData({});
  startAutoRefresh();
  state.agoTimer = setInterval(updateLastUpdated, 5000);
  state.clockTimer = setInterval(() => {
    $("#wb-localtime").textContent = dtfClock.format(new Date());
  }, 1000);
  if (state.range === "custom") {
    const tryInit = () => {
      if (typeof window.flatpickr === "function") setRangePreset("custom");
      else setTimeout(tryInit, 50);
    };
    tryInit();
  }
}
if (document.readyState !== "loading") boot();
else window.addEventListener("DOMContentLoaded", boot);