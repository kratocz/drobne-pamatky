# Průzkum starého serveru drobnepamatky.cz

> **Stav k:** 2026-05-30 · **Metoda:** read-only přes SSH (`ls`, `du`, `find`, `stat`) a SELECT dotazy na DB přes SSH tunel. Žádný zápis, žádné dotčení produkce.
>
> **Účel:** zmapovat, co cenného na starém Drupalu 6 existuje a jaké jsou objemy – jako podklad pro budoucí export do statického GeoJSON archivu.

## Souhrn (TL;DR)

| Co | Hodnota |
|---|---|
| Web root | `/www/drobnepamatky.cz/www` (Drupal 6) |
| **Fotky (originály, fyzicky na disku)** | **~17 GB v `files/<rok>/`** (243 415 JPG celkem v `files/`) |
| **Náhledy (imagecache)** | **1.9 GB** – preset `300` 1.8 GB, preset `200` 62 MB |
| Ostatní v `files/` | ~2 GB (`b/`, `c/`, `imagefield_thumbs/`, `resize/`, …) |
| `files/` celkem | **21 GB** |
| Exporty v `data/` | 90 MB (CSV 14.5 MB, XLSX 6 MB, JS dumpy, denně refreshed) |
| DB `gk66` (MySQL 5.5.47) | **444 MB** (144 tabulek) |
| **Památky (uzly typu `objekt`)** | **82 033 celkem, 81 735 publikováno** |
| Cesty (typ `cesta`) | 357 |
| Druhy památek | 31 (Kapličky, Kříže, Sochy, Boží muka, …) |
| Územní hierarchie | 19 445 termínů (obce/okresy/kraje) |
| Uživatelé | 460 registrovaných (458 alespoň jednou přihlášeno) |
| Komentáře | 1 173 (vše publikováno) |

---

## Filesystem

### Drupal core a top-level

```
/www/drobnepamatky.cz/www/
├── includes/      600K   Drupal 6 core
├── modules/       2.3M
├── themes/        1.1M
├── scripts/        33K
├── sites/          47M   (z toho 'sites/all/modules' s contrib + custom)
├── files/          21G   uživatelské nahrávky (NEstandardní cesta!)
├── data/           90M   denně generované exporty CSV/XLSX/JS
├── imports/         0    (prázdné)
├── backups/         0    (prázdné)
└── ostatní         ~1M   index.php, .htaccess, ads.txt, různé HTML
```

> ⚠️ **Pozor:** Drupal default je `sites/default/files/`, ale tento web ho má v top-level `files/`. `sites/default/files/` má jen 38K (zbylé CSS).

### `files/` – fotky a uploady

**Originály po rocích** (`files/<rok>/`):

| Rok | Velikost |
|---|---|
| 2014 | 1.7 G |
| 2015 | 290 M |
| 2016 | 380 M |
| 2017 | 1.1 G |
| 2018 | 1.1 G |
| 2019 | 1.3 G |
| 2020 | 1.6 G |
| 2021 | **4.0 G** (peak) |
| 2022 | 1.4 G |
| 2023 | 2.4 G |
| 2024 | 2.1 G |
| 2025 | 1.3 G |
| 2026 | 349 M (probíhá) |
| **Σ** | **~17 GB** |

Příklad velikostí jednotlivých fotek (`files/2024/`): typicky **150–400 KB** za originál (např. `pomnik-132654-2.jpg` = 393 K, `kriz-131034-2.jpg` = 151 K). Průměrná velikost ≈ 313 KB/foto.

**Náhledy** (`files/imagecache/<preset>/<rok>/…`):

| Preset | Celkem | 2024 (vzorek) | Pokrytí |
|---|---|---|---|
| `200` | 62 MB | 6.5 M, 1 004 souborů | ~15 % originálů má tento preset |
| `300` | 1.8 GB | 116 M, 6 899 souborů | ~100 % originálů |

> Originál `files/2024` (2.1 GB, 6 869 jpg) → preset `300` cca **18× menší** (116 MB). Pro web s prohlížeči stačí preset `300`; preset `200` se zdá historický / použitý jen pro některé starší obrázky.

**Další podadresáře** `files/`:

| Cesta | Velikost | Co to je |
|---|---|---|
| `b/` | 37 M | (neznámé – pravděpodobně historické dumpy) |
| `c/` | 8.6 M | (neznámé) |
| `a/` | 3.1 M | (neznámé) |
| `imagefield_thumbs/` | 42 M | starý/alternativní thumbnail store |
| `resize/` | 37 M | starý/alternativní resize store |
| `stranky-2014/` | 7.4 M | obsah stránek (statické HTML?) |
| `js/`, `mapy/`, `loga/`, `css/`, `icons/`, `languages/`, `dec_to_jtsk/` | < 3 M každý | pomocné |
| `drobnepamatky.csv.bak.*`, `drobnepamatky.xlsx.bak.*` | – | starší zálohy CSV/XLSX (původně v `data/`) |

