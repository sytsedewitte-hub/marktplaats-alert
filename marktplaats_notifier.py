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
    pad = unquote(urlparse(url).path).strip("/")
    segmenten = [s for s in pad.split("/") if s and s not in ("q", "l")]
    if segmenten:
        naam = re.sub(r"[+-]+", " ", segmenten[-1]).strip().title()
        if naam:
            return naam
    return "Marktplaats Zoekopdracht"


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

    if ptype not in ("FIXED", "MIN_BID") and ptype in vaste_labels:
        return vaste_labels[ptype]

    if cents is not None and cents > 0:
        return f"€ {cents / 100:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

    return vaste_labels.get(ptype, "Onbekend")


def haal_advertenties_op(url):
    parsed = urlparse(url)
    basis_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"

    api_params = {
        "limit": 30,
        "offset": 0,
        "sortBy": "SORT_INDEX",
        "sortOrder": "DECREASING",
        "viewOptions": "list-view",
    }
    attributes = []
    l2_id = None

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
            if l2_raw:
                l2_id = int(str(l2_raw).split(",")[0])
            elif l2_list and isinstance(l2_list[0], dict) and l2_list[0].get("id"):
                l2_id = int(l2_list[0]["id"])

            if l2_id:
                api_params["l2CategoryId"] = l2_id
                api_params["l2CategoryIds"] = str(l2_id)

            if search_req.get("query"):
                api_params["query"] = search_req["query"]

            for attr in search_req.get("attributesByKey", []):
                if isinstance(attr, str):
                    attributes.append(attr)
                elif isinstance(attr, dict) and attr.get("attributeKey") and attr.get("attributeValueKey"):
                    attributes.append(f"{attr['attributeKey']}:{attr['attributeValueKey']}")

            fallback_listings = srar.get("listings", [])
        except Exception as e:
            log(f"    [Debug] Fout bij uitlezen __NEXT_DATA__: {e}")

    if "query" not in api_params and "/q/" in parsed.path:
        q_deel = parsed.path.split("/q/", 1)[1].strip("/").split("/")[0]
        api_params["query"] = unquote(q_deel).replace("+", " ").replace("-", " ")

    for deel in parsed.fragment.split("|"):
        if ":" not in deel:
            continue
        k, v = deel.split(":", 1)
        if k in ("sortBy", "sortOrder", "limit", "offset"):
            continue
        elif k == "q":
            api_params["query"] = unquote(v).replace("+", " ")
        elif k in ("postcode", "distanceMeters"):
            api_params[k] = v
        else:
            attributes.append(f"{k}:{v}")

    # Als er geen afstand in de URL staat (Heel NL), laat postcode dan ook weg
    if "distanceMeters" not in api_params:
        api_params.pop("postcode", None)

    if attributes:
        api_params["attributesByKey[]"] = list(dict.fromkeys(attributes))

    api_headers = {**HEADERS, "Accept": "application/json", "Referer": basis_url}
    api_resp = requests.get(
        "https://www.marktplaats.nl/lrp/api/search",
        params=api_params,
        headers=api_headers,
        timeout=10,
    )
    api_resp.raise_for_status()

    api_listings = api_resp.json().get("listings", []) if api_resp.text.strip() else []
    listings = api_listings if api_listings else fallback_listings

    resultaten = []
    for item in listings:
        ad_id = str(item.get("itemId") or "")
        vip_url = item.get("vipUrl")
        # Sla commerciële Admarkt-advertenties ('a...') over
        if not ad_id or not vip_url or ad_id.startswith("a"):
            continue
        # Harde check: negeer advertenties uit andere subcategorieën als l2_id bekend is
        if l2_id and item.get("categoryId") and int(item["categoryId"]) != l2_id:
            continue

        resultaten.append({
            "id": ad_id,
            "titel": item.get("title") or "Nieuwe advertentie",
            "prijs": formatteer_prijs(item.get("priceInfo")),
            "link": urljoin("https://www.marktplaats.nl", vip_url.split("?")[0]),
        })
    return resultaten


log("Start Marktplaats controle...")

db = {}
if os.path.exists(DB_FILE):
    with open(DB_FILE, "r", encoding="utf-8") as f:
        try:
            ruwe_data = json.load(f)
            if isinstance(ruwe_data, dict) and "urls" not in ruwe_data:
                db = {k: set(v) for k, v in ruwe_data.items() if isinstance(v, list)}
        except Exception:
            db = {}

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
    geziene_ids = db.get(url, set())
    log(f"Controleren: {naam} (eerste keer: {is_nieuwe_url})")

    try:
        advertenties = haal_advertenties_op(url)
        log(f" -> {len(advertenties)} advertenties opgehaald.")
    except Exception as e:
        log(f" -> Fout bij ophalen van {naam}: {e}")
        nieuwe_db[url] = sorted(geziene_ids)
        continue

    nieuwe_aantal = 0
    for ad in advertenties:
        if ad["id"] in geziene_ids:
            continue

        geziene_ids.add(ad["id"])
        nieuwe_aantal += 1

        if not is_nieuwe_url:
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

    nieuwe_db[url] = sorted(geziene_ids)
    log(f" -> {nieuwe_aantal} nieuwe ID's verwerkt.")
    time.sleep(1)

with open(DB_FILE, "w", encoding="utf-8") as f:
    json.dump(nieuwe_db, f, indent=2)

log("Klaar! Database opgeslagen.")
