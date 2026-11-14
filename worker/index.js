export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Automatische webhook-koppeling via https://<jouw-worker>.workers.dev/setup
    if (request.method === "GET" && url.pathname === "/setup") {
      const webhookUrl = `${url.origin}/`;
      const resp = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}`
      );
      const data = await resp.json();
      return new Response(
        data.ok
          ? `✅ Telegram webhook succesvol gekoppeld aan ${webhookUrl}`
          : `❌ Fout bij koppelen: ${JSON.stringify(data)}`,
        { status: data.ok ? 200 : 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    const update = await request.json();

    // 1. Klik op afstandsknop afhandelen (Inline Keyboard)
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = String(cq.message.chat.id);
      if (chatId !== String(env.TELEGRAM_CHAT_ID)) {
        return new Response("Unauthorized", { status: 403 });
      }

      const kmMatch = (cq.data || "").match(/^km:(\d+)$/);
      const urlMatch = (cq.message.text || "").match(/https?:\/\/(?:www\.)?marktplaats\.nl\/(?:l|q)\/\S+/i);

      if (kmMatch && urlMatch) {
        const km = parseInt(kmMatch[1], 10);
        const definitieveUrl = pasAfstandToe(urlMatch[0], km, env.STANDAARD_POSTCODE);
        const resultaat = await voegZoekopdrachtToe(env, definitieveUrl);

        await beantwoordCallback(env.TELEGRAM_TOKEN, cq.id);
        await bewerkBericht(env.TELEGRAM_TOKEN, chatId, cq.message.message_id, resultaat);
      }
      return new Response("OK", { status: 200 });
    }

    const msg = update.message;
    if (!msg || !msg.text || msg.from?.is_bot) {
      return new Response("OK", { status: 200 });
    }

    const chatId = String(msg.chat.id);
    if (chatId !== String(env.TELEGRAM_CHAT_ID)) {
      return new Response("Unauthorized", { status: 403 });
    }

    const tekst = msg.text.trim();

    // 2. Commando: /lijst
    if (tekst === "/lijst") {
      const { regels } = await haalBestandOp(env);
      if (regels.length === 0) {
        await stuurBericht(env.TELEGRAM_TOKEN, chatId, "Je lijst met zoekopdrachten is nog leeg.");
      } else {
        const overzicht = regels
          .map((r, i) => `${i + 1}. ${maakLeesbareNaam(r)}`)
          .join("\n");
        await stuurBericht(env.TELEGRAM_TOKEN, chatId, `📋 <b>Actieve zoekopdrachten:</b>\n\n${overzicht}\n\nVerwijderen met: <code>/verwijder nummer</code>`);
      }
      return new Response("OK", { status: 200 });
    }

    // 3. Commando: /verwijder <nummer>
    if (tekst.startsWith("/verwijder")) {
      const nr = parseInt(tekst.replace("/verwijder", "").trim(), 10);
      const { regels, sha } = await haalBestandOp(env);

      if (!nr || nr < 1 || nr > regels.length) {
        await stuurBericht(env.TELEGRAM_TOKEN, chatId, "Geef een geldig nummer op uit <code>/lijst</code> (bijv. <code>/verwijder 1</code>).");
        return new Response("OK", { status: 200 });
      }

      const verwijderd = regels.splice(nr - 1, 1)[0];
      await slaBestandOp(env, regels, sha, "Verwijder zoekopdracht via Telegram");
      await stuurBericht(env.TELEGRAM_TOKEN, chatId, `🗑️ Verwijderd:\n${maakLeesbareNaam(verwijderd)}`);
      return new Response("OK", { status: 200 });
    }

    // 4. Nieuwe Marktplaats zoek- of categorielink ontvangen (alleen /l/ of /q/)
    const mpMatch = tekst.match(/(https?:\/\/(?:www\.)?marktplaats\.nl\/(?:l|q)\/\S+)(?:\s+(\d+))?/i);
    if (mpMatch) {
      const ruweUrl = mpMatch[1];
      const directKm = mpMatch[2];

      if (directKm !== undefined) {
        const definitieveUrl = pasAfstandToe(ruweUrl, parseInt(directKm, 10), env.STANDAARD_POSTCODE);
        const resultaat = await voegZoekopdrachtToe(env, definitieveUrl);
        await stuurBericht(env.TELEGRAM_TOKEN, chatId, resultaat);
      } else {
        await stuurBericht(
          env.TELEGRAM_TOKEN,
          chatId,
          `Kies de maximale afstand voor:\n${ruweUrl}`,
          {
            inline_keyboard: [
              [
                { text: "30 km", callback_data: "km:30" },
                { text: "50 km", callback_data: "km:50" },
                { text: "75 km", callback_data: "km:75" },
              ],
              [
                { text: "100 km", callback_data: "km:100" },
                { text: "125 km", callback_data: "km:125" },
                { text: "Heel NL", callback_data: "km:0" },
              ],
            ],
          }
        );
      }
      return new Response("OK", { status: 200 });
    }

    await stuurBericht(
      env.TELEGRAM_TOKEN,
      chatId,
      "Stuur een Marktplaats zoek- of categorielink om toe te voegen, of gebruik <code>/lijst</code> en <code>/verwijder [nummer]</code>."
    );
    return new Response("OK", { status: 200 });
  },
};

function pasAfstandToe(rawUrl, km, standaardPostcode) {
  const urlObj = new URL(rawUrl);
  const fragment = urlObj.hash.replace(/^#/, "");
  const paren = fragment ? fragment.split("|").filter(Boolean) : [];
  const filters = new Map();

  for (const p of paren) {
    const idx = p.indexOf(":");
    if (idx > -1) {
      filters.set(p.slice(0, idx), p.slice(idx + 1));
    }
  }

  if (km > 0) {
    filters.set("distanceMeters", String(km * 1000));
    if (!filters.has("postcode") && standaardPostcode) {
      filters.set("postcode", standaardPostcode.trim().replace(/\s+/g, ""));
    }
  } else {
    filters.delete("distanceMeters");
    filters.delete("postcode");
  }

  urlObj.hash = filters.size > 0
    ? Array.from(filters.entries()).map(([k, v]) => `${k}:${v}`).join("|")
    : "";

  return urlObj.toString();
}

function maakLeesbareNaam(regel) {
  const urlDeel = regel.includes("|") && !regel.startsWith("http")
    ? regel.split("|", 2)[1].trim()
    : regel.trim();

  try {
    const u = new URL(urlDeel);
    const segmenten = u.pathname.split("/").filter((s) => s && s !== "q" && s !== "l");
    let titel = segmenten.length
      ? decodeURIComponent(segmenten[segmenten.length - 1]).replace(/[+-]+/g, " ")
      : urlDeel;

    const hashQ = u.hash.match(/(?:^|#|\|)q:([^|]+)/);
    if (hashQ) {
      const zoekwoord = decodeURIComponent(hashQ[1]).replace(/[+-]+/g, " ");
      titel = `${zoekwoord} (${titel})`;
    }

    const kmMatch = u.hash.match(/distanceMeters:(\d+)/);
    const afstand = kmMatch ? ` (${Math.round(parseInt(kmMatch[1], 10) / 1000)} km)` : " (heel NL)";
    return `${titel}${afstand}`.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  } catch {
    return urlDeel;
  }
}

async function voegZoekopdrachtToe(env, url) {
  const { regels, sha } = await haalBestandOp(env);
  if (regels.includes(url)) {
    return "ℹ️ Deze zoekopdracht staat al in je lijst.";
  }
  regels.push(url);
  await slaBestandOp(env, regels, sha, "Nieuwe zoekopdracht via Telegram");
  return `✅ Toegevoegd:\n<b>${maakLeesbareNaam(url)}</b>`;
}

async function haalBestandOp(env) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/zoekopdrachten.txt`;
  const resp = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "Cloudflare-Worker",
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (!resp.ok) return { regels: [], sha: null };
  const data = await resp.json();
  const inhoud = atob(data.content.replace(/\n/g, ""));
  const regels = inhoud
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r && !r.startsWith("#"));

  return { regels, sha: data.sha };
}

async function slaBestandOp(env, regels, sha, commitMsg) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/zoekopdrachten.txt`;
  const nieuweInhoud = btoa(regels.join("\n") + "\n");

  await fetch(apiUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "Cloudflare-Worker",
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: commitMsg,
      content: nieuweInhoud,
      ...(sha ? { sha } : {}),
    }),
  });
}

async function stuurBericht(token, chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function beantwoordCallback(token, callbackQueryId) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

async function bewerkBericht(token, chatId, messageId, text) {
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
}
