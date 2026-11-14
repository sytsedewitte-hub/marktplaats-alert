# 🛒 Marktplaats Alert Bot

Ontvang automatisch een Telegram-bericht bij nieuwe Marktplaats-advertenties en beheer al je zoekopdrachten vanuit de chat. Draait **100% gratis** op GitHub Actions en Cloudflare Workers.

---

## ✨ Functies
* **Zoektermen & subcategorieën:** Werkt met elke Marktplaats-link (`/q/...` en `/l/...`), inclusief filters.
* **Slimme filtering:** Negeert reclames (Admarkt), dubbele meldingen en oude advertenties die omhoog zijn geplaatst.
* **Snel beheer via Telegram:** Plak een link en kies de straal (**30 t/m 125 km** of **Heel NL**), bekijk je lijst met `/lijst` of verwijder via `/verwijder [nummer]`.
* **Geen opstart-spam:** Bij een nieuwe zoekopdracht worden bestaande advertenties (tot 100) stil opgeslagen.

---

## 🚀 Installatie

### Stap 1: Telegram Bot aanmaken
1. Open **@BotFather** in Telegram, stuur `/newbot` en kopieer je **`TELEGRAM_TOKEN`**.
2. Open **@userinfobot**, klik op *Start* en kopieer je **`TELEGRAM_CHAT_ID`**.

### Stap 2: GitHub instellen
1. Klik rechtsboven op **Fork** om een eigen kopie te maken.
2. Ga naar **Settings → Actions → General**, zet *Workflow permissions* op **Read and write permissions** en klik op **Save**.
3. Ga naar het tabblad **Actions**, zet de workflows aan, klik links op **Reset lijsten (eenmalig na Fork)** en kies **Run workflow**.
4. Ga naar **Settings → Secrets and variables → Actions** en voeg `TELEGRAM_TOKEN` en `TELEGRAM_CHAT_ID` toe.
5. Maak een **Personal Access Token (classic)** aan via *GitHub Profiel → Settings → Developer settings → Personal access tokens*, vink **`repo`** aan en kopieer het token.

### Stap 3: Telegram-bot uitrollen via Cloudflare
Klik op onderstaande knop en vul je gegevens in (`TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `GITHUB_TOKEN`, `GITHUB_REPO` als `jouwnaam/marktplaats-alert` en `STANDAARD_POSTCODE` als `1234AB`):

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sytsedewitte-hub/marktplaats-alert/tree/main/worker)

### Stap 4: Koppelen & Automatiseren
1. Open de Worker-URL die Cloudflare na installatie geeft en plak **`/setup`** achter het adres (bijv. `https://marktplaats-telegram-bot.jouwnaam.workers.dev/setup`).
2. Wil je automatische checks? Zet in `.github/workflows/check.yml` onder `on:` een schema aan (bijv. `cron: '*/15 * * * *'`), of trigger de workflow via [cron-job.org](https://cron-job.org).

---

## 📱 Gebruik

1. Kopieer een zoek- of categorielink op Marktplaats.
2. Plak de link in je Telegram-chat met de bot en tik op de gewenste afstand.
3. Klaar! Nieuwe advertenties komen direct binnen met prijs en directe link.

*Updates binnenhalen? Klik in je eigen repository op **Sync fork**.*
