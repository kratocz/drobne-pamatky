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

    // ===== Marker ikony per kategorie druhu =====
    // 5 vizuálně odlišených kategorií + default. Mapping z 31 druhů (term_data vid=5).
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
        // ostatní druhy (Altán, Dopravní p., Hodiny, Kašna, Něco jiného, Obrázek,
        // Technická p., Nenalezena, Nevybráno, Neznámý) → default
    };

    const iconCache = new Map();  // kategorie key → L.DivIcon (recycled per kat)
    const buildIcon = (druhTid) => {
        const kat = DRUH_TO_KATEGORIE[druhTid] || 'default';
        if (iconCache.has(kat)) return iconCache.get(kat);
        const cfg = KATEGORIE[kat];
        const html = `<div class="dp-marker" style="background:${cfg.color}">
            <svg viewBox="0 0 24 24"><path d="${cfg.svg}"/></svg></div>`;
        const icon = L.divIcon({
            html,
            className: 'dp-marker-wrapper',
            iconSize: [28, 28],
            iconAnchor: [14, 28],
            popupAnchor: [0, -28],
            tooltipAnchor: [0, -28],
        });
        iconCache.set(kat, icon);
        return icon;
    };

    const statusEl = document.getElementById('status');
    const setStatus = (msg) => { statusEl.textContent = msg; };

    // Nenápadný toast pruh nahoře – auto-fade po několika sekundách.
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

    const cluster = L.markerClusterGroup({
        showCoverageOnHover: false,
        // Původní agresivnější clustering: na nižších zoomech velké shluky,
        // jednotlivé markery až street-level. Méně agresivní hodnoty (40/13)
        // způsobovaly viditelné seknutí kvůli vykreslování tisíců DivIcon
        // SVG markerů najednou.
        maxClusterRadius: 60,
        disableClusteringAtZoom: 16,
        chunkedLoading: true,
    });
    map.addLayer(cluster);

    // Když cluster přeskupí markery (zoom/pan), DOM elementy se obnoví.
    // Re-aplikuj .marker-active na aktivně vybraný marker.
    cluster.on('animationend', () => {
        if (activeMarker) {
            activeMarker.getElement()?.classList.add('marker-active');
        }
    });

    L.control.layers(baseLayers, { 'Drobné památky': cluster }, { position: 'topright' }).addTo(map);
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
            // Prevent map drag/zoom při interakci s legendou
            L.DomEvent.disableClickPropagation(div);
            L.DomEvent.disableScrollPropagation(div);
            // Toggle collapse on title click
            const toggle = div.querySelector('.legend-toggle');
            toggle.addEventListener('click', () => div.classList.toggle('collapsed'));
            return div;
        },
    });
    new Legend().addTo(map);

    // Cache lookups & bucket responses (bucket = dict {nid: detail} per kraj_tid)
    let lookups = { druh: {}, misto: {}, users: {} };
    const bucketCache = new Map();         // kraj_tid → Promise<bucket dict>
    const detailCache = new Map();          // nid → detail (cached po prvním přístupu)
    // nid → L.Marker; pro search → flyTo + openPopup
    const markersByNid = new Map();
    // Aktuálně zvýrazněný marker (sidebar otevřen pro tuto památku)
    let activeMarker = null;
    // Master feature properties (nid → {n, d, lat, lon}) – pro search results display
    const propsByNid = new Map();
    let activeNid = null;
    let routeCloseTimer = null;
    let dataReady = false;

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
        const props = propsByNid.get(Number(nid));
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
        const name = nid ? propsByNid.get(Number(nid))?.n : null;
        document.title = name ? `${name} – Drobné památky` : 'Drobné památky – mapa';
    };

    const clearRouteCloseTimer = () => {
        if (!routeCloseTimer) return;
        clearTimeout(routeCloseTimer);
        routeCloseTimer = null;
    };

    const scheduleMapRouteAfterPopupClose = () => {
        clearRouteCloseTimer();
        routeCloseTimer = setTimeout(() => {
            routeCloseTimer = null;
            if (activeNid === null) {
                updateDocumentTitle(null);
                setMapRoute();
            }
        }, 0);
    };

    const buildMistoCesta = (mistoTermy) => {
        // Z misto_termy (pole tids) postavit hierarchii: ku → obec → okres → kraj.
        // Použijeme parent_tid mapping z lookups: kraj má parent_tid=0.
        if (!mistoTermy || !mistoTermy.length) return '';

        // Najít kraj (parent_tid === 0) a postavit hierarchii odzhora.
        const tids = new Set(mistoTermy);
        let kraj = null;
        for (const tid of mistoTermy) {
            const entry = lookups.misto[tid];
            if (entry && entry.parent_tid === 0) { kraj = tid; break; }
        }
        if (!kraj) {
            // fallback: prostě seznam názvů
            return mistoTermy.map(t => lookups.misto[t]?.name).filter(Boolean).join(' · ');
        }

        // Sestavit chain od kraje dolů: kraj → okres → obec → ku
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
        const druh = lookups.druh[props.d] || '';

        if (!detail) {
            return `
                <h2>${escapeHtml(title)}</h2>
                <p class="detail-meta">${druh ? `<strong>${escapeHtml(druh)}</strong>` : ''}</p>
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
                // Profily na drobnepamatky.cz nejsou veřejné (login wall) – jen text, žádný odkaz.
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

    const setActiveMarker = (nid) => {
        // Odstranit highlight ze stávajícího aktivního markeru
        if (activeMarker) {
            activeMarker.getElement()?.classList.remove('marker-active');
            activeMarker = null;
        }
        if (nid === null || nid === undefined) return;
        const marker = markersByNid.get(Number(nid));
        if (!marker) return;
        activeMarker = marker;
        // Force opacity 1 (override search-filter zešednutí)
        marker.setOpacity(1);
        // Element existuje jen pokud je marker právě vykreslen (mimo cluster).
        // Pokud je v clusteru, class se doplní v `animationend` listeneru níže.
        marker.getElement()?.classList.add('marker-active');
    };

    const openDetailPanel = async (props) => {
        clearRouteCloseTimer();
        activeNid = Number(props.i);
        updateDocumentTitle(props.i);
        setActiveMarker(props.i);

        // Loading state hned
        panelContentEl.innerHTML = buildDetailHtml(props, null);
        panelEl.classList.add('open');
        panelEl.setAttribute('aria-hidden', 'false');

        const detail = await loadDetail(props.i, props.k);
        // Pokud user mezitím zavřel panel nebo otevřel jiný, neaktualizuj content
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

    const loadBucket = (krajTid) => {
        if (bucketCache.has(krajTid)) return bucketCache.get(krajTid);
        const promise = fetch(BUCKET_URL(krajTid))
            .then(r => r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`))
            .then(bucket => {
                // přimíchat do detailCache pro instant retrieval
                for (const [nid, detail] of Object.entries(bucket)) {
                    detailCache.set(Number(nid), detail);
                }
                return bucket;
            })
            .catch(err => {
                bucketCache.delete(krajTid);
                throw err;
            });
        bucketCache.set(krajTid, promise);
        return promise;
    };

    const loadDetail = async (nid, krajTid) => {
        if (detailCache.has(nid)) return detailCache.get(nid);
        try {
            await loadBucket(krajTid || 0);
            return detailCache.get(nid) || null;
        } catch (err) {
            console.warn(`Bucket pro kraj ${krajTid} (památka ${nid}) selhal:`, err);
            return null;
        }
    };

    setStatus('Načítám lookup tabulky a master GeoJSON…');

    Promise.all([
        fetch(LOOKUPS_URL).then(r => r.ok ? r.json() : Promise.reject(`lookups HTTP ${r.status}`)),
        fetch(MASTER_URL).then(r => r.ok ? r.json() : Promise.reject(`master HTTP ${r.status}`)),
    ]).then(([lk, geo]) => {
        lookups = lk;

        const layer = L.geoJSON(geo, {
            pointToLayer: (feature, latlng) => {
                const props = feature.properties || {};
                const marker = L.marker(latlng, { icon: buildIcon(props.d) });
                markersByNid.set(props.i, marker);
                propsByNid.set(props.i, {
                    i: props.i, n: props.n, d: props.d, k: props.k,
                    lat: latlng.lat, lon: latlng.lng,
                });
                return marker;
            },
            onEachFeature: (feature, lyr) => {
                const props = feature.properties || {};
                lyr.bindTooltip(props.n || '?', { direction: 'top', offset: [0, -10] });
                lyr.on('click', () => {
                    setPamatkaRoute(props.i);
                    openDetailPanel(props);
                });
            },
        });
        cluster.addLayer(layer);

        const count = geo.features?.length ?? 0;
        const druhyCount = Object.keys(lookups.druh).length;
        const mistaCount = Object.keys(lookups.misto).length;
        setStatus(`${count.toLocaleString('cs-CZ')} památek · ${druhyCount} druhů · ${mistaCount.toLocaleString('cs-CZ')} správních jednotek. Zdroj: drobnepamatky.cz`);

        dataReady = true;
        initSearch();
        // Cluster po addLayer potřebuje 1 rAF tick na inicializaci bounds,
        // jinak cluster.zoomToShowLayer při initial routing crashne na
        // 'this._northEast is undefined'.
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

    // ===== Search (lazy load search-index.json při prvním keystroku) =====

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

    // ===== Highlight markerů na mapě podle search =====

    // Nastavit opacity všech markerů podle Set nidů (null = reset všech na 1)
    const applyMarkerFilter = (highlightedNids) => {
        if (highlightedNids === null) {
            markersByNid.forEach(m => m.setOpacity(1));
            return;
        }
        markersByNid.forEach((marker, nid) => {
            // Aktivní marker (sidebar otevřený) zůstává vždy plně viditelný
            const isActive = marker === activeMarker;
            marker.setOpacity(isActive || highlightedNids.has(nid) ? 1 : 0.15);
        });
    };

    const renderResults = (hits) => {
        if (!hits.length) {
            showResultsMsg('Nic nenalezeno');
            return;
        }
        const rows = hits.slice(0, SEARCH_MAX_RESULTS).map((h, idx) => {
            const props = propsByNid.get(h.id) || {};
            const druh = lookups.druh[props.d] || '';
            return `<div class="search-result" data-nid="${h.id}" data-idx="${idx}">
                <div class="name">${escapeHtml(props.n || '(bez názvu)')}</div>
                <div class="sub">${escapeHtml(druh)}</div>
            </div>`;
        }).join('');
        resultsEl.innerHTML = rows;
        resultsEl.hidden = false;
        focusedIdx = -1;
    };

    const goToMarker = (nid, { updateUrl = true, replaceUrl = false } = {}) => {
        const normalizedNid = Number(nid);
        const marker = markersByNid.get(normalizedNid);
        if (!marker) return false;

        clearRouteCloseTimer();
        activeNid = normalizedNid;
        updateDocumentTitle(normalizedNid);
        if (updateUrl) {
            setPamatkaRoute(normalizedNid, { replace: replaceUrl });
        }

        const latlng = marker.getLatLng();
        const props = propsByNid.get(normalizedNid);
        const openPanel = () => {
            if (props) openDetailPanel(props);
        };

        // Cluster.zoomToShowLayer může selhat při initial state (bounds ještě
        // nejsou dopočítané po addLayer). Fallback: flyTo + openDetailPanel
        // s krátkým delayem aby Leaflet stihl rerender.
        const useFlyTo = () => {
            map.flyTo(latlng, Math.max(map.getZoom(), 16), { duration: 0.6 });
            setTimeout(openPanel, 650);
        };

        try {
            if (cluster.hasLayer(marker)) {
                cluster.zoomToShowLayer(marker, openPanel);
            } else {
                map.flyTo(latlng, Math.max(map.getZoom(), 16), { duration: 0.6 });
                openPanel();
            }
        } catch (err) {
            console.warn('cluster.zoomToShowLayer failed, používám flyTo fallback:', err);
            useFlyTo();
        }
        return true;
    };

    const openRouteFromLocation = ({ replaceUrl = false } = {}) => {
        const nid = currentRouteNid();
        if (!nid) return false;

        const opened = goToMarker(nid, { updateUrl: true, replaceUrl });
        if (!opened) {
            showToast(`Památka č. ${nid} v archivu není – zobrazuji mapu.`);
            // Reset URL na mapu (jinak by reload znova spadl do stejné chyby)
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

        // URL ukazuje na mapu (žádný nid) → zavři panel pokud je otevřený
        closeDetailPanel({ updateUrl: false });
    });

    // Pre-warm bucket pro Středočeský kraj (nejvíc památek + první view obvykle pokrývá ČR)
    // – tichá optimalizace, na first popup je už cache hot.
    const PREWARM_KRAJ = 2;  // Středočeský

    const runSearch = (q) => {
        if (!miniSearch) return;
        const hits = miniSearch.search(q);
        renderResults(hits);
        // Highlight matching markerů na mapě (zešediv ostatní)
        applyMarkerFilter(new Set(hits.map(h => h.id)));
    };

    let debounceTimer = null;
    inputEl.addEventListener('input', () => {
        const q = inputEl.value.trim();
        clearTimeout(debounceTimer);
        if (q.length < SEARCH_MIN_CHARS) {
            hideResults();
            applyMarkerFilter(null);  // reset highlightu
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
        // pre-warm searchindex po malé idle (lepší UX, ale nezdrží initial paint)
        if ('requestIdleCallback' in window) {
            requestIdleCallback(() => loadSearchIndex().catch(() => {}));
            requestIdleCallback(() => loadBucket(PREWARM_KRAJ).catch(() => {}));
        }
    };
})();
