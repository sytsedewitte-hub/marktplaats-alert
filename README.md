# 🛒 Marktplaats Alert Bot (via Telegram & GitHub Actions)

Ontvang automatisch een Telegram-bericht zodra er een nieuwe advertentie op Marktplaats wordt geplaatst die voldoet aan jouw zoekopdrachten of (sub)categorieën. 

Je beheert je zoekopdrachten eenvoudig vanuit je Telegram-chat: plak een Marktplaats-link, kies met één druk op de knop de maximale afstand, en de bot doet de rest. Alles draait **100% gratis** op GitHub Actions en Cloudflare Workers.

---

## ✨ Functies
* **Ondersteunt alle zoek- en categoriepagina's:** Werkt voor zowel zoektermen (`/q/...`) als specifieke subcategorieën (`/l/.../...`), inclusief filters.
* **Geen reclame-spam:** Commerciële Admarkt-advertenties (`a`-nummers) worden automatisch overgeslagen.
* **Interactieve Telegram-bot:**
  * Plak een Marktplaats-link en kies direct de afstand via knoppen (**30, 50, 75, 100, 125 km** of **Heel NL**).
  * `/lijst` — Bekijk al je actieve zoekopdrachten.
  * `/verwijder [nummer]` — Verwijder een zoekopdracht uit je lijst.
* **Slimme opslag:** Bij een nieuwe zoekopdracht worden de eerste 30 bestaande advertenties stil opgeslagen, zodat je alleen meldingen krijgt van écht nieuwe advertenties.

---

## 🚀 Installatiehandleiding

Volg deze 4 stappen om je eigen versie op te zetten.

### Stap 1: Maak een Telegram Bot en achterhaal je Chat ID
1. Open Telegram en zoek naar **@BotFather**.
2. Stuur `/newbot`, kies een naam en een gebruikersnaam (eindigend op `bot`).
3. Kopieer de **API Token** die je krijgt (bijv. `123456789:ABCdefGHI...`).
4. Zoek in Telegram naar **@userinfobot** en klik op *Start* om je persoonlijke **Chat ID** (een reeks cijfers) op te vragen.

---

### Stap 2: Kopieer deze repository naar je eigen GitHub
1. Klik rechtsboven op **Use this template** (of **Fork**) om een kopie in je eigen GitHub-account te maken.
2. Ga in jouw nieuwe repository naar **Settings** → **Secrets and variables** → **Actions**.
3. Klik op **New repository secret** en voeg deze twee secrets toe:
   * `TELEGRAM_TOKEN`: jouw bot-token uit Stap 1.
   * `TELEGRAM_CHAT_ID`: jouw persoonlijke Chat ID uit Stap 1.
4. Ga naar **Settings** → **Actions** → **General**, scroll helemaal naar beneden naar **Workflow permissions**, kies **Read and write permissions** en klik op **Save**.
5. Maak tot slot een **Personal Access Token** aan zodat je Telegram-bot straks `zoekopdrachten.txt` mag aanpassen:
   * Ga rechtsboven op GitHub naar je profielfoto → **Settings** → **Developer settings** (helemaal onderaan) → **Personal access tokens** → **Tokens (classic)**.
   * Klik op **Generate new token (classic)**, geef hem een naam, vink **`repo`** aan en kopieer het gegenereerde token (`ghp_...`).

---

### Stap 3: Stel de Cloudflare Worker in (voor Telegram-commando's)
Met een gratis Cloudflare Worker kun je links en commando's naar je bot sturen.

1. Maak een gratis account aan op [dash.cloudflare.com](https://dash.cloudflare.com).
2. Ga in het menu links naar **Workers & Pages** → **Create** → **Create Worker**.
3. Geef de worker een naam (bijv. `marktplaats-bot`) en klik op **Deploy**.
4. Klik op **Edit code**, verwijder de voorbeeldcode, plak de code uit `worker.js` erin en klik rechtsboven op **Deploy**.
5. Ga terug naar het overzicht van je Worker → **Settings** → **Variables and Secrets** en voeg de volgende variabelen toe:
   * `TELEGRAM_TOKEN`: je Telegram bot-token.
   * `TELEGRAM_CHAT_ID`: je Telegram Chat ID.
   * `GITHUB_TOKEN`: je GitHub Personal Access Token (`ghp_...`) uit Stap 2.
   * `GITHUB_REPO`: jouw gebruikersnaam en repositorynaam, bijv. `jouwnaam/marktplaats-alert`.
   * `STANDAARD_POSTCODE`: je postcode zonder spaties, bijv. `1234AB` (wordt gebruikt als je een afstand kiest).
6. **Koppel Telegram aan je Worker:** Open onderstaande link in je browser (vervang `<TELEGRAM_TOKEN>` en `<WORKER_URL>` door jouw gegevens):
   ```text
   https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook?url=<WORKER_URL>
   ```
   *(Je ziet `{"ok":true,"result":true,"description":"Webhook was set"}` als het gelukt is.)*

---

### Stap 4: Automatisch laten controleren
Standaard draait de check zodra je een zoekopdracht toevoegt of handmatig via het tabblad **Actions** → **Check Marktplaats** → **Run workflow**.

Wil je dat hij automatisch elke 10 of 15 minuten controleert?
* Voeg onder `on:` in `.github/workflows/check.yml` een `schedule` toe:
  ```yaml
  on:
    workflow_dispatch:
    push:
      paths:
        - 'zoekopdrachten.txt'
    schedule:
      - cron: '*/15 * * * *'
  ```
* *(Tip: GitHub Actions kan op drukke momenten vertraging hebben op `schedule`. Voor stipte checks elke 5 of 10 minuten kun je ook een gratis account op [cron-job.org](https://cron-job.org) gebruiken om de GitHub workflow aan te roepen).*

---

## 📱 Gebruik in Telegram

1. Open Marktplaats in je browser of app en zoek naar een product of open een specifieke subcategorie.
2. Kopieer de link uit de adresbalk (bijv. `https://www.marktplaats.nl/l/spelcomputers-en-games/spelcomputers-sony-playstation-5/`).
3. Plak de link in je Telegram-chat met de bot.
4. Kies via de knoppen onder het bericht de gewenste straal (**30 km** t/m **125 km** of **Heel NL**).
5. Klaar! Zodra er een nieuwe advertentie verschijnt, ontvang je direct een bericht met prijs en directe link.
