(function () {
    'use strict';

    const CZ_CENTER = [49.8, 15.5];
    const CZ_ZOOM = 7;

    const APP_BASE_URL = (() => {
        const scriptUrl = new URL(document.currentScript?.src || 'src/app.js', window.location.href);
        scriptUrl.pathname = scriptUrl.pathname.replace(/src\/app\.js$/, '');
        scriptUrl.search = '';
        scriptUrl.hash = '';
        return scriptUrl;
    })();
    const APP_BASE_PATH = APP_BASE_URL.pathname.endsWith('/') ? APP_BASE_URL.pathname : `${APP_BASE_URL.pathname}/`;
    const appUrl = (path) => new URL(path, APP_BASE_URL).href;

    const MASTER_URL = appUrl('data/pamatky.geojson');
    const LOOKUPS_URL = appUrl('data/lookups.json');
    const SEARCH_INDEX_URL = appUrl('data/search-index.json');
    const BUCKET_URL = (krajTid) => appUrl(`data/details/${krajTid}.json`);
    const THUMB_URL = (filepath) => {
        const m = filepath.match(/^files\/(\d{4})\/(.+)\.jpg$/i);
        return m ? appUrl(`data/thumbs/${m[1]}/${m[2]}.avif`) : null;
    };
    const ORIG_URL = (nid) => `https://www.drobnepamatky.cz/node/${nid}`;

    const ROUTE_QUERY_PARAM = 'p';
    const PAMATKA_ROUTE_RE = /^\/pamatka\/(\d+)(?:-[^/]*)?\/?$/;

    const SEARCH_MIN_CHARS = 2;
    const SEARCH_MAX_RESULTS = 12;
    const SEARCH_DEBOUNCE_MS = 200;

    // Velikost bodů v pixelech (na všech zoomech – glify nepodporuje per-zoom size out of box).
    const POINT_SIZE = 6;
    // Pixelová tolerance pro click hit-test (čím větší, tím snáz se klikne).
    const POINT_SENSITIVITY = 2.0;
    // Při tomto zoomu a výš se přepne z WebGL teček na klasické SVG teardrop ikony
    // pro body ve viewportu. Důvod: na blízkém zoomu jsou tečky vizuálně chudé,
    // ale celkový počet bodů ve viewportu je zvládnutelný (na zoom 12 typicky
    // 1500-5000 bodů), takže si klasické markery můžeme dovolit.
    const ICON_MODE_MIN_ZOOM = 12;

    // ===== Marker ikony per kategorie druhu =====
    // 5 vizuálně odlišených kategorií + default. Mapping z 31 druhů (term_data vid=5).
    // SVG ikony zachované jen pro legendu + active marker overlay.
    const KATEGORIE = {
        kriz:     { color: '#b91c1c', label: 'Kříže',           svg: 'M10 3h4v6h6v4h-6v8h-4v-8H4V9h6z' },
        bozimuka: { color: '#c2410c', label: 'Boží muka, sloupy', svg: 'M11 2h2v3l2 1v2l-2 1v13h-2V9L9 8V6l2-1z' },
        kaple:    { color: '#7c3aed', label: 'Kaple, zvoničky',  svg: 'M12 2L3 10v12h6v-7h6v7h6V10z' },
        socha:    { color: '#0e7490', label: 'Sochy, pomníky',   svg: 'M12 2a2.5 2.5 0 0 0 0 5 2.5 2.5 0 0 0 0-5zM9 9v8h2v5h2v-5h2V9z' },
        kamen:    { color: '#65a30d', label: 'Kameny',           svg: 'M5 17c0-5 3.5-9 7-9s7 4 7 9c0 1-.5 2-1.5 2H6.5C5.5 19 5 18 5 17z' },
        default:  { color: '#6b7280', label: 'Ostatní',          svg: 'M12 5a4 4 0 0 0-4 4c0 3 4 8 4 8s4-5 4-8a4 4 0 0 0-4-4z' },
    };
    const DRUH_TO_KATEGORIE = {
        19413: 'kriz',     19407: 'kriz',     19417: 'kriz',                       // Kříž, Křížový k., Smírčí kříž
        19420: 'bozimuka', 19416: 'bozimuka',                                       // Boží muka, Sloup
        19405: 'kaple',    19406: 'kaple',    19483: 'kaple', 19419: 'kaple',      // Kaple, Kaplička, Zvonice, Zvonička
        19418: 'socha',    19414: 'socha',    19415: 'socha', 19411: 'socha',
        19427: 'socha',    19487: 'socha',    19482: 'socha', 19485: 'socha',      // Socha, Pomník, Pomník padlým, Památník, Plastika, Reliéf, Pamětní deska, Krajinné umění
        19404: 'kamen',    19412: 'kamen',    19409: 'kamen', 19488: 'kamen',      // Hraniční k., Památný k., Menhir, Památná dlažba
    };

    // hexToRgb („#b91c1c" → {r:0.725, g:0.110, b:0.110}) pro glify (chce 0-1 floaty).
    const hexToGlifyColor = (hex) => {
        const n = parseInt(hex.slice(1), 16);
        return { r: ((n >> 16) & 0xff) / 255, g: ((n >> 8) & 0xff) / 255, b: (n & 0xff) / 255 };
    };
    // Předpřipravené glify barvy per kat (recycle, ať nealokujeme per-frame).
    const KAT_COLORS = Object.fromEntries(
        Object.entries(KATEGORIE).map(([k, v]) => [k, hexToGlifyColor(v.color)])
    );

    const statusEl = document.getElementById('status');
    const setStatus = (msg) => { statusEl.textContent = msg; };

    const toastEl = document.getElementById('toast');
    let toastTimer = null;
    const showToast = (message, durationMs = 4500) => {
        toastEl.textContent = message;
        toastEl.classList.add('visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toastEl.classList.remove('visible');
            toastTimer = null;
        }, durationMs);
    };

    const escapeHtml = (str) => String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const stripDiacritics = (s) =>
        String(s ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

    const map = L.map('map', {
        center: CZ_CENTER,
        zoom: CZ_ZOOM,
        minZoom: 6,
        maxZoom: 19,
        zoomControl: true,
        // Preferuj canvas pro overlay markery (active highlight) – mírně rychlejší než SVG.
        preferCanvas: true,
    });

    const baseLayers = {
        'OpenStreetMap': L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
            maxZoom: 19,
        }),
        'OpenTopoMap': L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
            attribution: 'Map data: © OpenStreetMap, SRTM | Style: © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
            maxZoom: 17,
        }),
        'ČÚZK Ortofoto': L.tileLayer.wms('https://ags.cuzk.cz/arcgis2/services/ORTOFOTO/MapServer/WmsServer', {
            layers: '0',
            format: 'image/jpeg',
            transparent: false,
            attribution: '© <a href="https://geoportal.cuzk.cz/">ČÚZK</a>',
            maxZoom: 19,
        }),
    };
    baseLayers['OpenStreetMap'].addTo(map);

    L.control.layers(baseLayers, {}, { position: 'topright' }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

    // Legenda kategorií (5 + default) – Leaflet control, bottomright
    const Legend = L.Control.extend({
        options: { position: 'bottomright' },
        onAdd: function () {
            const div = L.DomUtil.create('div', 'dp-legend leaflet-bar');
            const rows = Object.values(KATEGORIE).map(k => `
                <div class="legend-row">
                    <span class="legend-pin" style="background:${k.color}">
                        <svg viewBox="0 0 24 24"><path d="${k.svg}"/></svg>
                    </span>
                    <span>${k.label}</span>
                </div>`).join('');
            div.innerHTML =
                `<button class="legend-toggle" type="button" aria-label="Sbalit legendu">Druhy památek</button>` +
                `<div class="legend-body">${rows}</div>`;
            L.DomEvent.disableClickPropagation(div);
            L.DomEvent.disableScrollPropagation(div);
            const toggle = div.querySelector('.legend-toggle');
            toggle.addEventListener('click', () => div.classList.toggle('collapsed'));
            return div;
        },
    });
    new Legend().addTo(map);

    // ===== Datové struktury =====
    //
    // Místo 81k JS objektů (každý ~200 B headeru + LatLng + properties) držíme:
    //   - coords: Float32Array [lat0, lng0, lat1, lng1, ...]    (8 B per bod)
    //   - katIdx: Uint8Array (0..5, index do KATEGORIE)          (1 B per bod)
    //   - krajTid: Uint8Array (0..14, kraj_tid)                  (1 B per bod)
    //   - nids:   Int32Array  [nid0, nid1, ...]                  (4 B per bod)
    //   - names:  Array<string> per bod                          (jediná velká alokace)
    //   - nidToIdx: Map<nid, idx>  pro rychlé lookups z routingu/search
    //
    // Celkem ~ 14 B + jméno per bod = ~1.1 MB binární + ~5 MB jmen = ~6 MB
    // místo původních ~80 MB pro 81k Leaflet markerů s DivIcony.

    let coords = null;
    let katIdx = null;
    let krajTid = null;
    let nids = null;
    let names = null;
    const nidToIdx = new Map();
    // glify points instance (pro pozdější vykreslení active highlight + filter)
    let glifyPoints = null;
    // Pole bodů [[lat, lng], ...] pro glify – glify si pamatuje referenci a iteruje při click hit-test.
    let glifyData = null;
    // Active highlight overlay (jediný marker, nahrazuje classlist trick)
    let activeOverlay = null;
    let activeNid = null;
    let routeCloseTimer = null;
    let dataReady = false;
    // Hover tooltip – jediný leaflet tooltip, přepojený na hover events.
    const hoverTooltip = L.tooltip({
        direction: 'top',
        offset: [0, -8],
        opacity: 0.95,
        pane: 'tooltipPane',
    });
    let hoverTooltipOpen = false;

    // Filter z searche: Set<nid> nebo null
    let searchFilter = null;

    // Cache lookups & bucket responses
    let lookups = { druh: {}, misto: {}, users: {} };
    const bucketCache = new Map();
    const detailCache = new Map();

    const katIndexFromDruh = (druhTidValue) => {
        const kat = DRUH_TO_KATEGORIE[druhTidValue] || 'default';
        return Object.keys(KATEGORIE).indexOf(kat);
    };
    const katKeyByIndex = Object.keys(KATEGORIE);

    // Props lookup pro search/routing (lazy – složí se z arrays)
    const propsByNid = (nid) => {
        const idx = nidToIdx.get(Number(nid));
        if (idx === undefined) return null;
        return {
            i: nids[idx],
            n: names[idx],
            d: undefined,  // druh_tid se v glify cestě nepoužívá – kategorie už máme
            k: krajTid[idx],
            lat: coords[idx * 2],
            lon: coords[idx * 2 + 1],
            katIdx: katIdx[idx],
        };
    };

    const normalizeRoutePath = (value) => {
        const rawPath = String(value || '/').split(/[?#]/)[0];
        let path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
        if (APP_BASE_PATH !== '/' && path.startsWith(APP_BASE_PATH)) {
            path = `/${path.slice(APP_BASE_PATH.length)}`;
        }
        return path.replace(/\/{2,}/g, '/') || '/';
    };

    const routeNidFromPath = (path) => {
        const match = normalizeRoutePath(path).match(PAMATKA_ROUTE_RE);
        return match ? Number(match[1]) : null;
    };

    const currentRouteNid = () => {
        const url = new URL(window.location.href);
        const redirectedPath = url.searchParams.get(ROUTE_QUERY_PARAM);
        return routeNidFromPath(redirectedPath || url.pathname);
    };

    const slugify = (value) => stripDiacritics(value)
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)
        .replace(/-+$/g, '');

    const pamatkaPath = (nid) => {
        const props = propsByNid(nid);
        const slug = slugify(props?.n);
        return `${APP_BASE_PATH}pamatka/${Number(nid)}${slug ? `-${slug}` : ''}`;
    };

    const setHistoryPath = (path, state, replace = false) => {
        if (!window.history?.pushState) return;
        if (window.location.pathname === path && !window.location.search && !window.location.hash) return;
        window.history[replace ? 'replaceState' : 'pushState'](state, '', path);
    };

    const setPamatkaRoute = (nid, { replace = false } = {}) => {
        const normalizedNid = Number(nid);
        setHistoryPath(pamatkaPath(normalizedNid), { pamatkaNid: normalizedNid }, replace);
    };

    const setMapRoute = ({ replace = false } = {}) => {
        if (!currentRouteNid() && !new URL(window.location.href).searchParams.has(ROUTE_QUERY_PARAM)) return;
        setHistoryPath(APP_BASE_PATH, { pamatkaNid: null }, replace);
    };

    const updateDocumentTitle = (nid) => {
        const name = nid ? propsByNid(nid)?.n : null;
        document.title = name ? `${name} – Drobné památky` : 'Drobné památky – mapa';
    };

    const clearRouteCloseTimer = () => {
        if (!routeCloseTimer) return;
        clearTimeout(routeCloseTimer);
        routeCloseTimer = null;
    };

    const buildMistoCesta = (mistoTermy) => {
        if (!mistoTermy || !mistoTermy.length) return '';
        let kraj = null;
        for (const tid of mistoTermy) {
            const entry = lookups.misto[tid];
            if (entry && entry.parent_tid === 0) { kraj = tid; break; }
        }
        if (!kraj) {
            return mistoTermy.map(t => lookups.misto[t]?.name).filter(Boolean).join(' · ');
        }
        const chain = [];
        const collectChildren = (parentTid) => {
            for (const tid of mistoTermy) {
                const entry = lookups.misto[tid];
                if (entry && entry.parent_tid === parentTid) {
                    chain.push({ tid, name: entry.name });
                    collectChildren(tid);
                    return;
                }
            }
        };
        chain.push({ tid: kraj, name: lookups.misto[kraj].name });
        collectChildren(kraj);
        return chain.map(c => escapeHtml(c.name)).join(' › ');
    };

    // ===== Detail panel (sidebar) =====

    const panelEl = document.getElementById('detail-panel');
    const panelContentEl = panelEl.querySelector('.detail-content');
    const panelCloseEl = panelEl.querySelector('.detail-close');

    const buildDetailHtml = (props, detail) => {
        const title = props.n || 'Bez názvu';
        // Při bucketu máme druh_tid v detailu (lookup do druh names).
        const druhTidVal = detail?.druh_tid;
        const druh = druhTidVal ? (lookups.druh[druhTidVal] || '') : '';

        if (!detail) {
            return `
                <h2>${escapeHtml(title)}</h2>
                <p class="loading">Načítám detail…</p>
            `;
        }

        const misto = buildMistoCesta(detail.misto_termy);
        const fotky = detail.fotky || [];

        const galleryHtml = fotky.length ? (() => {
            const heroUrl = THUMB_URL(fotky[0].path);
            const altText = escapeHtml(title);
            const thumbsHtml = fotky.length > 1 ? `
                <div class="gallery-thumbs">
                    ${fotky.map((f, idx) => {
                        const u = THUMB_URL(f.path);
                        return `<img src="${u}" alt="${altText}" data-fotka-idx="${idx}" class="${idx === 0 ? 'active' : ''}" loading="lazy">`;
                    }).join('')}
                </div>` : '';
            return `<div class="gallery-hero"><img src="${heroUrl}" alt="${altText}" id="detail-hero-img" loading="lazy"></div>${thumbsHtml}`;
        })() : '';

        const popisParts = [
            detail.popis?.zvlastnost,
            detail.popis?.oborano,
            detail.popis?.wiki,
            detail.popis?.cesta,
        ].filter(Boolean);

        const meta = detail.metadata || {};
        const formatTs = (ts) => {
            if (!ts) return null;
            try {
                return new Date(Number(ts) * 1000).toLocaleDateString('cs-CZ');
            } catch (e) { return null; }
        };
        const createdDate = formatTs(meta.created_ts);
        const metaRows = [
            meta.pridano && `<div><strong>Přidáno:</strong> ${escapeHtml(meta.pridano)}</div>`,
            createdDate && `<div><strong>Vytvořeno:</strong> ${escapeHtml(createdDate)}</div>`,
            meta.licence && `<div><strong>Licence:</strong> ${escapeHtml(String(meta.licence))}</div>`,
            meta.wikidata_qid && `<div><strong>Wikidata:</strong> <a href="https://www.wikidata.org/wiki/${encodeURIComponent(meta.wikidata_qid)}" target="_blank" rel="noopener">${escapeHtml(meta.wikidata_qid)}</a></div>`,
            meta.nkpid && `<div><strong>NPÚ ID:</strong> ${escapeHtml(String(meta.nkpid))}</div>`,
            meta.author_uid && (() => {
                const authorName = lookups.users?.[meta.author_uid];
                return authorName
                    ? `<div><strong>Autor:</strong> ${escapeHtml(authorName)}</div>`
                    : `<div><strong>Autor uid:</strong> ${escapeHtml(String(meta.author_uid))}</div>`;
            })(),
        ].filter(Boolean);

        return `
            <h2>${escapeHtml(title)}</h2>
            <p class="detail-meta">
                ${druh ? `<strong>${escapeHtml(druh)}</strong>` : ''}
                ${druh && misto ? ' · ' : ''}
                ${misto}
            </p>
            ${galleryHtml}
            ${popisParts.map(p => `<p class="detail-popis">${escapeHtml(p)}</p>`).join('')}
            ${metaRows.length ? `<div class="detail-metaextra">${metaRows.join('')}</div>` : ''}
            <div class="detail-links">
                <a href="${ORIG_URL(props.i)}" target="_blank" rel="noopener">Zdroj na drobnepamatky.cz →</a>
            </div>
        `;
    };

    const attachGalleryHandlers = (detail) => {
        const hero = panelContentEl.querySelector('#detail-hero-img');
        const thumbs = panelContentEl.querySelectorAll('.gallery-thumbs img');
        if (!hero || !thumbs.length) return;
        thumbs.forEach(t => {
            t.addEventListener('click', () => {
                const idx = Number(t.dataset.fotkaIdx);
                const f = detail.fotky?.[idx];
                if (!f) return;
                hero.src = THUMB_URL(f.path);
                thumbs.forEach(x => x.classList.remove('active'));
                t.classList.add('active');
            });
        });
    };

    // ===== Active marker highlight =====
    // Místo classlist na DivIconu (která už v glify světě neexistuje)
    // zobrazíme jeden klasický L.marker s teardrop ikonou (zvětšenou).
    const activeIconCache = new Map();
    const buildActiveIcon = (idxKat) => {
        if (activeIconCache.has(idxKat)) return activeIconCache.get(idxKat);
        const katKey = katKeyByIndex[idxKat] || 'default';
        const cfg = KATEGORIE[katKey];
        const html = `<div class="dp-marker dp-marker-active" style="background:${cfg.color}">
            <svg viewBox="0 0 24 24"><path d="${cfg.svg}"/></svg></div>`;
        const icon = L.divIcon({
            html,
            className: 'dp-marker-wrapper',
            iconSize: [36, 36],
            iconAnchor: [18, 36],
            popupAnchor: [0, -36],
        });
        activeIconCache.set(idxKat, icon);
        return icon;
    };

    const setActiveMarker = (nid) => {
        if (activeOverlay) {
            map.removeLayer(activeOverlay);
            activeOverlay = null;
        }
        if (nid === null || nid === undefined) return;
        const props = propsByNid(nid);
        if (!props) return;
        const icon = buildActiveIcon(props.katIdx);
        activeOverlay = L.marker([props.lat, props.lon], {
            icon,
            interactive: false,  // neblokovat click na glify pod ním
            keyboard: false,
            zIndexOffset: 1000,
        });
        activeOverlay.addTo(map);
    };

    // ===== Hybrid render: na zoom >= ICON_MODE_MIN_ZOOM vykresli klasické
    // teardrop ikony per body ve viewportu. Glify vrstva se schová.
    // Na nižším zoomu naopak ukáži glify a vyprázdním ikony.
    // =======================================================================

    // Normální (ne-active) ikony per kategorie – cache, ať nealokujeme per marker.
    const iconCache = new Map();
    const buildIcon = (idxKat) => {
        if (iconCache.has(idxKat)) return iconCache.get(idxKat);
        const katKey = katKeyByIndex[idxKat] || 'default';
        const cfg = KATEGORIE[katKey];
        const html = `<div class="dp-marker" style="background:${cfg.color}">
            <svg viewBox="0 0 24 24"><path d="${cfg.svg}"/></svg></div>`;
        const icon = L.divIcon({
            html,
            className: 'dp-marker-wrapper',
            iconSize: [28, 28],
            iconAnchor: [14, 28],
            popupAnchor: [0, -28],
        });
        iconCache.set(idxKat, icon);
        return icon;
    };

    const iconLayer = L.layerGroup();
    let iconModeActive = false;
    // Cache: nid → L.Marker (recyklujeme, ať nealokujeme pokaždé když user posune mapu)
    const iconMarkerCache = new Map();

    const getOrCreateIconMarker = (idx) => {
        const nid = nids[idx];
        let marker = iconMarkerCache.get(nid);
        if (marker) return marker;
        const lat = coords[idx * 2];
        const lng = coords[idx * 2 + 1];
        marker = L.marker([lat, lng], { icon: buildIcon(katIdx[idx]) });
        marker.bindTooltip(escapeHtml(names[idx] || '?'), { direction: 'top', offset: [0, -10] });
        marker.on('click', () => {
            const props = propsByNid(nid);
            if (!props) return;
            setPamatkaRoute(nid);
            openDetailPanel(props);
        });
        iconMarkerCache.set(nid, marker);
        return marker;
    };

    const updateIconMarkers = () => {
        if (!coords) return;  // data ještě nenačtena
        const bounds = map.getBounds();
        const south = bounds.getSouth();
        const north = bounds.getNorth();
        const west = bounds.getWest();
        const east = bounds.getEast();

        // Najdi body ve viewportu (linear scan přes 81k, ~1 ms na current HW).
        const visible = new Set();
        const n = nids.length;
        for (let i = 0; i < n; i++) {
            const lat = coords[i * 2];
            const lng = coords[i * 2 + 1];
            if (lat >= south && lat <= north && lng >= west && lng <= east) {
                visible.add(nids[i]);
            }
        }

        // Diff: odeber markery, které už nejsou ve viewportu; přidej nové.
        const currentLayers = iconLayer.getLayers();
        for (const m of currentLayers) {
            const mNid = m.options._nid;
            if (!visible.has(mNid)) iconLayer.removeLayer(m);
        }
        // Re-build set těch co už jsou v layeru, ať je nepřidáme znovu
        const alreadyIn = new Set();
        for (const m of iconLayer.getLayers()) alreadyIn.add(m.options._nid);

        for (let i = 0; i < n; i++) {
            const nid = nids[i];
            if (!visible.has(nid) || alreadyIn.has(nid)) continue;
            const marker = getOrCreateIconMarker(i);
            marker.options._nid = nid;
            iconLayer.addLayer(marker);
        }
    };

    // Najdi glify canvas v DOMu (přidali jsme mu className: 'dp-glify-canvas').
    const findGlifyCanvas = () => document.querySelector('canvas.dp-glify-canvas');

    const setRenderMode = (zoom) => {
        const shouldShowIcons = zoom >= ICON_MODE_MIN_ZOOM;
        if (shouldShowIcons === iconModeActive) {
            // Mode se nemění, ale viewport možná ano – pokud jsme v icon módu,
            // updatuj které markery jsou viditelné.
            if (iconModeActive) updateIconMarkers();
            return;
        }
        iconModeActive = shouldShowIcons;
        const canvas = findGlifyCanvas();
        if (shouldShowIcons) {
            if (canvas) canvas.style.display = 'none';
            map.addLayer(iconLayer);
            updateIconMarkers();
        } else {
            map.removeLayer(iconLayer);
            iconLayer.clearLayers();  // markery zůstanou v cache, ne v DOM
            if (canvas) canvas.style.display = '';
        }
    };

    map.on('zoomend', () => setRenderMode(map.getZoom()));
    // moveend střílí často při panování – debounce, ať při rychlém pohybu
    // nedělé linear scan 81k bodů víc než 1× za 100 ms.
    let moveendTimer = null;
    map.on('moveend', () => {
        if (!iconModeActive) return;
        clearTimeout(moveendTimer);
        moveendTimer = setTimeout(updateIconMarkers, 100);
    });

    const openDetailPanel = async (props) => {
        clearRouteCloseTimer();
        activeNid = Number(props.i);
        updateDocumentTitle(props.i);
        setActiveMarker(props.i);

        panelContentEl.innerHTML = buildDetailHtml(props, null);
        panelEl.classList.add('open');
        panelEl.setAttribute('aria-hidden', 'false');

        const detail = await loadDetail(props.i, props.k);
        if (activeNid !== Number(props.i)) return;
        if (detail) {
            panelContentEl.innerHTML = buildDetailHtml(props, detail);
            attachGalleryHandlers(detail);
        }
    };

    const closeDetailPanel = ({ updateUrl = true } = {}) => {
        panelEl.classList.remove('open');
        panelEl.setAttribute('aria-hidden', 'true');
        setActiveMarker(null);
        if (activeNid !== null) {
            activeNid = null;
            updateDocumentTitle(null);
            if (updateUrl) setMapRoute();
        }
    };

    panelCloseEl.addEventListener('click', () => closeDetailPanel());
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && panelEl.classList.contains('open')) {
            closeDetailPanel();
        }
    });

    const loadBucket = (krajTidVal) => {
        if (bucketCache.has(krajTidVal)) return bucketCache.get(krajTidVal);
        const promise = fetch(BUCKET_URL(krajTidVal))
            .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
            .then(bucket => {
                for (const [nid, detail] of Object.entries(bucket)) {
                    detailCache.set(Number(nid), detail);
                }
                return bucket;
            })
            .catch(err => {
                bucketCache.delete(krajTidVal);
                throw err;
            });
        bucketCache.set(krajTidVal, promise);
        return promise;
    };

    const loadDetail = async (nid, krajTidVal) => {
        if (detailCache.has(nid)) return detailCache.get(nid);
        try {
            await loadBucket(krajTidVal || 0);
            return detailCache.get(nid) || null;
        } catch (err) {
            console.warn('Bucket pro kraj %s (památka %s) selhal:', krajTidVal, nid, err);
            return null;
        }
    };

    // ===== Glify color callback =====
    // Vrací barvu per bod. Když je searchFilter aktivní a bod není v něm, vrátíme
    // ztlumenou šedou. Glify volá tuto funkci 1× per bod při kreslení (v rAF tickem),
    // takže to není perf problém.
    const colorForIndex = (index) => {
        if (searchFilter && !searchFilter.has(nids[index])) {
            return { r: 0.7, g: 0.7, b: 0.7 };  // ztlumené šedé pro non-match
        }
        return KAT_COLORS[katKeyByIndex[katIdx[index]]];
    };
    // Opacity per bod (glify ale chce jednu globální – viz níže). Místo opacity
    // používáme šedou; je to vizuálně podobné a glify defaultně podporuje jen
    // jednu globální opacity. Při filteru tedy bod jen zešediví.

    // ===== Inicializace =====

    setStatus('Načítám lookup tabulky a master GeoJSON…');

    Promise.all([
        fetch(LOOKUPS_URL).then(r => r.ok ? r.json() : Promise.reject(`lookups HTTP ${r.status}`)),
        fetch(MASTER_URL).then(r => r.ok ? r.json() : Promise.reject(`master HTTP ${r.status}`)),
    ]).then(([lk, geo]) => {
        lookups = lk;

        const features = geo.features || [];
        const n = features.length;

        // Alokuj TypedArrays
        coords = new Float32Array(n * 2);
        katIdx = new Uint8Array(n);
        krajTid = new Uint8Array(n);
        nids = new Int32Array(n);
        names = new Array(n);
        glifyData = new Array(n);

        for (let i = 0; i < n; i++) {
            const f = features[i];
            const c = f.geometry?.coordinates;
            const p = f.properties || {};
            // GeoJSON má [lng, lat]; glify points přijímá [lat, lng] (default coordinate order).
            const lng = c[0];
            const lat = c[1];
            coords[i * 2]     = lat;
            coords[i * 2 + 1] = lng;
            katIdx[i] = katIndexFromDruh(p.d);
            krajTid[i] = p.k || 0;
            nids[i] = p.i;
            names[i] = p.n || '';
            nidToIdx.set(p.i, i);
            glifyData[i] = [lat, lng];
        }
        // Originální geo již dál nepotřebujeme – nechť GC ho uvolní.
        // (features array drží referenci přes closure features – pojistka by byla
        //  ji explicitně null-ovat, ale po opuštění této then() funkce zmizí sama.)

        // ===== Glify points layer =====
        glifyPoints = L.glify.points({
            map,
            data: glifyData,
            size: POINT_SIZE,
            opacity: 0.85,
            sensitivity: POINT_SENSITIVITY,
            color: colorForIndex,
            className: 'dp-glify-canvas',
            // Click hit-test: glify předá (e, point, xy) – point je [lat, lng], ale
            // pro identifikaci konkrétního bodu musíme dohledat index. Glify
            // bohužel v public API neposílá index přímo, takže ho najdeme přes
            // referenci v glifyData (point === glifyData[idx]).
            click: (e, point) => {
                const idx = glifyData.indexOf(point);
                if (idx < 0) return;
                const nid = nids[idx];
                const props = propsByNid(nid);
                if (!props) return;
                setPamatkaRoute(nid);
                openDetailPanel(props);
                return false;  // konzumuje event
            },
            hover: (e, point) => {
                const idx = glifyData.indexOf(point);
                if (idx < 0) return;
                const name = names[idx] || '?';
                const latlng = L.latLng(coords[idx * 2], coords[idx * 2 + 1]);
                hoverTooltip.setLatLng(latlng).setContent(escapeHtml(name));
                if (!hoverTooltipOpen) {
                    hoverTooltip.addTo(map);
                    hoverTooltipOpen = true;
                }
            },
        });

        // Click na mapě mimo bod → schovat tooltip (glify nemá hoverOff pro points).
        map.on('click', () => {
            if (hoverTooltipOpen) {
                map.removeLayer(hoverTooltip);
                hoverTooltipOpen = false;
            }
        });
        map.on('mouseout', () => {
            if (hoverTooltipOpen) {
                map.removeLayer(hoverTooltip);
                hoverTooltipOpen = false;
            }
        });

        const druhyCount = Object.keys(lookups.druh).length;
        const mistaCount = Object.keys(lookups.misto).length;
        setStatus(`${n.toLocaleString('cs-CZ')} památek · ${druhyCount} druhů · ${mistaCount.toLocaleString('cs-CZ')} správních jednotek. Zdroj: drobnepamatky.cz`);

        dataReady = true;
        initSearch();
        // Inicializuj render mode podle aktuálního zoomu (CZ_ZOOM=7 → glify mód).
        setRenderMode(map.getZoom());
        requestAnimationFrame(() => {
            try {
                if (!openRouteFromLocation({ replaceUrl: true }) && !currentRouteNid()) {
                    setMapRoute({ replace: true });
                }
            } catch (err) {
                console.error('initial routing failed:', err);
                setMapRoute({ replace: true });
            }
        });
    }).catch((err) => {
        console.error('Chyba načítání:', err);
        setStatus(`Nelze načíst data: ${err}`);
    });

    // ===== Search =====

    let miniSearch = null;
    let miniSearchLoading = null;
    let lastQuery = '';
    let focusedIdx = -1;

    const inputEl = document.getElementById('search-input');
    const resultsEl = document.getElementById('search-results');

    const showResultsMsg = (msg) => {
        resultsEl.innerHTML = `<div class="search-results-status">${escapeHtml(msg)}</div>`;
        resultsEl.hidden = false;
    };

    const hideResults = () => {
        resultsEl.hidden = true;
        resultsEl.innerHTML = '';
        focusedIdx = -1;
    };

    const loadSearchIndex = () => {
        if (miniSearch) return Promise.resolve(miniSearch);
        if (miniSearchLoading) return miniSearchLoading;
        miniSearchLoading = fetch(SEARCH_INDEX_URL)
            .then(r => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status} pro ${SEARCH_INDEX_URL}`)))
            .then(text => {
                if (!text || typeof text !== 'string') {
                    throw new Error(`search-index empty/invalid (${typeof text})`);
                }
                const opts = {
                    fields: ['n', 'd', 'm'],
                    processTerm: stripDiacritics,
                    searchOptions: {
                        boost: { n: 2, m: 1.5 },
                        fuzzy: 0.2,
                        prefix: true,
                        processTerm: stripDiacritics,
                    },
                };
                miniSearch = window.MiniSearch.loadJSON(text, opts);
                return miniSearch;
            })
            .catch(err => {
                miniSearchLoading = null;
                console.warn('search-index load selhal:', err);
                throw err;
            });
        return miniSearchLoading;
    };

    // Aplikuje filter → glify překreslí s ztlumenou šedou pro non-match.
    const applyMarkerFilter = (highlightedNids) => {
        searchFilter = highlightedNids;
        if (glifyPoints) glifyPoints.render();  // re-evaluate color callback
    };

    const renderResults = (hits) => {
        if (!hits.length) {
            showResultsMsg('Nic nenalezeno');
            return;
        }
        const rows = hits.slice(0, SEARCH_MAX_RESULTS).map((h, idx) => {
            const props = propsByNid(h.id);
            const katKey = props ? katKeyByIndex[props.katIdx] : 'default';
            const druhLabel = KATEGORIE[katKey]?.label || '';
            return `<div class="search-result" data-nid="${h.id}" data-idx="${idx}">
                <div class="name">${escapeHtml(props?.n || '(bez názvu)')}</div>
                <div class="sub">${escapeHtml(druhLabel)}</div>
            </div>`;
        }).join('');
        resultsEl.innerHTML = rows;
        resultsEl.hidden = false;
        focusedIdx = -1;
    };

    const goToMarker = (nid, { updateUrl = true, replaceUrl = false } = {}) => {
        const normalizedNid = Number(nid);
        const props = propsByNid(normalizedNid);
        if (!props) return false;

        clearRouteCloseTimer();
        activeNid = normalizedNid;
        updateDocumentTitle(normalizedNid);
        if (updateUrl) setPamatkaRoute(normalizedNid, { replace: replaceUrl });

        const latlng = L.latLng(props.lat, props.lon);
        map.flyTo(latlng, Math.max(map.getZoom(), 16), { duration: 0.6 });
        // Po animaci otevřít panel; flyTo timing je ~600 ms s easing, panel
        // může jít hned (sidebar slide je nezávislý).
        openDetailPanel(props);
        return true;
    };

    const openRouteFromLocation = ({ replaceUrl = false } = {}) => {
        const nid = currentRouteNid();
        if (!nid) return false;

        const opened = goToMarker(nid, { updateUrl: true, replaceUrl });
        if (!opened) {
            showToast(`Památka č. ${nid} v archivu není – zobrazuji mapu.`);
            setMapRoute({ replace: true });
            updateDocumentTitle(null);
        }
        return opened;
    };

    window.addEventListener('popstate', () => {
        if (!dataReady) return;
        const nid = currentRouteNid();
        if (nid) {
            goToMarker(nid, { updateUrl: false });
            return;
        }
        closeDetailPanel({ updateUrl: false });
    });

    // Pre-warm bucket pro Středočeský kraj (nejvíc památek)
    const PREWARM_KRAJ = 2;

    const runSearch = (q) => {
        if (!miniSearch) return;
        const hits = miniSearch.search(q);
        renderResults(hits);
        applyMarkerFilter(new Set(hits.map(h => h.id)));
    };

    let debounceTimer = null;
    inputEl.addEventListener('input', () => {
        const q = inputEl.value.trim();
        clearTimeout(debounceTimer);
        if (q.length < SEARCH_MIN_CHARS) {
            hideResults();
            applyMarkerFilter(null);
            return;
        }
        if (q === lastQuery) return;
        lastQuery = q;

        debounceTimer = setTimeout(async () => {
            showResultsMsg('Hledám…');
            try {
                await loadSearchIndex();
                runSearch(q);
            } catch (err) {
                console.error('Search index error:', err);
                showResultsMsg(`Chyba: ${err}`);
            }
        }, SEARCH_DEBOUNCE_MS);
    });

    resultsEl.addEventListener('click', (e) => {
        const item = e.target.closest('.search-result');
        if (!item) return;
        goToMarker(item.dataset.nid);
        hideResults();
        inputEl.blur();
    });

    inputEl.addEventListener('keydown', (e) => {
        const items = resultsEl.querySelectorAll('.search-result');
        if (e.key === 'Escape') {
            hideResults();
            inputEl.value = '';
            lastQuery = '';
            applyMarkerFilter(null);
            inputEl.blur();
            return;
        }
        if (!items.length) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            focusedIdx = (focusedIdx + 1) % items.length;
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            focusedIdx = (focusedIdx - 1 + items.length) % items.length;
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const target = items[focusedIdx >= 0 ? focusedIdx : 0];
            if (target) {
                goToMarker(target.dataset.nid);
                hideResults();
                inputEl.blur();
            }
            return;
        } else {
            return;
        }
        items.forEach(it => it.classList.remove('focused'));
        items[focusedIdx]?.classList.add('focused');
        items[focusedIdx]?.scrollIntoView({ block: 'nearest' });
    });

    document.addEventListener('click', (e) => {
        if (!resultsEl.contains(e.target) && e.target !== inputEl) {
            hideResults();
        }
    });

    const initSearch = () => {
        if ('requestIdleCallback' in window) {
            requestIdleCallback(() => loadSearchIndex().catch(() => {}));
            requestIdleCallback(() => loadBucket(PREWARM_KRAJ).catch(() => {}));
        }
    };
})();
