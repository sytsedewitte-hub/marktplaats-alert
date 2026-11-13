import json
import os
import re
import time
from urllib.parse import unquote, urlparse
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

def stuur_telegram(tekst):
    requests.post(
        f"https://api.telegram.org/bot{TOKEN}/sendMessage",
        json={"chat_id": CHAT_ID, "text": tekst, "parse_mode": "Markdown"},
        timeout=10,
    )

def maak_url_nieuwste_eerst(url):
    basis, _, fragment = url.partition("#")
    delen = [d for d in fragment.split("|") if d and not d.startswith(("sortBy:", "sortOrder:"))]
    delen.extend(["sortBy:SORT_INDEX", "sortOrder:DECREASING"])
    return f"{basis}#{'|'.join(delen)}"

def bedenk_naam(url):
    pad = unquote(urlparse(url).path).strip("/")
    segmenten = [s for s in pad.split("/") if s and s not in ("q", "l")]
    if segmenten:
        naam = re.sub(r"[+-]+", " ", segmenten[-1]).strip().title()
        if naam:
            return naam
    return "Marktplaats Zoekopdracht"

if os.path.exists(DB_FILE):
    with open(DB_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
        geziene_ids = set(data.get("ids", []))
        bekende_urls = set(data.get("urls", []))
        last_update_id = data.get("last_update_id", 0)
else:
    geziene_ids = set()
    bekende_urls = set()
    last_update_id = 0

with open(URLS_FILE, "r", encoding="utf-8") as f:
    regels = [r.strip() for r in f if r.strip() and not r.strip().startswith("#")]

# 1. Verwerk nieuwe berichten uit Telegram
try:
    updates_resp = requests.get(
        f"https://api.telegram.org/bot{TOKEN}/getUpdates",
        params={"offset": last_update_id + 1, "timeout": 5},
        timeout=10,
    ).json()

    for update in updates_resp.get("result", []):
        last_update_id = max(last_update_id, update["update_id"])
        msg = update.get("message", {})
        if str(msg.get("chat", {}).get("id")) != CHAT_ID:
            continue

        tekst = msg.get("text", "").strip()
        if not tekst:
            continue

        if tekst.lower() == "/lijst":
            if regels:
                overzicht = "\n".join(f"{i+1}. {r.split('|')[0].strip()}" for i, r in enumerate(regels))
                stuur_telegram(f"📋 *Actieve zoekopdrachten:*\n{overzicht}\n\nVerwijderen met `/verwijder nummer`")
            else:
                stuur_telegram("Je hebt nog geen actieve zoekopdrachten.")

        elif tekst.lower().startswith("/verwijder"):
            nummers = [int(n) for n in re.findall(r"\d+", tekst)]
            verwijderd = []
            for idx in sorted(set(nummers), reverse=True):
                if 1 <= idx <= len(regels):
                    verwijderd.append(regels.pop(idx - 1).split("|")[0].strip())
            if verwijderd:
                stuur_telegram(f"🗑️ Verwijderd: {', '.join(reversed(verwijderd))}")
            else:
                stuur_telegram("Ongeldig nummer. Gebruik eerst `/lijst` om de nummers te zien.")

        elif "marktplaats.nl" in tekst:
            if "|" in tekst and not tekst.startswith("http"):
                naam, ruwe_url = [d.strip() for d in tekst.split("|", 1)]
            else:
                match_url = re.search(r"https?://\S+", tekst)
                if not match_url:
                    continue
                ruwe_url = match_url.group(0)
                naam = bedenk_naam(ruwe_url)

            schone_url = maak_url_nieuwste_eerst(ruwe_url)
            regels.append(f"{naam} | {schone_url}")
            stuur_telegram(f"✅ Toegevoegd: *{naam}*\n_(Eerste check slaat bestaande advertenties op, daarna krijg je meldingen)_")
except Exception as e:
    print(f"Fout bij ophalen Telegram-berichten: {e}")

with open(URLS_FILE, "w", encoding="utf-8") as f:
    f.write("\n".join(regels) + ("\n" if regels else ""))

# 2. Controleer alle zoekopdrachten op Marktplaats
for regel in regels:
    if "|" in regel:
        naam, url = [deel.strip() for deel in regel.split("|", 1)]
    else:
        naam, url = bedenk_naam(regel), regel

    is_nieuwe_url = url not in bekende_urls
    bekende_urls.add(url)

    try:
        resp = requests.get(url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
    except Exception as e:
        print(f"Fout bij ophalen van {naam}: {e}")
        continue

    soup = BeautifulSoup(resp.text, "html.parser")

    for a_tag in soup.find_all("a", href=re.compile(r"/v/.*/m\d+")):
        match = re.search(r"/(m\d+)-", a_tag.get("href", ""))
        if not match:
            continue
        ad_id = match.group(1)
        if ad_id in geziene_ids:
            continue

        geziene_ids.add(ad_id)

        if not is_nieuwe_url:
            link = f"https://www.marktplaats.nl{a_tag['href'].split('?')[0]}"
            kaart = a_tag.find_parent("li") or a_tag.find_parent("div")
            titel_el = kaart.find(["h3", "h4"]) if kaart else None
            titel = titel_el.get_text(strip=True) if titel_el else "Nieuwe advertentie"
            prijs_el = kaart.find(string=re.compile(r"€|Bieden|Gratis|Zie omschrijving")) if kaart else None
            prijs = prijs_el.strip() if prijs_el else "Onbekend"

            stuur_telegram(f"🆕 *{naam}*\n{titel}\nPrijs: {prijs}\n[Bekijk advertentie]({link})")

    time.sleep(2)

with open(DB_FILE, "w", encoding="utf-8") as f:
    json.dump(
        {"urls": list(bekende_urls), "ids": list(geziene_ids), "last_update_id": last_update_id},
        f,
    )
