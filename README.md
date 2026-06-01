# Drobné památky

Statická archivační verze webu [drobnepamatky.cz](https://www.drobnepamatky.cz/) – komunitní databáze drobných sakrálních a profánních památek v České republice (kapličky, kříže, boží muka, smírčí kameny apod.).

## O projektu

Cílem je vytvořit dlouhodobě životaschopnou statickou kopii dat z původního webu, hostovanou na GitHub Pages. Obsah (texty i fotografie) je se souhlasem autorů původního webu volně dostupný a zde slouží především k archivačním účelům.

> **Zdroj dat:** [drobnepamatky.cz](https://www.drobnepamatky.cz/) – komunitní projekt mapující drobné památky v ČR.
> Tento repozitář není oficiálním produktem autorů původního webu; jde o nezávislou statickou archivační kopii.

## Dlouhodobá vize

Z tohoto repozitáře se má postupně stát veřejný frontend původního webu – data i mapa staticky na GitHub Pages, na VPS zůstane pouze administrační rozhraní Drupalu, odkud se budou data periodicky exportovat sem. Cíl: oddělit dlouhodobou archivační vrstvu (rychlou, levnou, prakticky nesmrtelnou) od redakčního rozhraní, které lze kdykoli nahradit bez rizika ztráty veřejně dostupných dat.

## Technologie

- [Leaflet](https://leafletjs.com/) – interaktivní mapa
- [Leaflet.markercluster](https://github.com/Leaflet/Leaflet.markercluster) – shlukování bodů (kvůli desítkám tisíc záznamů)
- Historické mapové podklady – WMS [ČÚZK Geoportál](https://geoportal.cuzk.cz/)
- Data ve formátu **GeoJSON**, statický hosting na **GitHub Pages**

## Spuštění lokálně

Statická stránka – stačí libovolný HTTP server v adresáři projektu:

```bash
python3 -m http.server 8000
# nebo
npx serve .
```

Otevřít [http://localhost:8000](http://localhost:8000).

## Struktura

```
.
├── index.html          # vstupní stránka s mapou
├── src/                # JS moduly
├── assets/             # CSS, statické soubory
├── data/               # GeoJSON s body památek
└── README.md
```

## Stav projektu

Rozjezd – aktuálně funkční mapa s ukázkovými body. Import reálných dat z původního webu (přímo z databáze Drupalu 6) následuje.

## Licence

Data památek pocházejí z [drobnepamatky.cz](https://www.drobnepamatky.cz/) a podléhají licenci tamních autorů. Kód tohoto repozitáře je pod licencí MIT – viz [LICENSE](LICENSE).

## Autor archivační větve

**Petr Krato** · [krato.cz](https://krato.cz) · [krato@krato.cz](mailto:krato@krato.cz)

Tento repozitář je nezávislá archivační iniciativa – není oficiálním produktem autorů původního webu drobnepamatky.cz, kteří jsou tvůrci samotných dat a fotografií.
