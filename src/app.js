(function () {
    'use strict';

    const CZ_CENTER = [49.8, 15.5];
    const CZ_ZOOM = 7;
    const MASTER_URL = 'data/pamatky.geojson';
    const LOOKUPS_URL = 'data/lookups.json';
    const SEARCH_INDEX_URL = 'data/search-index.json';
    const BUCKET_URL = (krajTid) => `data/details/${krajTid}.json`;
    const THUMB_URL = (filepath) => {
        const m = filepath.match(/^files\/(\d{4})\/(.+)\.jpg$/i);
        return m ? `data/thumbs/${m[1]}/${m[2]}.avif` : null;
    };
    const ORIG_URL = (nid) => `https://www.drobnepamatky.cz/node/${nid}`;

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
        // Méně agresivní clustering: na vyšších zoom levelech (krajský pohled
        // a hloub) chceme vidět rychle jednotlivé památky, ne sumy.
        maxClusterRadius: 40,
        disableClusteringAtZoom: 13,
        chunkedLoading: true,
    });
    map.addLayer(cluster);

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
    let lookups = { druh: {}, misto: {} };
    const bucketCache = new Map();         // kraj_tid → Promise<bucket dict>
    const detailCache = new Map();          // nid → detail (cached po prvním přístupu)
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
                    const detail = await loadDetail(props.i, props.k);
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

    // MUSÍ být identický s processTerm v build_search_index.js – jinak query
    // tokenizované jinak než indexované termy a nic se nenajde.
    const stripDiacritics = (s) =>
        s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

    const loadSearchIndex = () => {
        if (miniSearch) return Promise.resolve(miniSearch);
        if (miniSearchLoading) return miniSearchLoading;
        miniSearchLoading = fetch(SEARCH_INDEX_URL)
            .then(r => r.ok ? r.text() : Promise.reject(`HTTP ${r.status}`))
            .then(text => {
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
            marker.setOpacity(highlightedNids.has(nid) ? 1 : 0.15);
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
