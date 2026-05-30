# Plán dlouhodobé archivace

> **Stav:** návrh, 2026-05-31 · **Reviewed by:** zatím nikdo · **Status:** čeká na rozhodnutí o licenci (viz [Otevřené otázky](#otevřené-otázky-před-prvním-snapshotem))

Předmětem plánu je rozdělit, kde a v jaké podobě hostit jednotlivé části archivu drobných památek tak, aby data **přežila výpadek libovolné jednotlivé služby** (drobnepamatky.cz, GitHub, Zenodo) bez ztráty veřejně dostupného obsahu.

## Princip vrstev

Archiv se rozdělí do **tří nezávislých vrstev**, každá s jiným účelem, životností a hostingem:

```
┌─────────────────────────────────────────────────────────────────────┐
│  L1 – FRONTEND       │  GitHub Pages (tento repozitář)              │
│  rychlý, prohlížitelný│  GeoJSON + JS + náhledy fotek                │
│  ~1 GB                │  → drobnepamatky.cz/* (vlastní doména)       │
├─────────────────────────────────────────────────────────────────────┤
│  L2 – DATASET        │  Zenodo (CERN), s DOI                        │
│  citovatelný snapshot │  Originální fotky + plný GeoJSON + manifest  │
│  ~17 GB / verze      │  → DOI v README; ročně nová verze            │
├─────────────────────────────────────────────────────────────────────┤
│  L3 – SOURCE CODE    │  GitHub veřejné repo                         │
│  kód + dokumentace   │  Automaticky archivováno Software Heritage   │
│  < 100 MB            │  (kontinuálně, bez naší akce)                │
└─────────────────────────────────────────────────────────────────────┘
```

Když zmizí kterákoli z vrstev, ostatní dvě stačí na rekonstrukci celku (popisy → metadata v L2, kód → L3, fotky → L2 originály, mapa → L1 z L2+L3 build).

## Co se hostí kde

| Artefakt | L1 GH Pages | L2 Zenodo | L3 GitHub repo |
|---|:---:|:---:|:---:|
| Mapa + JS (Leaflet, src/) | ✅ | – | ✅ source |
| GeoJSON s body památek | ✅ aktuální | ✅ snapshot/verze | ✅ generátor |
| Náhledy fotek (preset 300, ~300×200, AVIF) | ✅ | – | – |
| Zdrojové fotky (JPG, max 1200 px, ~17 GB) | – | ✅ | – |
| Bonus thumbs bundle (preset 300, ~1.6 GB, volitelné) | – | ⚠️ TBD | – |
| CSV / XLSX export | ✅ malé, ✅ aktuální | ✅ snapshot/verze | – |
| Manifest (SHA-256, GPS, druh, obec) | – | ✅ | – |
| Build skripty, dokumentace | – | – | ✅ |
| DB dump (`gk66`, ~71 MB gz) | – | ❌ obsahuje hesla | – (jen lokálně) |

> DB dump je z principu neveřejný – obsahuje hashe hesel uživatelů, e-maily, IP adresy. Drží se jen lokálně (mimo tento repozitář, v `~/IdeaProjects/.../drobnepamatky.cz/backups/`).

## L1 – Frontend (GitHub Pages)

**Limit:** 1 GB published site, 100 GB bandwidth / měsíc (soft).

**Obsah:**
- `index.html`, `src/`, `assets/` – aplikace (jednotky MB)
- `data/pamatky.geojson` – aktivní snímek metadat (~5–10 MB po minifikaci)
- `data/thumbs/<rok>/<jméno>.avif` – náhledy fotek (fit do 300×200 boxu, typicky 267×200 nebo 200×267)

**Cílový rozpočet pro náhledy v repu:** **750 MB** (rezerva 250 MB do 1 GB Pages limitu pro budoucí růst archivu).

**Empirické rozměry × quality** (sample 50 reálných fotek z `files/2024/`, encoder `avifenc -q <Q> --speed 6` / `cwebp -q <Q>`, resize `sips -Z`, extrapolace na 125 k souborů):

| Formát | Max strana | Quality | Velikost / 125k | Rezerva | Kompromis |
|---|---|---|---|---|---|
| AVIF | 200 px | q60 | 697 MB | 53 MB | dobrá web quality, malý rozměr |
| **AVIF** ⭐ | **250 px** | **q50** | **676 MB** | **74 MB** | **sweet spot – +25 % rozměr za mírné quality** |
| AVIF | 300 px | q40 | 667 MB | 83 MB | rozměr jako preset 300, viditelně nižší kvalita |
| WebP | 200 px | q75 | 731 MB | 19 MB | těsně, default web quality |
| WebP | 200 px | q65 | 649 MB | 101 MB | bezpečná rezerva, mírně horší kvalita |
| WebP | 250 px | q45 | 688 MB | 62 MB | větší rozměr, hodně horší kvalita |

> **Doporučení: AVIF, 250×188 (4:3) max @ q50.** Pro stejných ~675 MB by WebP dovolil jen 200×150 – **AVIF dává ~25 % větší rozměr při srovnatelné percepční kvalitě**, což odpovídá obecně udávané 30 % převaze AVIF nad WebP v compression efficiency.

> **Korekce předchozího odhadu:** v dřívější verzi tohoto dokumentu byl odhad „AVIF preset 300 → 700-900 MB" optimistický. Empiricky: AVIF u rozměrů pod 300 px nepřináší výraznou úsporu vůči JPG (encoder overhead je relativně velký). Realita: preset 300 (300×200 px) v AVIF q60 = ~1.5 GB / 125 k, tedy téměř stejně jako JPG.

**Strategie pro ~6 % browserů bez AVIF** (staré Edge < 121, Opera Mini): akceptovat broken image + textový popis (název památky, obec, druh) v `alt` atributu. WebP fallback v `<picture>` by ztrojnásobil objem (overhead pro malou skupinu uživatelů, nedoporučuji). Alternativně service worker s on-demand transcode – komplexní, vyhradit pro pozdější fázi.

**Zdrojové fotky pro detail view:** link do popupu „**Stáhnout v plné kvalitě** (max 1200 px, Zenodo DOI: …)" → uživatel jde na L2 pro zoom-in a tisk.

**Vlastní doména:** v plánu napojit `drobnepamatky.cz/` na GH Pages (po dohodě s autory původního webu), aby URL přežilo migrace mezi hostery.

## L2 – Zenodo dataset

**Limity Zenoda:** 50 GB / record, 100 souborů / record, 50 GB / soubor.

### Co konkrétně archivujeme

Soubory v `files/<rok>/` ze starého serveru – cca **125 k JPG**, **~17 GB**, **max 1200 px** na delší straně.

> **Důležité:** toto **NEJSOU** plné originály z fotoaparátů. Drupal při uploadu fotky **server-side resize-uje na max 1200 px** (historicky někdy 1000 px – viz roky 2018–2021). Skutečné originály z digitálních fotoaparátů (typicky 4000+ px) jsou jen na discích autorů a do veřejného archivu nikdy nešly. **1200 px je dnes archivačně minimum pro důstojnou dokumentační hodnotu** – stačí na zoom-in detailů (nápisy, reliéfy), tisk do A6/A5, reverse image search. Menší rozlišení (např. preset 300 = 267×200) má 16× méně pixelů a pro dokumentaci se nehodí.

### Strategie balíčkování (varianta A – jeden record, tar per rok)

```
Record „Drobné památky ČR – archiv fotek a metadat (vYYYY-MM-DD)"
├── README.md                            # popis datasetu, licence, citace
├── pamatky-2014.tar.zst                 # ~1.7 GB, ~10 k fotek
├── pamatky-2015.tar.zst                 # ~290 MB
├── pamatky-2016.tar.zst                 # ~380 MB
├── pamatky-2017.tar.zst                 # ~1.1 GB
├── pamatky-2018.tar.zst                 # ~1.1 GB
├── pamatky-2019.tar.zst                 # ~1.3 GB
├── pamatky-2020.tar.zst                 # ~1.6 GB
├── pamatky-2021.tar.zst                 # ~4 GB (peak)
├── pamatky-2022.tar.zst                 # ~1.4 GB
├── pamatky-2023.tar.zst                 # ~2.4 GB
├── pamatky-2024.tar.zst                 # ~2.1 GB
├── pamatky-2025.tar.zst                 # ~1.3 GB
├── pamatky-YYYY-snapshot.geojson        # plný GeoJSON ke snapshotu
├── pamatky-YYYY-snapshot.csv            # tabulkový export (kompatibilita)
└── manifest-YYYY-MM-DD.csv              # sha256 + metadata všech souborů
```

≈ 13 datových souborů + README + GeoJSON + CSV + manifest = **~17 souborů** (limit 100 ✅), **~18 GB** (limit 50 GB ✅).

**Komprese:** `tar --use-compress-program=zstd -cf … `; zstd je rychlejší a lépe komprimuje než gzip, JPG už komprimovaný moc neulehčí (5–10 %), ale `tar.zst` je standard pro vědecké datasety. Alternativa: holý `.tar` (bez komprese) – jednodušší, +5 % místa, žádná deps.

### Naming convention pro fotky uvnitř tarů

Zachovat strukturu ze serveru: `pamatky-YYYY/<rok>/<slug>-<node_id>-<delta>.jpg`

Příklad: `pamatky-2024/2024/kriz-129136-2.jpg` (node 129136, druhý obrázek)

→ Stačí extract a fotky jsou ve stejných cestách, jaké jsou v `manifest.csv`.

### Manifest

`manifest-YYYY-MM-DD.csv` – jeden řádek per fotku, sloupce:

| sloupec | obsah | příklad |
|---|---|---|
| `sha256` | hash souboru | `a3b...` |
| `bytes` | velikost | `321485` |
| `path_in_tar` | relativní cesta | `pamatky-2024/2024/kriz-129136-2.jpg` |
| `tar_file` | název tar souboru | `pamatky-2024.tar.zst` |
| `node_id` | Drupal nid | `129136` |
| `node_title` | název památky | `Kříž u Strakonic` |
| `node_type` | typ | `objekt` |
| `druh_tid`, `druh_name` | taxonomy term | `19413`, `Kříž` |
| `obec_tid`, `obec_name` | obec | `15043`, `Strakonice` |
| `latitude`, `longitude` | WGS84 | `49.260714`, `13.902521` |
| `delta` | pořadí obrázku v rámci uzlu | `2` |
| `is_primary` | hlavní foto uzlu | `true`/`false` |
| `author_name`, `author_uid` | autor (pokud licence dovolí zveřejnit) | `Petr Novák`, `123` |

→ Manifest je „source of truth" propojující fotky s metadaty bez nutnosti extrahovat tar nebo importovat GeoJSON.

## L3 – Source code & automatický archiv

Tento repozitář (`kratocz/drobne-pamatky`) zůstává minimální:

- Aplikace, build skripty, dokumentace
- **Žádné fotky, žádný DB dump**, žádné velké binárky
- Velikost cíl: **< 100 MB** (pohodlně pod GH Pages source 1 GB, ale především aby fork přes UI fungoval bez bandwidth issues)

**Software Heritage** (https://www.softwareheritage.org/) automaticky kontinuálně archivuje veřejné GitHub repozitáře. Žádná akce z naší strany. Každý commit dostane permanentní identifikátor (`swh:1:rev:…`), který lze citovat. To je třetí, defenzivní vrstva pro kód a dokumentaci.

## Versioning a frekvence snapshotů

| Aspekt | Hodnota |
|---|---|
| Frekvence L2 snapshotu | **1× ročně** (default), ad-hoc při velkých změnách |
| Verze | sémantická per dataset: `v2026.1`, `v2027.1`, … |
| **Concept DOI** | jediné napříč verzemi – v README odkazuje **vždy** na nejnovější |
| Version DOI | per snapshot – pro citace přesných dat |
| L1 update | průběžně (každý merge do `main` → deploy) |
| L3 update | průběžně (běžný git workflow) |

> Zenodo neumí editovat publikovaný record – update = vytvoření nové verze (nový record + DOI, ale shared concept DOI). Pro náš model 1× ročně je to ideální.

## Workflow pro vytvoření L2 snapshotu

Předpokladem je SSH přístup ke starému serveru + lokálně vytvořený `.env` se SSH/DB credentials (viz `AGENTS.md`).

```
┌── 1. Mirror čerstvého obsahu ze serveru (rsync)
│      → ~/IdeaProjects/.../drobnepamatky.cz/ aktualizován
├── 2. DB dump (mysqldump přes SSH tunel) → backups/
├── 3. Export GeoJSON + CSV z DB dumpu (skript v tomto repu)
├── 4. Generování manifestu (sha256 + join s DB metadaty)
├── 5. Bundling fotek po rocích (tar --zstd) → workdir/snapshot/
├── 6. Sandbox upload (sandbox.zenodo.org) – ověření workflow
├── 7. Production upload (zenodo.org) – publish → DOI
└── 8. PR do tohoto repa: update README + data/ s novým concept DOI
```

Skripty pro kroky 3–7 budou v `scripts/snapshot/` (zatím neexistuje, vytvoří se před prvním snapshotem). Doporučená implementace v Pythonu (`requests` + `tqdm` + `subprocess` pro tar/zstd) kvůli robustnosti vs bash.

## Metadata a licence

Zenodo vyžaduje minimální metadata pro publikaci:

- **Title:** "Drobné památky ČR – archiv fotek a metadat (vYYYY-MM-DD)"
- **Authors / Creators:** seznam přispěvatelů původního webu drobnepamatky.cz (anonymizovaně nebo s přiřazenými uid + jména, viz manifest)
- **Description:** dlouhý popis (přebíráme z `README.md` snapshotu)
- **Keywords:** drobné památky, sakrální architektura, kapličky, kříže, ČR, GeoJSON, Drupal, archiv
- **License:** ❗ **TBD** – musíme dohodnout s autory drobnepamatky.cz (pravděpodobně **CC-BY-SA 4.0** vzhledem ke komunitnímu charakteru; ne CC0 – autoři fotek pravděpodobně chtějí atribuci)
- **Communities:** zvážit přihlášení do tematické community (např. „Cultural Heritage", „Open Heritage")
- **Related identifiers:** odkaz na concept DOI předchozí verze, na drobnepamatky.cz, na GitHub repo

## Frontend napojení na Zenodo

Po publikaci L2 snapshotu se v tomto repu:

1. Aktualizuje `README.md` s odkazem na nový version DOI a concept DOI
2. V `index.html` se v popupu fotky přidá link „**Stáhnout v plné kvalitě:** [zenodo.org/records/XXX](…)"
3. Volitelně se v repu vytvoří soubor `data/zenodo-dois.json` s mapováním `node_id → URL k souboru v Zenodu` pro per-fotku linkování

## Otevřené otázky před prvním snapshotem

| # | Otázka | Kdo rozhodne | Bloker pro |
|---|---|---|---|
| 1 | **Licence dat a fotek** – CC-BY-SA / CC-BY / jiná? | autoři drobnepamatky.cz | publikaci jakéhokoli L2 snapshotu |
| 2 | **Atribuce autorů** – jmenovitě v manifestu / agregovaně / opt-in? | autoři / GDPR review | manifest formát |
| 3 | **Plný archiv vs. curated primary photo** – uložit všech 125 k fotek (~17 GB) nebo jen 1 hlavní per objekt (~11 GB, ~82 k fotek)? | autoři + technické rozhodnutí | velikost tarů |
| 4 | **AVIF vs WebP** pro náhledy na L1 – AVIF 250×188 @ q50 (676 MB, doporučeno) nebo WebP 200×150 @ q65 (649 MB)? Empirická data v sekci [L1](#l1--frontend-github-pages). | technické | build pipeline |
| 5 | **Vlastní doména** (`drobnepamatky.cz`) na GH Pages – kdy a kdo přepíše DNS? | autoři | URL stability po migraci |
| 6 | **Cron pro snímky** – ruční jednou ročně, nebo automatizace v GitHub Actions? | technické | implementace |
| 7 | **CC0 metadata bonus** – Zenodo doporučuje CC0 pro samotná metadata (manifest, GeoJSON) i když fotky mají přísnější licenci. Souhlas? | autoři | publikace |
| 8 | **Bonus thumbs bundle v L2** – přidat na Zenodo i tar s preset 300 náhledy (+1.6 GB / +1 soubor) pro uživatele, co chtějí kompletní offline kopii s pre-generated thumbs? Argument pro: jediný download = kompletní archiv. Argument proti: redundance (jdou snadno re-vygenerovat z 1200 px zdroje), pomalejší upload. | technické | structure tarů |

## Reference

**Interní:**
- [`AGENTS.md`](../AGENTS.md) – přístup na starý server, lokální `.env`, mysqldump workflow
- [`docs/explore-old-server.md`](explore-old-server.md) – inventura zdrojů (filesystem 21 GB, DB 444 MB, 82 k publikovaných objektů)

**Externí – Zenodo:**
- [Zenodo Developers API](https://developers.zenodo.org/) – REST endpointy pro upload
- [Zenodo Sandbox](https://sandbox.zenodo.org/) – testovací prostředí
- [Files API limity (50 GB / 100 souborů)](https://help.zenodo.org/docs/deposit/manage-files/)
- [Duplicating a repository with LFS](https://docs.github.com/en/repositories/creating-and-managing-repositories/duplicating-a-repository) – jen pro reference (LFS nepoužíváme)

**Externí – GitHub:**
- [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) – 1 GB site, 100 GB BW, 10 builds/h
- [LFS storage and bandwidth](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-storage-and-bandwidth-usage) – 10 GiB free (proto LFS nepoužíváme)

**Externí – další archivy:**
- [Software Heritage](https://www.softwareheritage.org/) – kontinuálně archivuje veřejné Git repos (automatický pro L3)
- [GitHub Arctic Code Vault](https://archiveprogram.github.com/arctic-vault/) – jednorázová akce 2020, nelze využít

**Externí – formáty obrázků (květen 2026):**
- [WebP support (caniuse) – 95.57 %](https://caniuse.com/webp)
- [AVIF support (caniuse) – 94.33 %](https://caniuse.com/avif)
- [HEIC support (caniuse) – 15.34 %, jen Safari](https://caniuse.com/heif) – nepoužíváme
- [JPEG XL (caniuse) – 15.34 %, jen Safari](https://caniuse.com/jpegxl) – nepoužíváme (Chrome odmítl 2022, dosud nezvrácen)
