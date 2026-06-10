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
- [Leaflet.glify](https://github.com/robertleeplummerjr/Leaflet.glify) – WebGL renderer pro vykreslení všech ~81k bodů bez clusteringu
- [MiniSearch](https://github.com/lucaong/minisearch) – fulltextové vyhledávání v prohlížeči
- Mapové podklady: OpenStreetMap, OpenTopoMap, WMS [ČÚZK Ortofoto](https://geoportal.cuzk.cz/)
- Data ve formátu **GeoJSON**, statický hosting na **GitHub Pages**

## Spuštění lokálně

Statická stránka – stačí libovolný HTTP server v adresáři projektu:

```bash
python3 -m http.server 8000
# nebo
npx serve .
```

Otevřít [http://localhost:8000](http://localhost:8000).

## Aktualizace dat ze zdroje

Vlastní snapshot z produkční Drupal databáze (vyžaduje SSH přístup na VPS + `.env` s DB credentials, viz [AGENTS.md](AGENTS.md)):

```bash
bash scripts/sync-from-source.sh            # full sync (hodiny, GB)
bash scripts/sync-from-source.sh --limit 50 # pilot (50 záznamů)
```

Skript přes SSH tunel stáhne aktuální data, vygeneruje JSON/GeoJSON do `data/`, dotáhne nové JPG fotky a vygeneruje AVIF náhledy (inkrementálně — pomocí `data/thumbs-manifest.json` jako diff base). Po proběhnutí zkontrolujte `git diff data/` a manuálně commitněte.

Pro deploy na `gh-pages` po commitu: `bash scripts/deploy.sh`.

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

Plně funkční mapa s ~81 000 reálnými záznamy památek importovanými z databáze původního webu. Detail panel s fotogalerií, fulltextové vyhledávání, hluboké odkazy na konkrétní památku (`/pamatka/<nid>-<slug>/`). Aktivní vývoj – viz [otevřené issues](https://github.com/kratocz/drobne-pamatky/issues).

## Plánovaná vylepšení a hlášení chyb

Úkoly, nápady a bugy jsou vedeny jako [GitHub Issues](https://github.com/kratocz/drobne-pamatky/issues). Pokud narazíte na problém, máte návrh na vylepšení nebo se chcete na něčem podílet, založte (nebo si vyberte) issue tam – diskuse probíhá u konkrétního ticketu.

## Licence

Data památek pocházejí z [drobnepamatky.cz](https://www.drobnepamatky.cz/) a podléhají licenci tamních autorů. Kód tohoto repozitáře je pod licencí MIT – viz [LICENSE](LICENSE).

## Autor archivační větve

**Petr Kratochvíl** · [krato.cz](https://krato.cz) · [krato@krato.cz](mailto:krato@krato.cz)

Tento repozitář je nezávislá archivační iniciativa – není oficiálním produktem autorů původního webu drobnepamatky.cz, kteří jsou tvůrci samotných dat a fotografií.
