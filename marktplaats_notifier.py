import hashlib
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
FOUT_ALERT_COOLDOWN_SEC = 6 * 3600
telegram_bereikbaar = True


def log(bericht):
    print(bericht, flush=True)


def versleutel(tekst, sleutel):
    if not tekst:
        return ""
    nonce = os.urandom(16).hex()
    data = tekst.encode("utf-8")
    out = bytearray(len(data))
    for i in range(0, len(data), 32):
        blok = hashlib.sha256(f"mp-enc:{sleutel}:{nonce}:{i // 32}".encode("utf-8")).digest()
        for j in range(min(32, len(data) - i)):
            out[i + j] = data[i + j] ^ blok[j]
    cipher_hex = bytes(out).hex()
    mac = hashlib.sha256(f"mp-mac:{sleutel}:{nonce}:{cipher_hex}".encode("utf-8")).hexdigest()[:32]
    return f"ENC1:{nonce}:{mac}:{cipher_hex}"


def ontsleutel(inhoud, sleutel):
    delen = inhoud.strip().split(":")
    if len(delen) != 4 or delen[0] != "ENC1":
        return None
    _, nonce, mac, cipher_hex = delen
    verwacht_mac = hashlib.sha256(f"mp-mac:{sleutel}:{nonce}:{cipher_hex}".encode("utf-8")).hexdigest()[:32]
    if mac != verwacht_mac:
        return None
    try:
        cipher = bytes.fromhex(cipher_hex)
        out = bytearray(len(cipher))
        for i in range(0, len(cipher), 32):
            blok = hashlib.sha256(f"mp-enc:{sleutel}:{nonce}:{i // 32}".encode("utf-8")).digest()
            for j in range(min(32, len(cipher) - i)):
                out[i + j] = cipher[i + j] ^ blok[j]
        return bytes(out).decode("utf-8")
    except Exception:
        return None


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
            log(f"⚠️ Telegram melding geweigerd ({resp.status_code}).")
    except Exception:
        log("⚠️ Telegram timeout/verbindingsfout, overige meldingen worden overgeslagen.")
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
        except Exception:
            log("    [Debug] Fout bij uitlezen __NEXT_DATA__.")

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
    except Exception:
        if "postcode" not in api_params and not attributes and not ranges and fallback_listings:
            log("    [Debug] API fout, gebruik fallback_listings.")
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
        seller_info = item.get("sellerInformation") or {}
        resultaten.append({
            "id": ad_id,
            "titel": item.get("title") or "Nieuwe advertentie",
            "prijs": formatteer_prijs(item.get("priceInfo")),
            "datum": str(item.get("date") or "").strip(),
            "link": urljoin("https://www.marktplaats.nl", vip_url.split("?")[0]),
            "seller_id": seller_info.get("sellerId"),
        })
    return resultaten


def is_nieuwe_verkoper(ad_url, seller_id=None, cache=None):
    if cache is not None and seller_id is not None and seller_id in cache:
        return cache[seller_id]

    is_nieuw = False
    try:
        resp = requests.get(ad_url, headers=HEADERS, timeout=5)
        resp.raise_for_status()
        html_tekst = resp.text

        actief_sinds = ""
        m = re.search(r'"activeSinceDiff"\s*:\s*"([^"]+)"', html_tekst)
        if m:
            actief_sinds = m.group(1)
        else:
            m_html = re.search(r">\s*([^<]+?)\s+op Marktplaats\s*<", html_tekst, re.IGNORECASE)
            if m_html:
                actief_sinds = m_html.group(1)

        actief_norm = actief_sinds.strip().lower()
        if re.match(r"^0\s+dag", actief_norm) or actief_norm == "vandaag":
            is_nieuw = True
    except Exception:
        return False

    if cache is not None and seller_id is not None:
        cache[seller_id] = is_nieuw
    return is_nieuw


log("Start Marktplaats controle...")

db = {}
oude_meta = {}
if os.path.exists(DB_FILE):
    try:
        with open(DB_FILE, "r", encoding="utf-8") as f:
            ruwe_data = json.load(f)
            if isinstance(ruwe_data, dict):
                if isinstance(ruwe_data.get("data"), str) and ruwe_data["data"].startswith("ENC1:"):
                    ontsleuteld_json = ontsleutel(ruwe_data["data"], TOKEN)
                    if ontsleuteld_json:
                        parsed_db = json.loads(ontsleuteld_json)
                        db = {k: set(v) for k, v in parsed_db.items() if isinstance(v, list)}
                        if isinstance(parsed_db.get("_meta"), dict):
                            oude_meta = parsed_db["_meta"]
                elif "urls" not in ruwe_data and "data" not in ruwe_data:
                    db = {k: set(v) for k, v in ruwe_data.items() if isinstance(v, list)}
    except Exception:
        log(f"⚠️ Kon {DB_FILE} niet lezen, start met lege database.")

alle_bekende_ids = {i for ids in db.values() for i in ids}
alle_bekende_nummers = [haal_id_nummer(i) for i in alle_bekende_ids]
globaal_hoogste_id = max(alle_bekende_nummers) if alle_bekende_nummers else 0

if not os.path.exists(URLS_FILE):
    with open(URLS_FILE, "w", encoding="utf-8") as f:
        f.write("")

with open(URLS_FILE, "r", encoding="utf-8") as f:
    ruwe_regels = [r.strip() for r in f if r.strip() and not r.strip().startswith("#")]

