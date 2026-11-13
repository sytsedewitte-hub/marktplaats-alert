import json
import os
import re
import time
import requests
from bs4 import BeautifulSoup

TOKEN = os.environ["TELEGRAM_TOKEN"]
CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]
DB_FILE = "geziene_advertenties.json"
URLS_FILE = "zoekopdrachten.txt"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept-Language": "nl-NL,nl;q=0.9",
}

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
        naam, url = "Marktplaats", regel

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

            tekst = f"🆕 *{naam}*\n{titel}\nPrijs: {prijs}\n[Bekijk advertentie]({link})"
            requests.post(
                f"https://api.telegram.org/bot{TOKEN}/sendMessage",
                json={"chat_id": CHAT_ID, "text": tekst, "parse_mode": "Markdown"},
                timeout=10,
            )

    time.sleep(2)

with open(DB_FILE, "w", encoding="utf-8") as f:
    json.dump({"urls": list(bekende_urls), "ids": list(geziene_ids)}, f)
