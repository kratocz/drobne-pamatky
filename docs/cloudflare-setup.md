# Cloudflare před GitHub Pages

> **Stav:** návrh k implementaci, **2026-06-01** · **Trigger:** dohodnutá vlastní doména s autory drobnepamatky.cz (otevřená otázka #5 v [archive-planu](archive-plan.md))

Cloudflare jako CDN proxy před GitHub Pages řeší **dva konkrétní problémy** našeho deploye:

1. **Bandwidth limit GitHub Pages je 100 GB/měsíc** (soft) – už při ~50 k unikátních návštěvníků jsme na něm. Cloudflare cache snižuje origin pulls o 90–99 % → efektivně neomezený bandwidth pro veřejný traffic.
2. **GitHub Pages servuje gzip, ale ne brotli.** CF mezi origin a klientem brotlinuje on-the-fly → ~20 % menší přenos vs gzip → reálně cca **23 MB initial load** by se zmenšil na ~18 MB.

Bonus: rate-limiting, basic DDoS protection, instant cache purge přes API, free TLS certifikát, analytics.

## Co potřebuješ předem

- **Vlastní doména** – CF Free vyžaduje plnou DNS kontrolu, tj. **musíš mít doménu** (např. `drobnepamatky.cz` po dohodě s autory, nebo subdoména pod jinou doménou jako `archiv.drobnepamatky.cz` či `pamatky.kratocz.cz`).
- **GitHub Pages aktivní** s gh-pages branch (deploy přes `scripts/deploy.sh`).
- **Free Cloudflare účet.**

## Setup krok po kroku

### 1. Aktivovat GitHub Pages

`github.com/kratocz/drobne-pamatky/settings/pages`:
- **Source:** Deploy from a branch
- **Branch:** `gh-pages` · **Folder:** `/ (root)`
- **Custom domain:** zatím nech prázdné, vyplníme po CF setupu
- **Enforce HTTPS:** ✓ (povolí se po nastavení custom domény)

### 2. Přidat site do Cloudflare

1. Přihlas se na [dash.cloudflare.com](https://dash.cloudflare.com) (zdarma).
2. **"Add a Site"** → zadej root doménu (např. `drobnepamatky.cz` nebo `kratocz.cz` pokud používáš subdoménu).
3. Vyber **Free plan**.
4. CF automaticky importuje existující DNS záznamy. Zkontroluj, že nic kritického nechybí (MX pro maily, A pro existující web atd.).

### 3. Přepnout nameservery

CF ti dá 2 vlastní NS (např. `dana.ns.cloudflare.com`, `tom.ns.cloudflare.com`). U své domain registrar (typicky CZ.NIC, namecheap, …) **přepiš nameservery** z původních na CF.

→ Propaguje se 1–24 hodin. Status CF dashboard ukáže „Active" jakmile je to hotovo.

### 4. DNS záznamy pro GitHub Pages

V CF Dashboard → **DNS → Records** přidej:

| Type | Name | Content | Proxy status |
|---|---|---|---|
| `CNAME` | `@` (nebo `archiv`, `pamatky` – cokoli chceš) | `kratocz.github.io` | **Proxied (orange cloud)** |

Pokud máš subdoménu (např. `archiv`), použij ji jako `Name`. Pokud chceš root (`drobnepamatky.cz`), použij `@` – CF řeší CNAME flattening na rootu.

**Důležité:** orange cloud (Proxied) je to, co dělá CF cache + brotli + TLS. Bez něj je to jen DNS, nic víc.

### 5. CNAME v repu pro GitHub Pages

GitHub Pages vyžaduje soubor `CNAME` v root deploy adresáře s custom doménou. Přidej do `scripts/deploy.sh` po `cp LICENSE .`:

```bash
echo "archiv.drobnepamatky.cz" > CNAME  # podle skutečné domény
```

Pak v GitHub Pages settings vyplň stejnou doménu do **Custom domain** pole → GitHub si ověří CNAME a aktivuje TLS.

### 6. Cache Rules (klíčové pro bandwidth optimalizaci)

CF Dashboard → **Caching → Cache Rules → Create rule**:

#### Rule 1: data soubory cachuj 30 dní

| Pole | Hodnota |
|---|---|
| **Rule name** | `cache-data-files` |
| **If incoming requests match…** | `URI Path` `contains` `/data/` |
| **Then…** | Cache eligibility = **Eligible for cache** |
| **Edge TTL** | Override origin: **30 days** |
| **Browser TTL** | Override existing: **1 day** |

#### Rule 2: assets cachuj 1 rok

| Pole | Hodnota |
|---|---|
| **Rule name** | `cache-assets` |
| **If incoming requests match…** | `URI Path` `ends with` jeden z: `.js`, `.css`, `.avif`, `.svg`, `.ico` |
| **Edge TTL** | Override origin: **1 year** |
| **Browser TTL** | Override existing: **1 month** |

#### Rule 3: HTML kratší cache (rychlý update po deployi)

| Pole | Hodnota |
|---|---|
| **Rule name** | `cache-html-short` |
| **If incoming requests match…** | `URI Path` `ends with` `.html` nebo `URI Path` `equals` `/` |
| **Edge TTL** | Override origin: **5 minutes** |

> Po deploy stačí na CF dashboard **Caching → Configuration → Purge Everything** pro instant invalidaci. Nebo přes API: `curl -X POST .../purge_cache` (viz API token níže).

### 7. Brotli compression

CF Dashboard → **Speed → Optimization → Content Optimization**:
- **Brotli:** ON (default ON na Free plánu)

Hotovo, nic jiného neřešíš – CF brotlinuje on-the-fly cokoli s `Content-Type: text/*`, `application/json`, `application/javascript`.

### 8. SSL/TLS mode

CF Dashboard → **SSL/TLS → Overview**:
- **Mode:** `Full` (ne „Flexible") – GitHub Pages umí TLS, chceme end-to-end šifrování.

→ Edge Certificates: automatický Let's Encrypt cert pro tvou doménu, zadarmo.

### 9. (Volitelné) Bezpečnostní vrstvy

- **Security → Bots → Bot Fight Mode:** ON (free, filtruje známé bot-y, šetří origin)
- **Security → Settings → Security Level:** Medium (default)
- **Rules → Page Rules** (legacy, ale stále free):
    - `*.drobnepamatky.cz/data/*` → Cache Level: Cache Everything, Edge TTL: 30 days (alternativně k Cache Rules, pokud Free plán nemá Cache Rules)

## Co po setupu zkontroluješ

1. **DNS:** `dig archiv.drobnepamatky.cz +short` musí vrátit CF IP (typicky `172.66.x.x` / `104.21.x.x`), ne `185.199.108.153` (GitHub Pages přímo).
2. **TLS:** otevři `https://archiv.drobnepamatky.cz/` – cert vystavený CF (Issuer: Google Trust Services / Let's Encrypt), platnost ~90 dní auto-renew.
3. **Brotli:** v DevTools → Network → klikni na `pamatky.geojson` → Response headers musí mít `content-encoding: br`. Pokud `gzip`, znamená že curl/browser brotli nepodporuje (curl ano s `--compressed`).
4. **Cache hit:** v DevTools → Network → klikni na `pamatky.geojson` → response header `cf-cache-status: HIT` (po druhém načtení). Při miss bude `MISS`, pak `DYNAMIC`.

## Bandwidth math s CF

| Scénář | Bez CF | S CF (95 % cache hit) |
|---|---|---|
| 1 000 návštěv / den × 4 MB avg | 120 GB / měsíc (přes limit!) | 6 GB / měsíc origin |
| 10 000 návštěv / den × 4 MB avg | 1.2 TB / měsíc (× 12 přes limit) | 60 GB / měsíc origin |
| 100 000 návštěv / den (viral) | nemožné | 600 GB / měsíc origin (stále přes limit, nutno dál řešit) |

→ Pro běžnou návštěvnost stovek–desetitisíc denně je Free CF naprosto dostatečné. Při „virálu" se musí řešit dál (paid CF, jiný hosting).

## API purge (po každém deployi)

Vytvoř API token: CF Dashboard → **My Profile → API Tokens → Create Token → Custom token**:
- Permissions: `Zone → Cache Purge → Purge`
- Zone Resources: tvoje doména

Token přidej do GitHub Secrets jako `CF_PURGE_TOKEN`. V deploy skriptu na konci:

```bash
if [[ -n "${CF_PURGE_TOKEN:-}" && -n "${CF_ZONE_ID:-}" ]]; then
    curl -fsS -X POST \
        "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
        -H "Authorization: Bearer ${CF_PURGE_TOKEN}" \
        -H "Content-Type: application/json" \
        -d '{"purge_everything":true}' \
        | grep -q '"success":true' && echo "✓ CF cache purged"
fi
```

`CF_ZONE_ID` najdeš v CF Dashboard → tvoje doména → **Overview** (pravý sidebar, "API → Zone ID").

## Náklady

| Položka | Cena |
|---|---|
| Cloudflare Free plan | **0 Kč/měsíc** |
| Bandwidth | **neomezený** |
| TLS certifikát | zdarma, auto-renew |
| Brotli | zahrnut |
| Cache Rules (3 rules limit na Free) | zdarma |
| Analytics (základní) | zdarma |
| Doména (např. `.cz`) | 200–300 Kč / rok u registrátora |

Pokud bys jednou potřeboval pokročilejší rate-limiting, image optimization, page rules nad 3, nebo Workers, paid tier začíná na **$5/měsíc**.

## Reference

- [Cloudflare Free plan overview](https://www.cloudflare.com/plans/free/)
- [Setting up GitHub Pages with custom domain (GitHub docs)](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)
- [Cloudflare Cache Rules docs](https://developers.cloudflare.com/cache/how-to/cache-rules/)
- [Cloudflare API: purge cache](https://developers.cloudflare.com/api/operations/zone-purge)