if len(ruwe_regels) == 1 and ruwe_regels[0].startswith("ENC1:"):
    ontsleutelde_tekst = ontsleutel(ruwe_regels[0], TOKEN)
    if ontsleutelde_tekst is not None:
        regels = [r.strip() for r in ontsleutelde_tekst.split("\n") if r.strip() and not r.strip().startswith("#")]
    else:
        # Andere TELEGRAM_TOKEN (bijv. na een Fork): begin automatisch met een schone lijst
        regels = []
        with open(URLS_FILE, "w", encoding="utf-8") as f:
            f.write("")
else:
    regels = ruwe_regels
    if regels:
        with open(URLS_FILE, "w", encoding="utf-8") as f:
            f.write(versleutel("\n".join(regels), TOKEN) + "\n")

log(f"{len(regels)} zoekopdracht(en) gevonden.")

nieuwe_db = {}
verkoper_cache = {}
aantal_gelukt = 0
aantal_mislukt = 0
blokkade_status = None
laatste_fout = ""

for idx, regel in enumerate(regels, start=1):
    if "|" in regel and not regel.startswith("http"):
        naam, url = [deel.strip() for deel in regel.split("|", 1)]
    else:
        naam, url = bedenk_naam(regel), regel

    is_nieuwe_url = url not in db
    geziene_ids = set(db.get(url, set()))
    bestaande_nummers = [haal_id_nummer(i) for i in geziene_ids]
    hoogste_bekende_id = max(bestaande_nummers) if bestaande_nummers else globaal_hoogste_id

    log(f"Controleren: Zoekopdracht #{idx} (eerste keer: {is_nieuwe_url})")

    try:
        advertenties = haal_advertenties_op(url)
        log(f" -> {len(advertenties)} advertenties opgehaald.")
        aantal_gelukt += 1
    except Exception as e:
        status_code = getattr(getattr(e, "response", None), "status_code", None)
        if status_code in (403, 429):
            blokkade_status = status_code
        laatste_fout = f"HTTP {status_code}" if status_code else type(e).__name__
        aantal_mislukt += 1
        log(f" -> Fout bij ophalen van Zoekopdracht #{idx} ({laatste_fout}).")
        if not is_nieuwe_url:
            nieuwe_db[url] = sorted(geziene_ids, key=haal_id_nummer)[-MAX_OPGESLAGEN_IDS:]
        continue

    nieuwe_ids_aantal = 0
    gepusht_aantal = 0
    gefilterd_aantal = 0

    for ad in advertenties:
        if ad["id"] in geziene_ids:
            continue

        geziene_ids.add(ad["id"])
        nieuwe_ids_aantal += 1
        ad_nummer = haal_id_nummer(ad["id"])

        if is_nieuwe_url:
            alle_bekende_ids.add(ad["id"])
            continue

        if ad["id"] in alle_bekende_ids:
            continue

        alle_bekende_ids.add(ad["id"])

        if ad["datum"].lower() != "vandaag" or ad_nummer <= hoogste_bekende_id:
            continue

        if is_nieuwe_verkoper(ad["link"], ad.get("seller_id"), verkoper_cache):
            gefilterd_aantal += 1
            continue

        gepusht_aantal += 1
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
    if gefilterd_aantal > 0:
        log(f" -> {nieuwe_ids_aantal} nieuwe ID's opgeslagen ({gepusht_aantal} meldingen verstuurd, {gefilterd_aantal} gefilterd op 0-dagen verkoper).")
    else:
        log(f" -> {nieuwe_ids_aantal} nieuwe ID's opgeslagen ({gepusht_aantal} meldingen verstuurd).")
    time.sleep(1)

nu = int(time.time())
nieuw_meta = dict(oude_meta)

if regels and aantal_mislukt > 0 and (blokkade_status is not None or aantal_gelukt == 0):
    fouten_op_rij = int(nieuw_meta.get("fouten_op_rij", 0)) + 1
    nieuw_meta["fouten_op_rij"] = fouten_op_rij
    laatste_alert = int(nieuw_meta.get("laatste_fout_alert", 0))

    if (blokkade_status is not None or fouten_op_rij >= 3) and (nu - laatste_alert >= FOUT_ALERT_COOLDOWN_SEC):
        if blokkade_status is not None:
            reden = f"Marktplaats blokkeert de requests mogelijk (HTTP {blokkade_status})."
        else:
            reden = f"Ophalen mislukt al {fouten_op_rij} keer op rij ({laatste_fout})."
        stuur_telegram(
            f"⚠️ <b>Marktplaats Alert waarschuwing</b>\n"
            f"{html.escape(reden)}\n"
            f"{aantal_mislukt} van de {len(regels)} zoekopdracht(en) mislukt."
        )
        nieuw_meta["laatste_fout_alert"] = nu
elif aantal_gelukt > 0 and blokkade_status is None:
    nieuw_meta.pop("fouten_op_rij", None)
    if nu - int(nieuw_meta.get("laatste_fout_alert", 0)) > 24 * 3600:
        nieuw_meta.pop("laatste_fout_alert", None)

oude_db_genormaliseerd = {
    k: sorted(v, key=haal_id_nummer)[-MAX_OPGESLAGEN_IDS:]
    for k, v in db.items()
}

oude_payload = {**oude_db_genormaliseerd}
if oude_meta:
    oude_payload["_meta"] = oude_meta

nieuwe_payload = {**nieuwe_db}
if nieuw_meta:
    nieuwe_payload["_meta"] = nieuw_meta

if nieuwe_payload != oude_payload or not os.path.exists(DB_FILE):
    versleutelde_db = {"data": versleutel(json.dumps(nieuwe_payload), TOKEN)} if nieuwe_payload else {}
    with open(DB_FILE, "w", encoding="utf-8") as f:
        json.dump(versleutelde_db, f, indent=2)
    log("Klaar! Database versleuteld opgeslagen.")
else:
    log("Klaar! Geen wijzigingen in database.")
