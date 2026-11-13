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


def stuur_telegram(tekst, parse_mode="HTML"):
    payload = {"chat_id": CHAT_ID, "text": tekst, "disable_web_page_preview": False}
    if parse_mode:
        payload["parse_mode"] = parse_mode
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{TOKEN}/sendMessage",
            json=payload,
            timeout=30,
        )
        if not resp.ok and parse_mode:
            stuur_telegram(re.sub(r"<[^>]+>", "", tekst), parse_mode=None)
    except Exception as e:
        print(f"Fout bij versturen Telegram-bericht: {e}")


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
    ptype = price_info.get("priceType", "")
    cents = price_info.get("priceCents")
    if ptype == "FREE":
        return "Gratis"
    if ptype == "SEE_DESCRIPTION":
        return "Zie omschrijving"
    if ptype == "BID":
        return "Bieden"
    if cents is not None:
        bedrag = f"€ {cents / 100:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
        return f"Bieden vanaf {bedrag}" if ptype == "MIN_BID" else bedrag
    return "Onbekend"


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

    # 1. Haal categorie- en zoekparameters uit __NEXT_DATA__ van de pagina
    resp = requests.get(basis_url, headers=HEADERS, timeout=15)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    next_data_tag = soup.find("script", id="__NEXT_DATA__")
    if next_data_tag and next_data_tag.string:
        try:
            next_data = json.loads(next_data_tag.string)
            search_req = (
                next_data.get("props", {})
                .get("pageProps", {})
                .get("searchRequest", {})
            )
            for veld in ("query", "l1CategoryId", "l2CategoryId", "postcode", "distanceMeters"):
                if search_req.get(veld) is not None:
                    api_params[veld] = search_req[veld]
            for attr in search_req.get("attributesByKey", []):
                attributes.append(attr)
        except Exception:
            pass

    # Fallback voor /q/zoekterm/ als __NEXT_DATA__ geen query bevat
    if "query" not in api_params and "/q/" in parsed.path:
        q_deel = parsed.path.split("/q/", 1)[1].strip("/").split("/")[0]
        api_params["query"] = unquote(q_deel).replace("+", " ").replace("-", " ")

    # 2. Verwerk eventuele filters uit het #-fragment (prijs, postcode, afstand, etc.)
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

    if attributes:
        api_params["attributesByKey[]"] = list(dict.fromkeys(attributes))

    # 3. Vraag gesorteerde JSON-resultaten op via de Marktplaats zoek-API
    api_headers = {**HEADERS, "Accept": "application/json", "Referer": basis_url}
    api_resp = requests.get(
        "https://www.marktplaats.nl/lrp/api/search",
        params=api_params,
        headers=api_headers,
        timeout=15,
    )
    api_resp.raise_for_status()
    listings = api_resp.json().get("listings", [])

    resultaten = []
    for item in listings:
        ad_id = item.get("itemId")
        vip_url = item.get("vipUrl")
        if not ad_id or not vip_url:
            continue
        resultaten.append({
            "id": str(ad_id),
            "titel": item.get("title") or "Nieuwe advertentie",
            "prijs": formatteer_prijs(item.get("priceInfo")),
            "link": urljoin("https://www.marktplaats.nl", vip_url.split("?")[0]),
        })
    return resultaten


if os.path.exists(DB_FILE):
    with open(DB_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
        geziene_ids = set(data.get("ids", []))
        bekende_urls = set(data.get("urls", []))
else:
    geziene_ids = set()
    bekende_urls = set()

with open(URLS_FILE, "r", encoding="utf-8") as f:
    regels = [r.strip() for r in f if r.strip() and not r.strip().startswith("#")]

for regel in regels:
    if "|" in regel:
        naam, url = [deel.strip() for deel in regel.split("|", 1)]
    else:
        naam, url = bedenk_naam(regel), regel

    is_nieuwe_url = url not in bekende_urls
    bekende_urls.add(url)

    try:
        advertenties = haal_advertenties_op(url)
    except Exception as e:
        print(f"Fout bij ophalen van {naam}: {e}")
        continue

    for ad in advertenties:
        if ad["id"] in geziene_ids:
            continue

        geziene_ids.add(ad["id"])

        if not is_nieuwe_url:
            veilige_naam = html.escape(naam)
            veilige_titel = html.escape(ad["titel"])
            veilige_prijs = html.escape(ad["prijs"])
            stuur_telegram(
                f"🆕 <b>{veilige_naam}</b>\n"
                f"{veilige_titel}\n"
                f"Prijs: {veilige_prijs}\n"
                f"<a href=\"{ad['link']}\">Bekijk advertentie</a>"
            )

    time.sleep(2)

with open(DB_FILE, "w", encoding="utf-8") as f:
    json.dump({"urls": list(bekende_urls), "ids": list(geziene_ids)}, f)