**Počty obrázků** v celém `files/` (`find -iname`):

| Přípona | Počet |
|---|---|
| `.jpg` (case-insensitive) | **243 415** |
| `.png` (case-insensitive) | 98 |

> Počet souborů v DB `files` tabulce je **125 212** (originály registrované přes Drupal upload) – rozdíl 118 k souborů jsou vygenerované imagecache náhledy + historické soubory mimo Drupalí registr.

### `data/` – pravidelně generované exporty

```
data/
├── drobnepamatky.csv         14.5 MB   denní export seznam památek
├── drobnepamatky.xlsx         6.2 MB   Excel verze
├── ev_1.js                   28.1 MB   JS dump (events?)
├── e_1.js                    29.3 MB   JS dump
├── mapa.js                    9.3 MB   předpočítaná data pro mapu
└── *.bak.YYYYMMDD_*           historické snapshoty (3 generace)
```

Mtime na hlavních souborech ukazuje **denní cron** (`kvě 3 04:00`, `bře 23 04:00`, …).

### Moduly

`sites/all/modules/` – **88 modulů**, mix contrib + custom. Relevantní pro mapu / data:

- **Custom (`dp_*`):** `dp_leaflet` (vlastní Leaflet integrace pro Drupal 6), `dp_opt`
- **Geo:** `location`, `gmap`, `geolocation`, `geo_boundary`, `openlayers`
- **Obrázky:** `imageapi`, `imagecache`, `imagefield`, `imagefield_extended`, `image_resize_filter`, `insert`, `lightbox2`
- **CCK / pole:** `cck`, `content_taxonomy`, `content_clone_field`, `computed_field`, `editablefields`
- **Views:** `views`, `views_*` (bulk_ops, data_export, customfield, groupby, hierarchy, tree, …)
- **Import/export:** `node_import`, `views_data_export`, `transliteration`, `pathauto`

Témata: `sites/all/themes/kelvin` (vlastní téma).

---

## Databáze (`gk66`, MySQL 5.5.47)

### Celkem

- **144 tabulek**, **443.8 MB** (data 318.6 MB + indexy 125.2 MB)
- gzip dump by měl vyjít na ~100–150 MB

### Top 15 tabulek

| Tabulka | Řádky | Total |
|---|---:|---:|
| `content_field_obrazek` | 562 874 | 78.2 MB |
| `cache_views_data` | 2 670 | 53.5 MB |
| `content_type_objekt` | 141 420 | 48.9 MB |
| `term_node` | 665 496 | 34.2 MB |
| `sessions` | 24 149 | 28.6 MB |
| `node` | 82 523 | 25.0 MB |
| `cache_page` | 2 447 | 24.2 MB |
| `node_revisions` | 141 917 | 23.6 MB |
| `batch` | 0 | 22.6 MB (prázdné, neuvolněné místo) |
| `files` | 125 212 | 21.7 MB |
| `location_instance` | 141 923 | 14.6 MB |
| `content_field_druh` | 178 315 | 12.0 MB |
| `cache_filter` | 8 895 | 6.2 MB |
| `node_comment_statistics` | 82 522 | 5.3 MB |
| `location` | 82 867 | 4.6 MB |

> `cache_*` a `sessions` se dají pro archiv vynechat (cca 100 MB úspora).

### Obsah (uzly)

| Typ | Celkem | Publikováno |
|---|---:|---:|
| **`objekt` (drobné památky)** | **82 033** | **81 735** |
| `cesta` | 357 | 357 |
| `page` | 94 | 94 |
| `forum` | 38 | 38 |
| `story` | 1 | 1 |

### Geolokace – tabulka `location`

```sql
location:
  lid          int PRIMARY KEY auto_increment
  name         varchar(255)
  street       varchar(255)
  additional   varchar(255)
  city         varchar(255)
  province     varchar(16)
  postal_code  varchar(16)
  country      char(2)         -- typicky 'cz'
  latitude     decimal(10,6)   -- WGS84
  longitude    decimal(10,6)
  source       tinyint(4)
  is_primary   tinyint(4)
```

- **82 867** záznamů (přibližně 1:1 s publikovanými objekty)
- Ukázka: `lid=2099, country=cz, lat=49.678918, lon=13.084352` (cca Plzeň‐jih)
- Vazba node ↔ location je v tabulce `location_instance` (141 923 řádků)

