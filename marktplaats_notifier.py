import html
import json
import os
import re
import time
from urllib.parse import unquote, urljoin, urlparse
import requests
from bs4 import BeautifulSoup

TOKEN = os.environ["TELEGRAM_TOKEN"]
CHAT_ID = str(os.environ["TELEGRAM_CHAT_ID"])

DB_FILE = "geziene_advertenties.json"
URLS_FILE = "zoekopdrachten.txt"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "nl-NL,nl;q=0.9",
}

MAX_OPGESLAGEN_IDS = 250
telegram_bereikbaar = True


def log(bericht):
    print(bericht, flush=True)


def stuur_telegram(tekst, parse_mode="HTML"):
    global telegram_bereikbaar
    if not telegram_bereikbaar:
        return

    payload = {"chat_id": CHAT_ID, "text": tekst, "disable_web_page_preview": False}
    if parse_mode:
        payload["parse_mode"] = parse_mode

    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{TOKEN}/sendMessage",
            json=payload,
            timeout=5,
        )
        if resp.status_code >= 500:
            log(f"⚠️ Telegram serverfout ({resp.status_code}), overige meldingen worden overgeslagen.")
            telegram_bereikbaar = False
        elif resp.status_code == 400 and parse_mode:
            stuur_telegram(re.sub(r"<[^>]+>", "", tekst), parse_mode=None)
        elif not resp.ok:
            log(f"⚠️ Telegram melding geweigerd ({resp.status_code}): {resp.text}")
    except Exception as e:
        log(f"⚠️ Telegram timeout/verbindingsfout ({e}), overige meldingen worden overgeslagen.")
        telegram_bereikbaar = False


def bedenk_naam(url):
    parsed = urlparse(url)
    pad = unquote(parsed.path).strip("/")
    segmenten = [s for s in pad.split("/") if s and s not in ("q", "l")]
    titel = re.sub(r"[+-]+", " ", segmenten[-1]).strip().title() if segmenten else ""

    zoekwoord = ""
    for deel in parsed.fragment.replace("#", "|").split("|"):
        if deel.startswith("q:"):
            zoekwoord = re.sub(r"[+-]+", " ", unquote(deel[2:])).strip().title()
            break

    if zoekwoord and titel and zoekwoord.lower() != titel.lower():
        return f"{zoekwoord} ({titel})"
    return zoekwoord or titel or "Marktplaats Zoekopdracht"


def haal_id_nummer(ad_id):
    cijfers = re.sub(r"\D", "", str(ad_id))
    return int(cijfers) if cijfers else 0


def formatteer_prijs(price_info):
    if not price_info:
        return "Onbekend"

    ptype = (price_info.get("priceType") or "").upper()
    cents = price_info.get("priceCents")

    vaste_labels = {
        "BID": "Bieden",
        "EXCHANGE": "Ruilen",
        "FAST_BID": "Bieden",
        "FREE": "Gratis",
        "FREE_BID": "Bieden",
        "MIN_BID": "Bieden",
        "NOTK": "N.o.t.k.",
        "NVT": "N.v.t.",
        "ON_REQUEST": "Op aanvraag",
        "RESERVED": "Gereserveerd",
        "SEE_DESCRIPTION": "Zie omschrijving",
    }

    if ptype not in ("FIXED", "MIN_BID", "FAST_BID", "FREE_BID", "BID") and ptype in vaste_labels:
        return vaste_labels[ptype]

    if cents is not None and cents > 0:
        return f"€ {cents / 100:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

    return vaste_labels.get(ptype, "Onbekend")


