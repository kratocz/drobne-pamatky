(function () {
    'use strict';

    const CZ_CENTER = [49.8, 15.5];
    const CZ_ZOOM = 7;
    const MASTER_URL = 'data/pamatky.geojson';
    const LOOKUPS_URL = 'data/lookups.json';
    const DETAIL_URL = (nid) => `data/details/${nid}.json`;
    const THUMB_URL = (filepath) => {
        const m = filepath.match(/^files\/(\d{4})\/(.+)\.jpg$/i);
        return m ? `data/thumbs/${m[1]}/${m[2]}.avif` : null;
    };
    const ORIG_URL = (nid) => `https://www.drobnepamatky.cz/node/${nid}`;

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
            pointToLayer: (_, latlng) => L.marker(latlng),
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
    }).catch((err) => {
        console.error('Chyba načítání:', err);
        setStatus(`Nelze načíst data: ${err}`);
    });
})();
