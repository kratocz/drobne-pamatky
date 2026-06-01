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
| GeoJSON master + per-památka detail JSONy + lookups + search index | ✅ aktuální | ✅ master snapshot | ✅ generátor |
| Náhledy fotek (AVIF 250×188 @ q50, **591 MB pro 115 729 souborů** ✓) | ✅ | – | – |
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
- `data/pamatky.geojson` – master GeoJSON s body památek (~5 MB gzip, viz [Data delivery](#l1--data-delivery))
- `data/details/<nid>.json` – lazy-loaded detail per památka (82 k souborů, ~2-3 KB each)
- `data/lookups.json` – ID → name pro druhy a obce (~200 KB gzip)
- `data/search-index.json` – pre-built search index (~2 MB gzip)
- `data/thumbs/<rok>/<jméno>.avif` – náhledy fotek (max 250 px na delší straně, AVIF q50)

### L1 – Data delivery

**Problém:** 71 MB DB dump je pro klienta neudržitelně velký – cca 1 400 unikátních návštěvníků by za měsíc vyčerpalo 100 GB GH Pages bandwidth limit. Plus obsahuje hesla a další citlivá data, která nepatří na frontend. Řešení: **frontend nikdy nedostane DB dump**, dostane sadu předgenerovaných JSONů.

**Strategie – hybridní 4 vrstvy** (initial load **~2.3 MB gzip**, empiricky ověřeno):

| # | Soubor | Velikost (gzip) | Kdy se loaduje | Co obsahuje |
|---|---|---|---|---|
| 1 | `data/pamatky.geojson` | **2.1 MB** ✓ | při startu mapy | 81 735 features: GPS (`[lon,lat]`) + `n` (název) + `d` (druh tid) + `i` (nid) |
| 2 | `data/lookups.json` | **176 KB** ✓ | při startu | mapping `druh_id → název` (31 řádků) + `místo_id → {name, parent_tid}` (19 445 řádků) |
| 3 | `data/search-index.json` | **3.55 MB** ✓ | **lazy** – až po prvním searchi | pre-built MiniSearch (bez `storeFields`, index vrací jen IDs → klient si dohledá display v master + lookups) |
| 4 | `data/details/<kraj_tid>.json` (bucketed) | **~360 KB gz / kraj** ✓ (5 MB gz total, **33 MB raw, 15 souborů** – 14 krajů + bucket 0) | **on-demand** podle `k` v master properties; pre-warm Středočeského kraje přes `requestIdleCallback` | dict `{nid: detail}` pro celý kraj: popis, autor, datum, manifest fotek, plné taxonomy |

> ✓ = naměřeno full exportem 2026-06-01 (`scripts/snapshot/export.py`, 18 s, 81 735 záznamů z lokální MariaDB 10.11). Detaily v commit `2557e89`.

> **Krátké property names v `pamatky.geojson`** (`n`, `d`, `i`, `k` místo `name`, `druh`, `nid`, `kraj`) ušetří přes 81 735 features ~1-2 MB raw. Klient si mappuje zpět při zobrazení. **`k` (kraj_tid) je v master pro lazy fetch správného detail bucketu.** Obec/okres/ku se dohledávají z `details/<k>.json[nid].misto_termy` přes `lookups.misto`.

> **Bucketing detailů per kraj (strategie B):** původní design s `details/<nid>.json` (81 735 souborů × ~4 KB block padding = ~319 MB na disku) překračoval Pages 1 GB limit. Nový bucketed model (1 soubor per kraj, dict `{nid: detail}`) snížil disk usage na **33 MB** a gzip transfer na **5 MB total**. Trade-off: první popup v kraji dotáhne celý bucket (~360 KB gz), ale následující popupy v témž kraji jsou instant (vše v `detailCache`).

**Bandwidth matematika** (100 GB/měsíc soft limit, **reálná čísla**):

| Scénář | Payload | Návštěvníků / měsíc |
|---|---|---|
| **First visit, jen mapa** (master + lookups) | **2.3 MB** ✓ | **~43 000** |
| First visit + 5× klik na detail | ~2.32 MB | ~43 000 |
| First visit + 1× search (lazy load indexu) | **5.85 MB** ✓ | **~17 000** |
| Return visit (vše z cache přes Service Worker) | ~0 MB | neomezeně |

→ S aggresivním cachingem a podílem return visitors **30–60 k unique návštěvníků / měsíc** bez problémů (závisí na podílu lidí, co hledají). S Cloudflare před GH Pages efektivně neomezeně.

> **Search index je lazy** – nestahuje se při loadu stránky. Uživatel, který jen prohlíží mapu a kliká na markery, ho nepotřebuje. To výrazně šetří bandwidth: většina návštěvníků se „dostane" pod 2.3 MB, jen ti, kdo si vyhledají, dostanou +3.55 MB navíc.

**Search:** klient-side přes [MiniSearch](https://github.com/lucaong/minisearch) nebo [FlexSearch](https://github.com/nextapps-de/flexsearch). Pre-built index v `search-index.json` obsahuje **název + druh + obec + první věta popisu** – pokrývá 80 % typických queries („kapličky u Strakonic", „kříže v okrese Plzeň-jih"). Hluboký full-text přes celý popis by vyžadoval ~10 MB index – necháme na později pokud bude potřeba.

**Service Worker** (PWA pattern) cacheuje agresivně:
- `pamatky.geojson` + `lookups.json` + `search-index.json` na 24 h (stale-while-revalidate)
- `details/<nid>.json` forever (immutable + versioning přes hash v názvu nebo query param `?v=YYYY-MM-DD`)
- `thumbs/**/*.avif` forever (po vygenerování se nemění do dalšího ročního snapshotu)

**Škálovací plán B – Cloudflare před GH Pages** (free tier, unlimited bandwidth):
- Vlastní doména na CF jako proxy před GH Pages
- CF cache na `*.geojson`, `*.avif`, `*.json` agresivně
- GH Pages bandwidth se počítá jen za **origin** requesty, ne za to, co CF servíruje z cache
- Bonus: brotli komprese (~20 % menší než gzip)
- → Efektivně neomezený bandwidth pro veřejný traffic, GH Pages zůstává jen origin storage

### ✅ Formát náhledů – ROZHODNUTO: AVIF 250 × 188 (4:3) @ q50

| | Hodnota |
|---|---|
| Formát | AVIF (`avifenc --speed 6 -q 50`) |
| Max delší strana | 250 px |
| Typický náhled | **~5.1 KB** ✓ (naměřeno) |
| **Plný archiv (115 729 fotek)** ✓ | **591 MB** (skutečný obsah) |
| Rezerva do 750 MB target | **159 MB** ✓ |
| Rezerva do 1 GB Pages limitu | **433 MB** ✓ |
| Použitelná pro budoucí růst | ~5–10 let při stávajícím tempu nahrávání |
| Browser support | ~94 % (Chrome 85+, FF 93+, Safari 16.4+, Edge 121+) |
| Fallback pro ~6 % | textový `alt` (název / druh / obec), žádné WebP/JPEG fallback soubory |
| Čas batchu (10-core M1) | **28.6 min** ✓ pro 125 152 souborů (73 fotek/s průměr) |
| Missing v mirroru | 9 419 (DB má, lokální rsync mirror ne – nově nahrané po posledním rsync) |
| Errors | 4 (poškozené source JPGs nebo nečitelné EXIF) |

> ✓ = naměřeno batchem 2026-06-01 (`scripts/snapshot/build_thumbnails.py`). Originální plán předpokládal 677 MB pro 125 k souborů – realita 591 MB je o 86 MB lepší díky AVIF q50 efektivitě na 250 px rozměru.

**Cílový rozpočet pro náhledy v repu:** 750 MB (rezerva 250 MB do 1 GB Pages limitu pro budoucí růst archivu).

**Empirické rozměry × quality** – data, na základě kterých bylo rozhodnuto (sample 50 reálných fotek z `files/2024/`, encoder `avifenc -q <Q> --speed 6` / `cwebp -q <Q>`, resize `sips -Z`, extrapolace na 125 k souborů):

| Formát | Max strana | Quality | Velikost / 125k | Rezerva | Kompromis |
|---|---|---|---|---|---|
| AVIF | 200 px | q60 | 697 MB | 53 MB | dobrá web quality, malý rozměr |
| **AVIF** ⭐ | **250 px** | **q50** | **676 MB** | **74 MB** | **sweet spot – +25 % rozměr za mírné quality** |
| AVIF | 300 px | q40 | 667 MB | 83 MB | rozměr jako preset 300, viditelně nižší kvalita |
| WebP | 200 px | q75 | 731 MB | 19 MB | těsně, default web quality |
| WebP | 200 px | q65 | 649 MB | 101 MB | bezpečná rezerva, mírně horší kvalita |
| WebP | 250 px | q45 | 688 MB | 62 MB | větší rozměr, hodně horší kvalita |
| JPEG | 200 px | q60 | 725 MB | 25 MB | těsně, web-rozumná quality |
| **JPEG** ⭐ | **200 px** | **q55** | **674 MB** | **76 MB** | **alternativa s 100% browser podporou bez fallbacku** |
| JPEG | 200 px | q50 | 631 MB | 119 MB | bezpečná rezerva, znatelně nižší quality |

> **Volba (2026-05-31):** AVIF 250×188 @ q50 byla zvolena pro **největší rozměr (+25 % vs WebP/JPEG)** za stejné místo, s pohodlnou rezervou pro 5–10 let růstu archivu. Cena: ~6 % uživatelů (staré Edge < 121, Opera Mini) uvidí broken image; nahrazeno textovým popisem v `alt` atributu (název památky + druh + obec).
>
> Zvažovaná alternativa **JPEG 200×150 @ q55** (674 MB, 100 % browser support, žádný `<picture>` element) zůstává jako fallback strategie – pokud se v praxi ukáže, že 6 % uživatelů bez AVIF je problém, lze přejít na JPEG bez ztráty v MB.

> **Korekce předchozího odhadu:** v dřívější verzi tohoto dokumentu byl odhad „AVIF preset 300 → 700-900 MB" optimistický. Empiricky: AVIF u rozměrů pod 300 px nepřináší výraznou úsporu vůči JPG (encoder overhead je relativně velký). Realita: preset 300 (300×200 px) v AVIF q60 = ~1.5 GB / 125 k, tedy téměř stejně jako JPG. **Výhoda AVIF se naplno projeví až nad 300 px** (např. 600 px: AVIF q60 ~43 KB vs JPEG q85 ~75 KB).

**Strategie pro ~6 % browserů bez AVIF** (staré Edge < 121, Opera Mini): akceptovat broken image + textový popis (název památky, druh, obec) v `alt` atributu. WebP fallback v `<picture>` by ztrojnásobil objem (overhead pro malou skupinu uživatelů, nedoporučuji). Service worker s on-demand transcode – komplexní, vyhradit pro pozdější fázi pokud se ukáže potřeba.

**Zdrojové fotky pro detail view:** link do popupu „**Stáhnout v plné kvalitě** (max 1200 px, Zenodo DOI: …)" → uživatel jde na L2 pro zoom-in a tisk.

**Vlastní doména:** v plánu napojit `drobnepamatky.cz/` na GH Pages (po dohodě s autory původního webu), aby URL přežilo migrace mezi hostery. Setup viz [`cloudflare-setup.md`](cloudflare-setup.md).

### L1 – Deploy strategie

**Strategie B: `main` = code, `gh-pages` = data (orphan force-push)** ← zvolena 2026-06-01.

Repo má dva branche s odlišnou rolí:

| Branch | Role | Velikost | Update |
|---|---|---|---|
| `main` | dev / source of truth pro **kód a dokumentaci** | < 5 MB (žádná velká data) | normální commit/PR workflow |
| `gh-pages` | prod / **deploy artifact** s aktuálním snapshotem dat | **~900 MB** (115 k AVIF + 15 detail bucketů + master + lookups + search index) | `scripts/deploy.sh` force-push, **orphan branch** – žádná historie, repo size stabilní |

**Mechanismus deploye:** [`scripts/deploy.sh`](../scripts/deploy.sh) přes `git worktree --detach` + `git checkout --orphan` + `git push -f origin HEAD:gh-pages`. Historie v gh-pages se nehromadí – kanonickou historii verzí drží **L2 (Zenodo s concept DOI)**.

#### Proč ne varianta C (Pages Actions artifact)?

Moderní GitHub Pages podporuje deploy přes `actions/upload-pages-artifact` + `actions/deploy-pages` (bez `gh-pages` branche). Pro **náš konkrétní case to ale není vhodné**:

| Limit | Hodnota | Náš stav | Riziko |
|---|---|---|---|
| Pages artifact size | **1 GB official** | tar.gz ~650 MB | rezerva 35 %, ale s růstem archivu (~50 MB/rok) za 3–5 let přesáhneme |
| Deploy unpack timeout | **10 min** na unpack tarball na Pages backend | ~116 k souborů (115 k AVIF + 15 JSON + ostatní) | malé soubory pomalý per-file unpack, **na hraně 10-min timeout** |
| Build čas Actions runner | 4 vCPU `ubuntu-latest` | thumbnail batch lokálně 28.6 min (M1 Pro 10-core) → odhad **~2 hod v Actions** | OK pro public repo (zdarma), ale dlouhý dev cycle |

**Závěr:** varianta C (Pages Actions artifact) dává smysl pro menší sites (< 500 MB, < 10 k souborů). Pro naše 893 MB / 116 k souborů je **varianta B (gh-pages branch) bezpečnější** – Pages serveruje přímo z git stromu, žádný unpack-timeout, push trvá pár minut bez backend deadline. Repo size zůstává stabilní díky orphan force-push.

#### Cloudflare před Pages (volitelné, pro vyšší návštěvnost)

Bandwidth limit GitHub Pages je **100 GB/měsíc** soft → s naším avg payload ~3.5 MB / unikátní návštěvu vychází **~28 k unikátních / měsíc**. Pro běžný provoz dostatečné, pro „viral" pozornost (článek, ČT) nedostačuje. **Cloudflare Free** před Pages řeší: 95 % cache hit ratio → efektivně neomezený bandwidth + brotli + DDoS protection + free TLS.

Setup návod: [`cloudflare-setup.md`](cloudflare-setup.md). Trigger pro implementaci je vlastní doména (otevřená otázka #5).

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
| 3 | ~~Plný archiv vs. curated primary photo~~ → **✅ ROZHODNUTO 2026-05-31: plný archiv všech 125 152 fotek** (na L1 i L2). Důvod: budoucí dokumentační hodnota plné kolekce > úspora místa; L1 thumbnaily i L2 originály se vejdou do limitů. | – | – |
| 4 | ~~Formát náhledů na L1~~ → **✅ ROZHODNUTO 2026-05-31: AVIF 250×188 @ q50, plný archiv 125 152 fotek, ~677 MB v repu**. Důvod: největší rozměr za rozpočet (+25 % vs WebP/JPEG), 73 MB rezerva do 750 MB target. Fallback pro ~6 % browserů: textový `alt` (název / druh / obec). Detail v sekci [L1](#l1--frontend-github-pages). | – | – |
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