def haal_advertenties_op(url):
    parsed = urlparse(url)
    basis_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"

    api_params = {
        "limit": 100,
        "offset": 0,
        "sortBy": "SORT_INDEX",
        "sortOrder": "DECREASING",
        "viewOptions": "list-view",
    }
    attributes = []
    ranges = {}

    resp = requests.get(basis_url, headers=HEADERS, timeout=10)
    resp.raise_for_status()
    html_tekst = resp.text

    soup = BeautifulSoup(html_tekst, "html.parser")
    next_data_tag = soup.find("script", id="__NEXT_DATA__")
    fallback_listings = []

    if next_data_tag and next_data_tag.string:
        try:
            next_data = json.loads(next_data_tag.string)
            query_obj = next_data.get("query", {})
            page_props = next_data.get("props", {}).get("pageProps", {})
            srar = page_props.get("searchRequestAndResponse", {})
            search_req = srar.get("searchRequest", {})
            cats = search_req.get("categories", {})

            l1_id = (
                query_obj.get("l1CategoryId")
                or (cats.get("l1Category") or {}).get("id")
            )
            if l1_id:
                api_params["l1CategoryId"] = int(str(l1_id).split(",")[0])

            l2_raw = query_obj.get("l2CategoryIds")
            l2_list = cats.get("l2Categories") or []
            l2_id = None
            if l2_raw:
                l2_id = int(str(l2_raw).split(",")[0])
            elif l2_list and isinstance(l2_list[0], dict) and l2_list[0].get("id"):
                l2_id = int(l2_list[0]["id"])

            if l2_id:
                api_params["l2CategoryIds[]"] = [l2_id]

            if search_req.get("query"):
                api_params["query"] = search_req["query"]
            if search_req.get("searchInTitleAndDescription"):
                api_params["searchInTitleAndDescription"] = "true"

            dist_obj = search_req.get("distance") or {}
            if dist_obj.get("postcode"):
                api_params["postcode"] = dist_obj["postcode"]
            if dist_obj.get("distanceMeters") is not None:
                api_params["distanceMeters"] = dist_obj["distanceMeters"]

            for attr in search_req.get("attributesByKey", []):
                if isinstance(attr, str):
                    attributes.append(attr)
                elif isinstance(attr, dict):
                    k = attr.get("attributeKey") or attr.get("key")
                    v = attr.get("attributeValue") or attr.get("value")
                    if k and v:
                        attributes.append(f"{k}:{v}")

            for r in search_req.get("attributeRanges", []):
                if isinstance(r, str) and r.count(":") == 2:
                    rk, r_from, r_to = r.split(":")
                    if rk:
                        ranges[rk] = {"from": r_from, "to": r_to}
                elif isinstance(r, dict):
                    rk = r.get("attributeKey") or r.get("key")
                    if rk:
                        ranges[rk] = {
                            "from": r.get("from") if r.get("from") is not None else "null",
                            "to": r.get("to") if r.get("to") is not None else "null",
                        }

            fallback_listings = srar.get("listings", [])
        except Exception as e:
            log(f"    [Debug] Fout bij uitlezen __NEXT_DATA__: {e}")

    if "query" not in api_params and "/q/" in parsed.path:
        q_deel = parsed.path.split("/q/", 1)[1].strip("/").split("/")[0]
        api_params["query"] = unquote(q_deel).replace("+", " ")

    genegeerde_params = {
        "sortBy",
        "sortOrder",
        "limit",
        "offset",
        "asSavedSearch",
        "fromSavedSearch",
        "viewOptions",
        "origin",
    }

    fragment_tekst = parsed.fragment.replace("#", "|")
    for deel in fragment_tekst.split("|"):
        if ":" not in deel:
            continue
        k, v = [x.strip() for x in deel.split(":", 1)]
        if not k or not v or k in genegeerde_params:
            continue
        elif k == "q":
            api_params["query"] = unquote(v).replace("+", " ")
        elif k == "searchInTitleAndDescription":
            api_params["searchInTitleAndDescription"] = v.lower()
        elif k == "postcode":
            api_params["postcode"] = unquote(v).replace(" ", "").upper()
        elif k == "distanceMeters":
            api_params["distanceMeters"] = v
        elif k == "l1CategoryId" and v.split(",")[0].isdigit():
            api_params["l1CategoryId"] = int(v.split(",")[0])
        elif k == "l2CategoryIds":
            l2_ids = [int(x) for x in v.split(",") if x.strip().isdigit()]
            if l2_ids:
                api_params["l2CategoryIds[]"] = l2_ids
        elif k.endswith("From") and len(k) > 4:
            ranges.setdefault(k[:-4], {})["from"] = v
        elif k.endswith("To") and len(k) > 2:
            ranges.setdefault(k[:-2], {})["to"] = v
        else:
            attributes.append(f"{k}:{v}")

    if "postcode" in api_params and "distanceMeters" not in api_params:
        api_params["distanceMeters"] = 100000

    if attributes:
        api_params["attributesByKey[]"] = list(dict.fromkeys(attributes))

    if ranges:
        api_params["attributeRanges[]"] = [
            f"{rk}:{vals.get('from') or 'null'}:{vals.get('to') or 'null'}"
            for rk, vals in ranges.items()
        ]

    api_headers = {**HEADERS, "Accept": "application/json", "Referer": basis_url}
    try:
        api_resp = requests.get(
            "https://www.marktplaats.nl/lrp/api/search",
            params=api_params,
            headers=api_headers,
            timeout=10,
        )
        api_resp.raise_for_status()
        listings = api_resp.json().get("listings", []) if api_resp.text.strip() else []
    except Exception as e:
        if "postcode" not in api_params and not attributes and not ranges and fallback_listings:
            log(f"    [Debug] API fout ({e}), gebruik fallback_listings.")
            listings = fallback_listings
        else:
            raise

    resultaten = []
    for item in listings:
        ad_id = str(item.get("itemId") or "")
        vip_url = item.get("vipUrl")
        # Sla commerciële Admarkt-advertenties (beginnen met 'a') over
        if not ad_id or not vip_url or ad_id.startswith("a"):
            continue
        resultaten.append({
            "id": ad_id,
            "titel": item.get("title") or "Nieuwe advertentie",
            "prijs": formatteer_prijs(item.get("priceInfo")),
            "datum": str(item.get("date") or "").strip(),
            "link": urljoin("https://www.marktplaats.nl", vip_url.split("?")[0]),
        })
    return resultaten