### Druhy památek (taxonomy vid=5)

31 termínů – kompletní seznam pro mapování ikon na mapě:

```
Altán · Boží muka · Dopravní památka · Hodiny · Hraniční kámen ·
Kaple · Kaplička · Kašna · Krajinné umění · Kříž · Křížový kámen ·
Menhir · Něco jiného · Nenalezena · Nevybráno · Neznámý · Obrázek ·
Památná dlažba · Památník · Památný kámen · Pamětní deska · Plastika ·
Pomník · Pomník padlým · Reliéf · Sloup · Smírčí kříž · Socha ·
Technická památka · Zvonice · Zvonička
```

### Územní hierarchie (taxonomy vid=4 „Správní rozdělení")

**19 445 termínů** – kraje → okresy → obce. `term_node` (665 k řádků) drží vazby objekt ↔ obec.

### Vazba node → obrázek

Tabulka `content_field_obrazek` (CCK pole `field_obrazek` na typu `objekt`):

```
vid                   int   PRI   -- revize node
nid                   int         -- node id
delta                 int   PRI   -- pořadí obrázku v rámci uzlu
field_obrazek_fid     int         -- FK → files.fid
field_obrazek_list    tinyint
field_obrazek_data    text        -- serialized PHP (titulek, alt, ...)
```

562 k řádků = průměrně **~7 obrázků na uzel**, ale přes všechny revize – aktuální stav bude na `node_revisions` filtru `vid = node.vid`.

### Soubory (`files`)

- **125 212 záznamů**, podle DB metadat celkem **39 GB** souborů
- Mime distribuce: 125 152 `image/jpeg` + 50 `image/png` + 10 `text/csv`
- Fyzicky na disku je `files/` jen 21 GB – rozdíl 18 GB jsou pravděpodobně **deleted/missing** soubory, na které DB stále drží odkaz (běžné u Drupal 6, kde `files.status=0` znamená dočasný/orphan, ale my jsme rozdíl podle status nesplitnuli)

### Imagecache (presety v DB)

Tabulky: `imagecache_preset`, `imagecache_action`. Na disku jsou dva presety: `200` a `300`. Pro detail (jaké transformace = např. scale 300×200) by se musely dotázat tyhle tabulky.

---

## Co je vlastně cenné pro archiv

Seřazeno podle významu pro statickou archivační verzi:

1. **GeoJSON s ~82 k publikovanými památkami** – join `node` × `content_type_objekt` × `location` × `content_field_druh` × `term_data` (druh + obec). Výstup do `data/` v tomto repu.
2. **Originální fotky** – ~17 GB, ~125 k souborů. Pro GitHub Pages je 17 GB příliš (limit 1 GB repo, 100 MB/soubor). Buď
   - hostit jen náhledy (preset 300 = 1.8 GB → stále moc) na GitHubu,
   - hostit originály někde jinde (S3, Cloudflare R2, Backblaze) a v GeoJSONu mít absolutní URL,
   - nebo dělat selekci (1 hlavní foto per objekt).
3. **CSV/XLSX export v `data/`** – už existuje na serveru jako denní snapshot, jen ho přetransformovat na GeoJSON tady.
4. **Komentáře (1 173)** – uživatelský obsah, hodnota pro archiv vysoká, objem minimální (< 1 MB).
5. **Cesty (357), Stránky (94)** – sekundární obsah, dá se export do `_static/` HTML.

## Co je naopak zanedbatelné

- `cache_*` tabulky (~100 MB) – generované, do exportu nepotřeba
- `sessions`, `batch`, `devel_times`, `node_import_status` – runtime/historický šum
- `files/b/`, `files/c/`, `files/a/`, `files/resize/`, `files/imagefield_thumbs/` – pravděpodobně staré storage, hodilo by se ověřit u majitele než se zahodí
- `data/*.bak.*` – stačí poslední verze

## Otevřené otázky pro pokračování

- **Schéma `content_type_objekt`** – jaká pole drží popis, datum vzniku, autora? (proběhne při tvorbě export skriptu)
- **`field_obrazek_data`** – obsah serialized PHP, je tam i licenční info / autor fotky?
- **`imagecache_preset`** – přesná konfigurace presetu `300` (rozměry, kvalita JPG)
- **Tabulka `votingapi_*`** nebo podobné – existují hodnocení / hvězdičky?
- **Cron** – `data/` se generuje denně skriptem; kde je ten skript a co přesně dělá (pro pochopení, co už je hotové vs co musíme udělat my)
