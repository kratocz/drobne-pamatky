(function () {
    'use strict';

    const CZ_CENTER = [49.8, 15.5];
    const CZ_ZOOM = 7;
    const MASTER_URL = 'data/pamatky.geojson';
    const LOOKUPS_URL = 'data/lookups.json';
    const SEARCH_INDEX_URL = 'data/search-index.json';
    const DETAIL_URL = (nid) => `data/details/${nid}.json`;
    const THUMB_URL = (filepath) => {
        const m = filepath.match(/^files\/(\d{4})\/(.+)\.jpg$/i);
        return m ? `data/thumbs/${m[1]}/${m[2]}.avif` : null;
    };
    const ORIG_URL = (nid) => `https://www.drobnepamatky.cz/node/${nid}`;

    const SEARCH_MIN_CHARS = 2;
    const SEARCH_MAX_RESULTS = 12;
    const SEARCH_DEBOUNCE_MS = 200;

    const statusEl = document.getElementById('status');
    const setStatus = (msg) => { statusEl.textContent = msg; };

    const escapeHtml = (str) => String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

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
        maxClusterRadius: 60,
        disableClusteringAtZoom: 16,
        chunkedLoading: true,
    });
    map.addLayer(cluster);

    L.control.layers(baseLayers, { 'Drobné památky': cluster }, { position: 'topright' }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);

    // Cache lookups & detail responses
    let lookups = { druh: {}, misto: {} };
    const detailCache = new Map();
    // nid → L.Marker; pro search → flyTo + openPopup
    const markersByNid = new Map();
    // Master feature properties (nid → {n, d, lat, lon}) – pro search results display
    const propsByNid = new Map();

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

    const buildPopupHtml = (props, detail) => {
        const title = props.n || 'Bez názvu';
        const druh = lookups.druh[props.d] || '';
        const misto = detail ? buildMistoCesta(detail.misto_termy) : '<em>načítám…</em>';
        const popis = detail?.popis?.zvlastnost || detail?.popis?.wiki || detail?.popis?.sidlo || '';
        const fotka = detail?.fotky?.[0];
        const thumbUrl = fotka ? THUMB_URL(fotka.path) : null;

        return `
            <div class="popup-pamatka">
                <h3>${escapeHtml(title)}</h3>
                <p class="meta">
                    ${druh ? `<strong>${escapeHtml(druh)}</strong>` : ''}
                    ${druh && misto ? ' · ' : ''}
                    ${misto}
                </p>
                ${thumbUrl ? `<div class="thumb"><img src="${thumbUrl}" alt="${escapeHtml(title)}" loading="lazy"></div>` : ''}
                ${popis ? `<p class="description">${escapeHtml(popis)}</p>` : ''}
                <p class="links">
                    <a class="source-link" href="${ORIG_URL(props.i)}" target="_blank" rel="noopener">
                        Zdroj na drobnepamatky.cz →
                    </a>
                </p>
            </div>
        `;
    };

    const loadDetail = async (nid) => {
        if (detailCache.has(nid)) return detailCache.get(nid);
        try {
            const res = await fetch(DETAIL_URL(nid));
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const detail = await res.json();
            detailCache.set(nid, detail);
            return detail;
        } catch (err) {
            console.warn(`Detail ${nid} se nepodařilo načíst:`, err);
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
                const marker = L.marker(latlng);
                const props = feature.properties || {};
                markersByNid.set(props.i, marker);
                propsByNid.set(props.i, {
                    n: props.n, d: props.d,
                    lat: latlng.lat, lon: latlng.lng,
                });
                return marker;
            },
            onEachFeature: (feature, lyr) => {
                const props = feature.properties || {};
                lyr.bindTooltip(props.n || '?', { direction: 'top', offset: [0, -10] });
                lyr.bindPopup(buildPopupHtml(props, null), { minWidth: 240, maxWidth: 320 });
                lyr.on('popupopen', async (e) => {
                    const detail = await loadDetail(props.i);
                    if (detail) {
                        e.popup.setContent(buildPopupHtml(props, detail));
                    }
                });
            },
        });
        cluster.addLayer(layer);

        const count = geo.features?.length ?? 0;
        const druhyCount = Object.keys(lookups.druh).length;
        const mistaCount = Object.keys(lookups.misto).length;
        setStatus(`${count.toLocaleString('cs-CZ')} památek · ${druhyCount} druhů · ${mistaCount.toLocaleString('cs-CZ')} správních jednotek. Zdroj: drobnepamatky.cz`);

        initSearch();
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
            .then(r => r.ok ? r.text() : Promise.reject(`HTTP ${r.status}`))
            .then(text => {
                const opts = {
                    fields: ['n', 'd', 'm'],
                    searchOptions: { boost: { n: 2, m: 1.5 }, fuzzy: 0.2, prefix: true },
                };
                miniSearch = window.MiniSearch.loadJSON(text, opts);
                return miniSearch;
            })
            .catch(err => {
                miniSearchLoading = null;
                throw err;
            });
        return miniSearchLoading;
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

    const goToMarker = (nid) => {
        const marker = markersByNid.get(Number(nid));
        if (!marker) return;
        const latlng = marker.getLatLng();
        // Pokud je v clusteru, otevři přes parent group
        if (cluster.hasLayer(marker)) {
            cluster.zoomToShowLayer(marker, () => {
                marker.openPopup();
            });
        } else {
            map.flyTo(latlng, Math.max(map.getZoom(), 14), { duration: 0.6 });
            marker.openPopup();
        }
    };

    const runSearch = (q) => {
        if (!miniSearch) return;
        const hits = miniSearch.search(q);
        renderResults(hits);
    };

    let debounceTimer = null;
    inputEl.addEventListener('input', () => {
        const q = inputEl.value.trim();
        clearTimeout(debounceTimer);
        if (q.length < SEARCH_MIN_CHARS) {
            hideResults();
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
        if (e.key === 'Escape') { hideResults(); inputEl.blur(); return; }
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
        }
    };
})();