log("Start Marktplaats controle...")

db = {}
if os.path.exists(DB_FILE):
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            ruwe_data = json.load(f)
            if isinstance(ruwe_data, dict) and "urls" not in ruwe_data:
                db = {k: set(v) for k, v in ruwe_data.items() if isinstance(v, list)}
    except Exception as e:
        log(f"⚠️ Kon {DB_FILE} niet lezen ({e}), start met lege database.")

alle_bekende_nummers = [haal_id_nummer(i) for ids in db.values() for i in ids]
globaal_hoogste_id = max(alle_bekende_nummers) if alle_bekende_nummers else 0

if not os.path.exists(URLS_FILE):
    with open(URLS_FILE, "w", encoding="utf-8") as f:
        f.write("")

with open(URLS_FILE, "r", encoding="utf-8") as f:
    regels = [r.strip() for r in f if r.strip() and not r.strip().startswith("#")]

log(f"{len(regels)} zoekopdracht(en) gevonden.")

nieuwe_db = {}

for regel in regels:
    if "|" in regel and not regel.startswith("http"):
        naam, url = [deel.strip() for deel in regel.split("|", 1)]
    else:
        naam, url = bedenk_naam(regel), regel

    is_nieuwe_url = url not in db
    geziene_ids = set(db.get(url, set()))
    bestaande_nummers = [haal_id_nummer(i) for i in geziene_ids]
    hoogste_bekende_id = max(bestaande_nummers) if bestaande_nummers else globaal_hoogste_id

    log(f"Controleren: {naam} (eerste keer: {is_nieuwe_url})")

    try:
        advertenties = haal_advertenties_op(url)
        log(f" -> {len(advertenties)} advertenties opgehaald.")
    except Exception as e:
        log(f" -> Fout bij ophalen van {naam}: {e}")
        if not is_nieuwe_url:
            nieuwe_db[url] = sorted(geziene_ids, key=haal_id_nummer)[-MAX_OPGESLAGEN_IDS:]
        continue

    nieuwe_ids_aantal = 0
    gepusht_aantal = 0

    for ad in advertenties:
        if ad["id"] in geziene_ids:
            continue

        geziene_ids.add(ad["id"])
        nieuwe_ids_aantal += 1
        ad_nummer = haal_id_nummer(ad["id"])

        if is_nieuwe_url:
            continue

        if ad["datum"].lower() != "vandaag":
            log(f"    [Overgeslagen] {ad['id']} ({ad['titel'][:35]}...) -> datum is '{ad['datum']}' (niet Vandaag)")
        elif ad_nummer <= hoogste_bekende_id:
            log(f"    [Overgeslagen] {ad['id']} ({ad['titel'][:35]}...) -> ouder ID ({ad_nummer} <= {hoogste_bekende_id})")
        else:
            gepusht_aantal += 1
            log(f"    [Gepusht] {ad['id']} ({ad['titel'][:35]}...) -> nieuw!")
            veilige_naam = html.escape(naam)
            veilige_titel = html.escape(ad["titel"])
            veilige_prijs = html.escape(ad["prijs"])
            telegram_bericht = (
                f"🆕 <b>{veilige_naam}</b>\n"
                f"{veilige_titel}\n"
                f"Prijs: {veilige_prijs}\n"
                f"<a href=\"{ad['link']}\">Bekijk advertentie</a>"
            )
            stuur_telegram(telegram_bericht)

    nieuwe_db[url] = sorted(geziene_ids, key=haal_id_nummer)[-MAX_OPGESLAGEN_IDS:]
    log(f" -> {nieuwe_ids_aantal} nieuwe ID's opgeslagen ({gepusht_aantal} meldingen verstuurd).")
    time.sleep(1)

with open(DB_FILE, "w", encoding="utf-8") as f:
    json.dump(nieuwe_db, f, indent=2)

log("Klaar! Database opgeslagen.")
