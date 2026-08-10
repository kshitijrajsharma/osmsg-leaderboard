"use strict";

(function () {

  var CONFIG = window.OSMSG_CONFIG;
  var DATA = window.OSMSGData;
  if (!CONFIG || !DATA) {
    console.error("[OSMSG] charts.js requires app.js to load first.");
    return;
  }


  var SECTION_ID = "osmsg-ext";
  var fmtInt = new Intl.NumberFormat("en-US");

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function compact(n) {
    var v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + "k";
    return fmtInt.format(v);
  }

  var SERIES_COLORS = [
    "#264653", "#2A9D8F", "#E9C46A", "#F4A261", "#E76F51",
    "#457B9D", "#6A4C93", "#81B29A", "#2D5F3F", "#B5838D"
  ];

  var AXIS_COLOR = "#717D78";
  var GRID_COLOR = "rgba(26,36,33,0.06)";
  var FONT_SANS = "'Plus Jakarta Sans', system-ui, sans-serif";
  var FONT_MONO = "'JetBrains Mono', ui-monospace, monospace";

  var TOOLTIP_STYLE = {
    backgroundColor: "#1A2421",
    titleFont: { family: FONT_SANS, size: 12.5, weight: "700" },
    bodyFont: { family: FONT_MONO, size: 11.5 },
    padding: 11,
    cornerRadius: 9,
    displayColors: false,
    boxPadding: 4
  };

  function tickFormat(v) {
    var n = Number(v) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
    return String(n);
  }

  var ICONS = {
    hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
    editor: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    cluster: '<circle cx="7" cy="7" r="3"/><circle cx="17" cy="9" r="2"/><circle cx="11" cy="17" r="2.5"/><path d="M9.5 8.5 15 9M9 15l1.5-5"/>',
    empty: '<circle cx="12" cy="12" r="9"/><path d="M9 12h6"/>',
    error: '<path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>'
  };

  function svgIcon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[name] || "") + "</svg>";
  }



  function createCard(opts) {
    var card = document.createElement("section");
    card.className = "ext-card" + (opts.wide ? " ext-card--wide" : "");
    card.id = opts.id;
    card.setAttribute("aria-labelledby", opts.id + "-title");

    card.innerHTML =
      '<header class="ext-card-head">' +
        '<h3 class="ext-card-title" id="' + opts.id + '-title">' + svgIcon(opts.icon) + esc(opts.title) + "</h3>" +
        '<span class="ext-card-meta" data-role="meta"></span>' +
      "</header>" +
      (opts.sub ? '<p class="ext-card-sub">' + esc(opts.sub) + "</p>" : "") +
      '<div class="ext-card-body" data-role="body" aria-live="polite"></div>';

    var body = card.querySelector('[data-role="body"]');
    var meta = card.querySelector('[data-role="meta"]');

    return {
      el: card,
      body: body,

      setSource: function (source, caption) {
        var badge = source === "demo"
          ? ' <span class="ext-badge">' + esc(CONFIG.demo.badgeLabel) + "</span>"
          : "";
        meta.innerHTML = (caption ? esc(caption) : "") + badge;
      },
      clearMeta: function () { meta.innerHTML = ""; }
    };
  }

  function renderLoading(body, kind) {
    body.innerHTML = kind === "map"
      ? '<div class="ext-skel" style="height:460px;border-radius:12px"></div>'
      : '<div class="ext-skel" style="flex:1;min-height:330px;border-radius:12px"></div>';
  }

  function renderEmpty(body, title, message) {
    body.innerHTML =
      '<div class="ext-state">' +
        '<div class="ext-state-icon">' + svgIcon("empty") + "</div>" +
        '<p class="ext-state-title">' + esc(title) + "</p>" +
        (message ? '<p class="ext-state-msg">' + esc(message) + "</p>" : "") +
      "</div>";
  }

  function renderError(body, error, onRetry) {
    var msg = (error && (error.userMessage || error.message)) || "An unexpected error occurred.";
    body.innerHTML =
      '<div class="ext-state ext-state--error">' +
        '<div class="ext-state-icon">' + svgIcon("error") + "</div>" +
        '<p class="ext-state-title">Couldn\'t load this section</p>' +
        '<p class="ext-state-msg">' + esc(msg) + "</p>" +
        (onRetry ? '<button type="button" class="ext-state-retry">Try again</button>' : "") +
      "</div>";
    if (onRetry) {
      var btn = body.querySelector(".ext-state-retry");
      if (btn) btn.addEventListener("click", onRetry);
    }
  }



  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var s = document.createElement("script");
      s.src = src;
      s.async = false; // dependency order matters for markercluster
      s.onload = resolve;
      s.onerror = function () { reject(new Error("Could not load " + src)); };
      document.head.appendChild(s);
    });
  }

  function loadStylesheet(href) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('link[href="' + href + '"]')) return resolve();
      var l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = href;
      l.onload = resolve;
      l.onerror = function () { reject(new Error("Could not load " + href)); };
      document.head.appendChild(l);
    });
  }

  var CHART_CDN = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
  var chartPromise;

  function loadChartJs() {
    if (!chartPromise) {
      chartPromise = (window.Chart ? Promise.resolve() : loadScript(CHART_CDN))
        .then(function () {
          if (!window.Chart) throw new Error("Chart.js failed to initialise.");
          return window.Chart;
        })
        .catch(function (err) { chartPromise = undefined; throw err; });
    }
    return chartPromise;
  }

  var LEAFLET_CSS = [
    "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css",
    "https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/MarkerCluster.css"
  ];
  var LEAFLET_JS = [
    "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js",
    "https://cdn.jsdelivr.net/npm/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js"
  ];
  var leafletPromise;

  function loadLeaflet() {
    if (!leafletPromise) {
      leafletPromise = Promise.all(LEAFLET_CSS.map(loadStylesheet))
        .then(function () {
        
          return LEAFLET_JS.reduce(function (chain, src) {
            return chain.then(function () { return loadScript(src); });
          }, Promise.resolve());
        })
        .then(function () {
          if (!window.L || !window.L.markerClusterGroup) {
            throw new Error("Leaflet.markercluster failed to initialise.");
          }
          return window.L;
        })
        .catch(function (err) { leafletPromise = undefined; throw err; });
    }
    return leafletPromise;
  }

 

  var hashtagCard = null;
  var hashtagChart = null;
  var hashtagToken = 0;
  var hashtagWindow = null;

  function mountTopHashtags(container) {
    hashtagCard = createCard({
      id: "ext-hashtags",
      title: "Top hashtags",
      icon: "hash"
    });
    container.appendChild(hashtagCard.el);
    renderLoading(hashtagCard.body, "chart");
  }

  function loadTopHashtags(win) {
    if (!hashtagCard) return;
    hashtagWindow = win;
    var mine = ++hashtagToken;

    if (hashtagChart) { hashtagChart.destroy(); hashtagChart = null; }
    renderLoading(hashtagCard.body, "chart");
    hashtagCard.clearMeta();

    Promise.all([
      DATA.getTopHashtags({ start: win.start, end: win.end, limit: CONFIG.features.topHashtags.limit }),
      loadChartJs()
    ]).then(function (out) {
      if (mine !== hashtagToken) return;
      var result = out[0], Chart = out[1];

      if (result.status === "error") {
        renderError(hashtagCard.body, result.error, function () { loadTopHashtags(hashtagWindow); });
        return;
      }
      if (result.status === "empty") {
        renderEmpty(hashtagCard.body, "No hashtags in this window",
          "No tagged changesets were recorded for the selected time range.");
        return;
      }
      drawHashtagPie(Chart, result.data, result.source);

    }).catch(function (err) {
      if (err && err.kind === "abort") return;
      if (mine !== hashtagToken) return;
      renderError(hashtagCard.body, err, function () { loadTopHashtags(hashtagWindow); });
    });
  }

  function drawHashtagPie(Chart, data, source) {
    // The adapter already ranks by map changes, so the top N is just a slice.
    var items = data.items.slice(0, CONFIG.features.topHashtags.limit);
    var values = items.map(function (r) { return r.changes || 0; });
    var total = values.reduce(function (s, v) { return s + v; }, 0);
    var colors = items.map(function (_, i) { return SERIES_COLORS[i % SERIES_COLORS.length]; });

    hashtagCard.setSource(source, "top " + items.length + " by map changes");

    hashtagCard.body.innerHTML =
      '<div class="ext-chart-split">' +
        '<div class="ext-chart-canvas ext-chart-canvas--pie">' +
          '<canvas id="ext-hashtag-pie" role="img" aria-label="Pie chart of map changes by hashtag"></canvas>' +
        "</div>" +
        '<ul class="ext-legend" id="ext-hashtag-legend"></ul>' +
      "</div>";

    hashtagCard.body.querySelector("#ext-hashtag-legend").innerHTML = items.map(function (r, i) {
      var share = total ? (values[i] / total) * 100 : 0;
      return '<li class="ext-legend-row" data-index="' + i + '" role="button" tabindex="0" ' +
             'title="Filter the leaderboard by ' + esc(r.tag) + '">' +
               '<span class="ext-legend-swatch" style="background:' + colors[i] + '"></span>' +
               '<span class="ext-legend-name">' + esc(r.tag) + "</span>" +
               '<span class="ext-legend-value">' + compact(values[i]) + "</span>" +
               '<span class="ext-legend-share">' + share.toFixed(1) + "%</span>" +
             "</li>";
    }).join("");

    hashtagChart = new Chart(hashtagCard.body.querySelector("#ext-hashtag-pie"), {
      type: "pie",
      data: {
        labels: items.map(function (r) { return r.tag; }),
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderColor: "#FFFFFF",
          borderWidth: 2,
          hoverOffset: 10,
          hoverBorderColor: "#FFFFFF"
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: 6 },
        plugins: {
          legend: { display: false },
          tooltip: Object.assign({}, TOOLTIP_STYLE, {
            callbacks: {
              title: function (ctx) { return ctx[0].label; },
              label: function (ctx) {
                var v = ctx.parsed || 0;
                var share = total ? ((v / total) * 100).toFixed(1) : "0.0";
                var row = items[ctx.dataIndex];
                return [
                  fmtInt.format(v) + " changes",
                  share + "% share",
                  fmtInt.format(row.changesets) + " changesets · " + fmtInt.format(row.users) + " mappers"
                ];
              }
            }
          })
        },
        onHover: function (evt, hit) {
          evt.native.target.style.cursor = hit.length ? "pointer" : "default";
        },
        onClick: function (evt, elements) {
          if (elements.length) filterByHashtag(items[elements[0].index].tag);
        }
      }
    });

    Array.prototype.forEach.call(
      hashtagCard.body.querySelectorAll(".ext-legend-row"),
      function (row) {
        var i = Number(row.dataset.index);
        row.addEventListener("mouseenter", function () {
          if (!hashtagChart) return;
          hashtagChart.setActiveElements([{ datasetIndex: 0, index: i }]);
          hashtagChart.update();
        });
        row.addEventListener("mouseleave", function () {
          if (!hashtagChart) return;
          hashtagChart.setActiveElements([]);
          hashtagChart.update();
        });
        row.addEventListener("click", function () { filterByHashtag(items[i].tag); });
        row.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            filterByHashtag(items[i].tag);
          }
        });
      }
    );
  }

  function filterByHashtag(tag) {
    document.dispatchEvent(new CustomEvent("osmsg:filter-hashtag", { detail: { tag: tag } }));
  }



  var editorCard = null;
  var editorChart = null;
  var editorToken = 0;
  var editorWindow = null;

  function mountTopEditors(container) {
    editorCard = createCard({
      id: "ext-editors",
      title: "Top editors",
      icon: "editor"
    });
    container.appendChild(editorCard.el);
    renderLoading(editorCard.body, "chart");
  }

  function loadTopEditors(win) {
    if (!editorCard) return;
    editorWindow = win;
    var mine = ++editorToken;

    if (editorChart) { editorChart.destroy(); editorChart = null; }
    renderLoading(editorCard.body, "chart");
    editorCard.clearMeta();

    Promise.all([
      DATA.getTopEditors({ start: win.start, end: win.end, limit: CONFIG.features.topEditors.limit }),
      loadChartJs()
    ]).then(function (out) {
      if (mine !== editorToken) return;
      var result = out[0], Chart = out[1];

      if (result.status === "error") {
        renderError(editorCard.body, result.error, function () { loadTopEditors(editorWindow); });
        return;
      }
      if (result.status === "empty") {
        renderEmpty(editorCard.body, "No editor activity in this window",
          "No changesets were recorded for the selected time range.");
        return;
      }
      drawEditorBars(Chart, result.data, result.source);

    }).catch(function (err) {
      if (err && err.kind === "abort") return;
      if (mine !== editorToken) return;
      renderError(editorCard.body, err, function () { loadTopEditors(editorWindow); });
    });
  }

  function drawEditorBars(Chart, data, source) {
    var items = data.items.slice()
      .sort(function (a, b) { return (b.users || 0) - (a.users || 0); })
      .slice(0, CONFIG.features.topEditors.limit);

    var values = items.map(function (e) { return e.users || 0; });
    var colors = items.map(function (_, i) { return SERIES_COLORS[i % SERIES_COLORS.length]; });

    editorCard.setSource(source, "top " + items.length + " by users");

    editorCard.body.innerHTML =
      '<div class="ext-chart-canvas ext-chart-canvas--bar">' +
        '<canvas id="ext-editor-bar" role="img" aria-label="Bar chart of mappers by editing software"></canvas>' +
      "</div>";

    editorChart = new Chart(editorCard.body.querySelector("#ext-editor-bar"), {
      type: "bar",
      data: {
        labels: items.map(function (e) { return e.label; }),
        datasets: [{
          label: "Mappers",
          data: values,
          backgroundColor: colors,
          hoverBackgroundColor: colors,
          borderRadius: 6,
          borderSkipped: false,
          barPercentage: 0.68,
          categoryPercentage: 0.82
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 8 } },
        plugins: {
          legend: { display: false },
          tooltip: Object.assign({}, TOOLTIP_STYLE, {
            callbacks: {
              title: function (ctx) { return ctx[0].label; },
              label: function (ctx) {
                var e = items[ctx.dataIndex];
                return [
                  fmtInt.format(ctx.parsed.y) + " mappers",
                  fmtInt.format(e.changes) + " map changes · " + e.share.toFixed(1) + "% of all",
                  fmtInt.format(e.changesets) + " changesets",
                  fmtInt.format(e.changesPerUser) + " changes per mapper"
                ];
              }
            }
          })
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: GRID_COLOR },
            ticks: {
              color: AXIS_COLOR,
              font: { family: FONT_SANS, size: 11 },
              maxRotation: 45,
              minRotation: 0,
              autoSkip: false
            }
          },
          y: {
            beginAtZero: true,
            grid: { color: GRID_COLOR },
            border: { display: false, dash: [3, 3] },
            ticks: {
              color: AXIS_COLOR,
              font: { family: FONT_MONO, size: 10.5 },
              callback: tickFormat,
              maxTicksLimit: 6
            }
          }
        }
      }
    });
  }


  var clusterCard = null;
  var clusterMap = null;
  var clusterLayer = null;
  var clusterToken = 0;
  var clusterWindow = null;

  function mountChangesetClusters(container) {
    clusterCard = createCard({
      id: "ext-clusters",
      title: "Changeset clusters",
      icon: "cluster",
      wide: true
    });
    container.appendChild(clusterCard.el);
    renderLoading(clusterCard.body, "map");
  }

  function destroyMap() {
    if (clusterMap) {
      clusterMap.remove();
      clusterMap = null;
      clusterLayer = null;
    }
  }

  function loadChangesetClusters(win) {
    if (!clusterCard) return;
    clusterWindow = win;
    var mine = ++clusterToken;

    destroyMap();
    renderLoading(clusterCard.body, "map");
    clusterCard.clearMeta();

    Promise.all([
      DATA.getChangesetClusters({ start: win.start, end: win.end, limit: CONFIG.features.changesetClusters.limit }),
      loadLeaflet()
    ]).then(function (out) {
      if (mine !== clusterToken) return;
      var result = out[0], L = out[1];

      if (result.status === "error") {
        renderError(clusterCard.body, result.error, function () { loadChangesetClusters(clusterWindow); });
        return;
      }
      if (result.status === "empty" || !result.data || !result.data.points.length) {
        renderEmpty(clusterCard.body, "No changesets to cluster",
          "No geolocated changesets were recorded in the selected time range.");
        return;
      }
      drawClusterMap(L, result.data, result.source);

    }).catch(function (err) {
      if (err && err.kind === "abort") return;
      if (mine !== clusterToken) return;
      renderError(clusterCard.body, err, function () { loadChangesetClusters(clusterWindow); });
    });
  }

  /** Colour tier from the cluster's average changes per changeset. */
  function intensityClass(totalChanges, childCount) {
    var per = childCount ? totalChanges / childCount : 0;
    if (per >= 400) return "ext-cluster-xl";
    if (per >= 120) return "ext-cluster-l";
    if (per >= 25) return "ext-cluster-m";
    return "ext-cluster-s";
  }

  function popupHtml(p) {
    var when = p.at
      ? p.at.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC")
      : "unknown time";
    var tags = (p.hashtags || []).slice(0, 4);

    return '<div class="ext-popup-name">' + esc(p.user) + "</div>" +
      '<div class="ext-popup-row">' + esc(when) + "</div>" +
      '<div class="ext-popup-row">' + fmtInt.format(p.changes) + " map changes" +
        (p.editor ? " · " + esc(p.editor) : "") + "</div>" +
      (tags.length
        ? '<div class="ext-popup-tags">' + tags.map(function (t) {
            return '<span class="ext-popup-tag">' + esc(t) + "</span>";
          }).join("") + "</div>"
        : "") +
      (p.id
        ? '<div class="ext-popup-row" style="margin-top:6px">' +
            '<a href="https://www.openstreetmap.org/changeset/' + encodeURIComponent(p.id) + '" ' +
            'target="_blank" rel="noopener">Changeset ' + esc(p.id) + " &rarr;</a></div>"
        : "");
  }

  function drawClusterMap(L, data, source) {
    clusterCard.setSource(source, fmtInt.format(data.returned) + " changeset centroids");

    clusterCard.body.innerHTML =
      '<div class="ext-map" id="ext-cluster-map" role="application" aria-label="Map of changeset clusters"></div>' +
      '<div class="ext-map-footnote">' +
        '<span class="ext-map-legend">' +
          '<span class="ext-legend-item"><span class="ext-legend-dot" style="background:#4F8A65"></span>light</span>' +
          '<span class="ext-legend-item"><span class="ext-legend-dot" style="background:#2D5F3F"></span>moderate</span>' +
          '<span class="ext-legend-item"><span class="ext-legend-dot" style="background:#C77E3D"></span>heavy</span>' +
          '<span class="ext-legend-item"><span class="ext-legend-dot" style="background:#B5392C"></span>bulk</span>' +
        "</span>" +
        "<span>Colour = average map changes per changeset in the cluster.</span>" +
        (data.total > data.returned
          ? "<span>Showing " + fmtInt.format(data.returned) + " of " + fmtInt.format(data.total) + " changesets.</span>"
          : "") +
      "</div>";

    clusterMap = L.map(clusterCard.body.querySelector("#ext-cluster-map"), {
      worldCopyJump: true,
      scrollWheelZoom: false,   
      attributionControl: true
    });

    clusterMap.on("click", function () { clusterMap.scrollWheelZoom.enable(); });
    clusterMap.on("mouseout", function () { clusterMap.scrollWheelZoom.disable(); });

    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
                   '&copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: "abcd",
      maxZoom: 19
    }).addTo(clusterMap);

    clusterLayer = L.markerClusterGroup({
      chunkedLoading: true,
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      maxClusterRadius: 55,
      iconCreateFunction: function (cluster) {
        var children = cluster.getAllChildMarkers();
        var count = children.length;
        var changes = children.reduce(function (s, m) { return s + (m.options.osmsgChanges || 0); }, 0);
        var size = Math.round(Math.min(58, 26 + Math.log2(count + 1) * 5.5));

        return L.divIcon({
          html: '<div class="ext-cluster ' + intensityClass(changes, count) + '" ' +
                'style="width:' + size + "px;height:" + size + 'px" ' +
                'title="' + count + " changesets · " + compact(changes) + ' map changes">' +
                (count > 999 ? compact(count) : count) + "</div>",
          className: "",
          iconSize: L.point(size, size)
        });
      }
    });

    var markers = data.points.map(function (p) {
      var m = L.marker([p.lat, p.lon], {
        osmsgChanges: p.changes,
        icon: L.divIcon({ html: '<div class="ext-pin"></div>', className: "", iconSize: [11, 11] })
      });
      m.bindPopup(popupHtml(p), { closeButton: true, maxWidth: 260 });
      return m;
    });

    clusterLayer.addLayers(markers);
    clusterMap.addLayer(clusterLayer);

    var bounds = clusterLayer.getBounds();
    if (bounds.isValid()) clusterMap.fitBounds(bounds.pad(0.12));
    else clusterMap.setView([20, 0], 2);

    requestAnimationFrame(function () { if (clusterMap) clusterMap.invalidateSize(); });
  }



  var debounceTimer = null;

  function buildContainer() {
    var existing = document.getElementById(SECTION_ID);
    if (existing) return existing;

    var wrap = document.createElement("div");
    wrap.id = SECTION_ID;
    wrap.innerHTML = '<div class="ext-grid" id="' + SECTION_ID + '-grid"></div>';

    var footer = document.querySelector("footer");
    if (footer && footer.parentNode) footer.parentNode.insertBefore(wrap, footer);
    else document.body.appendChild(wrap);

    return wrap;
  }

  function loadAll(win) {
    if (!win || !win.start || !win.end) return;
    loadTopHashtags(win);
    loadTopEditors(win);
    loadChangesetClusters(win);
  }

  function scheduleLoad(win) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { loadAll(win); }, 180);
  }

  function init() {
    var grid = buildContainer().querySelector("#" + SECTION_ID + "-grid");

    mountTopHashtags(grid);
    mountTopEditors(grid);
    mountChangesetClusters(grid);

    document.addEventListener("osmsg:window", function (e) {
      var d = e.detail || {};
      if (!d.start || !d.end) return;
      scheduleLoad({ start: new Date(d.start), end: new Date(d.end) });
    });


    var initial = window.OSMSG_ACTIVE_WINDOW ||
      (window.OSMSGTime ? window.OSMSGTime.resolve("24h") : null);
    if (initial && initial.start && initial.end) scheduleLoad(initial);

    if (CONFIG.demo.enabled) {
      console.info("[OSMSG] Demo mode is ON — the new sections are not using the API.");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

})();
