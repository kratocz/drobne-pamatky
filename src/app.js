(function () {
    'use strict';

    const CZ_CENTER = [49.8, 15.5];
    const CZ_ZOOM = 7;
    const DATA_URL = 'data/pamatky.geojson';

    const statusEl = document.getElementById('status');
    const setStatus = (msg) => { statusEl.textContent = msg; };

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
        'ČÚZK Základní mapa': L.tileLayer.wms('https://services.cuzk.cz/wms/wms.asp', {
            layers: 'GR_ZM10,GR_ZM25,GR_ZM50',
            format: 'image/png',
            transparent: true,
            attribution: '© <a href="https://geoportal.cuzk.cz/">ČÚZK</a>',
            maxZoom: 18,
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

    const escapeHtml = (str) => String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const buildPopupHtml = (props) => {
        const meta = [props.type, props.municipality, props.region, props.year]
            .filter(Boolean)
            .map(escapeHtml)
            .join(' · ');

        const sourceLink = props.source_url
            ? `<a class="source-link" href="${escapeHtml(props.source_url)}" target="_blank" rel="noopener">Zdroj na drobnepamatky.cz →</a>`
            : '';

        return `
            <div class="popup-pamatka">
                <h3>${escapeHtml(props.name || 'Bez názvu')}</h3>
                ${meta ? `<p class="meta">${meta}</p>` : ''}
                ${props.description ? `<p class="description">${escapeHtml(props.description)}</p>` : ''}
                ${sourceLink}
            </div>
        `;
    };

    setStatus('Načítám data památek…');

    fetch(DATA_URL)
        .then((res) => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        })
        .then((geojson) => {
            const layer = L.geoJSON(geojson, {
                pointToLayer: (_, latlng) => L.marker(latlng),
                onEachFeature: (feature, lyr) => {
                    lyr.bindPopup(buildPopupHtml(feature.properties || {}));
                },
            });
            cluster.addLayer(layer);

            const count = geojson.features?.length ?? 0;
            setStatus(`Načteno ${count.toLocaleString('cs-CZ')} památek. Zdroj: drobnepamatky.cz`);

            if (count > 0) {
                try {
                    map.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 12 });
                } catch (e) { /* prázdná data, neměnit pohled */ }
            }
        })
        .catch((err) => {
            console.error('Chyba načítání dat:', err);
            setStatus(`Nelze načíst data památek: ${err.message}`);
        });
})();
