export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Automatische webhook-koppeling via https://<jouw-worker>.workers.dev/setup
    if (request.method === "GET" && url.pathname === "/setup") {
      if (!env.TELEGRAM_TOKEN) {
        return new Response("❌ TELEGRAM_TOKEN ontbreekt in de Worker-instellingen.", {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      const webhookUrl = `${url.origin}/`;
      const secretToken = await maakSecretToken(env.TELEGRAM_TOKEN);
      const resp = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}&secret_token=${encodeURIComponent(secretToken)}`
      );
      const data = await resp.json();
      return new Response(
        data.ok
          ? `✅ Telegram webhook succesvol gekoppeld aan ${webhookUrl}`
          : `❌ Fout bij koppelen: ${data.description || "Onbekende fout"}`,
        { status: data.ok ? 200 : 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    if (request.method !== "POST") {
      return new Response("OK", { status: 200 });
    }

    // Controleer Telegram secret header indien meegezonden
    const headerSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (headerSecret && env.TELEGRAM_TOKEN) {
      const verwachtSecret = await maakSecretToken(env.TELEGRAM_TOKEN);
      if (headerSecret !== verwachtSecret) {
        return new Response("Unauthorized", { status: 403 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    // 1. Klik op afstandsknop afhandelen (Inline Keyboard)
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = String(cq.message?.chat?.id || "");
      if (chatId !== String(env.TELEGRAM_CHAT_ID)) {
        return new Response("Unauthorized", { status: 403 });
      }

      const kmMatch = (cq.data || "").match(/^km:(\d+)$/);
      const urlMatch = (cq.message?.text || "").match(/https?:\/\/(?:www\.)?marktplaats\.nl\/(?:l|q)\/\S+/i);

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
      const { regels, ok, status } = await haalBestandOp(env);
      if (!ok) {
        await stuurBericht(
          env.TELEGRAM_TOKEN,
          chatId,
          `❌ Kon zoekopdrachten niet ophalen van GitHub (HTTP ${status}). Controleer <code>GITHUB_TOKEN</code> en <code>GITHUB_REPO</code>.`
        );
      } else if (regels.length === 0) {
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
      const { regels, sha, ok, status } = await haalBestandOp(env);

      if (!ok) {
        await stuurBericht(
          env.TELEGRAM_TOKEN,
          chatId,
          `❌ Kon zoekopdrachten niet ophalen van GitHub (HTTP ${status}). Controleer <code>GITHUB_TOKEN</code> en <code>GITHUB_REPO</code>.`
        );
        return new Response("OK", { status: 200 });
      }

      if (!nr || nr < 1 || nr > regels.length) {
        await stuurBericht(env.TELEGRAM_TOKEN, chatId, "Geef een geldig nummer op uit <code>/lijst</code> (bijv. <code>/verwijder 1</code>).");
        return new Response("OK", { status: 200 });
      }

      const verwijderd = regels.splice(nr - 1, 1)[0];
      const opgeslagen = await slaBestandOp(env, regels, sha, "Verwijder zoekopdracht via Telegram");
      if (!opgeslagen.ok) {
        await stuurBericht(
          env.TELEGRAM_TOKEN,
          chatId,
          `❌ Verwijderen mislukt op GitHub (HTTP ${opgeslagen.status}). Controleer de schrijfrechten van je <code>GITHUB_TOKEN</code>.`
        );
        return new Response("OK", { status: 200 });
      }

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
          `Kies de maximale afstand voor:\n${escapeHtml(ruweUrl)}`,
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
      "👋 <b>Marktplaats Alert Bot</b>\n\n" +
        "• Plak een Marktplaats zoek- of categorielink (<code>/q/...</code> of <code>/l/...</code>) om een alert in te stellen.\n" +
        "• Gebruik <code>/lijst</code> om je actieve zoekopdrachten te bekijken.\n" +
        "• Gebruik <code>/verwijder [nummer]</code> om een zoekopdracht te verwijderen."
    );
    return new Response("OK", { status: 200 });
  },
};

async function maakSecretToken(telegramToken) {
  const bytes = new TextEncoder().encode(`mp-webhook:${telegramToken}`);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function escapeHtml(tekst) {
  return String(tekst)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function base64DecodeUtf8(base64) {
  const binString = atob(base64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function base64EncodeUtf8(tekst) {
  const bytes = new TextEncoder().encode(tekst);
  let binString = "";
  for (const byte of bytes) {
    binString += String.fromCharCode(byte);
  }
  return btoa(binString);
}

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
      filters.set("postcode", standaardPostcode.trim().replace(/\s+/g, "").toUpperCase());
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
  const heeftEigenNaam = regel.includes("|") && !regel.startsWith("http");
  const eigenNaam = heeftEigenNaam ? regel.split("|", 2)[0].trim() : "";
  const urlDeel = heeftEigenNaam
    ? regel.split("|", 2)[1].trim()
    : regel.trim();

  try {
    const u = new URL(urlDeel);
    const segmenten = u.pathname.split("/").filter((s) => s && s !== "q" && s !== "l");
    let titel = eigenNaam || (segmenten.length
      ? decodeURIComponent(segmenten[segmenten.length - 1]).replace(/[+-]+/g, " ")
      : urlDeel);

    const hashQ = u.hash.match(/(?:^|#|\|)q:([^|]+)/);
    if (hashQ && !eigenNaam) {
      const zoekwoord = decodeURIComponent(hashQ[1]).replace(/[+-]+/g, " ");
      titel = `${zoekwoord} (${titel})`;
    }

    const kmMatch = u.hash.match(/distanceMeters:(\d+)/);
    const afstand = kmMatch ? ` (${Math.round(parseInt(kmMatch[1], 10) / 1000)} km)` : " (heel NL)";
    return escapeHtml(`${titel}${afstand}`);
  } catch {
    return escapeHtml(eigenNaam || urlDeel);
  }
}

async function voegZoekopdrachtToe(env, url) {
  const { regels, sha, ok, status } = await haalBestandOp(env);
  if (!ok) {
    return `❌ Kon zoekopdrachten niet ophalen van GitHub (HTTP ${status}). Controleer <code>GITHUB_TOKEN</code> en <code>GITHUB_REPO</code>.`;
  }

  const bestaatAl = regels.some((r) => {
    const rUrl = r.includes("|") && !r.startsWith("http") ? r.split("|", 2)[1].trim() : r;
    return rUrl === url;
  });
  if (bestaatAl) {
    return "ℹ️ Deze zoekopdracht staat al in je lijst.";
  }

  regels.push(url);
  const opgeslagen = await slaBestandOp(env, regels, sha, "Nieuwe zoekopdracht via Telegram");
  if (!opgeslagen.ok) {
    return `❌ Kon zoekopdracht niet opslaan op GitHub (HTTP ${opgeslagen.status}). Controleer de schrijfrechten van je <code>GITHUB_TOKEN</code>.`;
  }
  return `✅ Toegevoegd:\n<b>${maakLeesbareNaam(url)}</b>`;
}

async function sha256Bytes(tekst) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tekst));
  return new Uint8Array(buf);
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function versleutel(tekst, sleutel) {
  if (!tekst) return "";
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = bytesToHex(nonceBytes);
  const data = new TextEncoder().encode(tekst);
  const out = new Uint8Array(data.length);

  for (let i = 0; i < data.length; i += 32) {
    const blok = await sha256Bytes(`mp-enc:${sleutel}:${nonce}:${i / 32}`);
    for (let j = 0; j < Math.min(32, data.length - i); j++) {
      out[i + j] = data[i + j] ^ blok[j];
    }
  }

  const cipherHex = bytesToHex(out);
  const mac = bytesToHex(await sha256Bytes(`mp-mac:${sleutel}:${nonce}:${cipherHex}`)).slice(0, 32);
  return `ENC1:${nonce}:${mac}:${cipherHex}`;
}

async function ontsleutel(inhoud, sleutel) {
  const delen = inhoud.trim().split(":");
  if (delen.length !== 4 || delen[0] !== "ENC1") return null;
  const [, nonce, mac, cipherHex] = delen;
  const verwachtMac = bytesToHex(await sha256Bytes(`mp-mac:${sleutel}:${nonce}:${cipherHex}`)).slice(0, 32);
  if (mac !== verwachtMac) return null;

  const cipher = hexToBytes(cipherHex);
  const out = new Uint8Array(cipher.length);
  for (let i = 0; i < cipher.length; i += 32) {
    const blok = await sha256Bytes(`mp-enc:${sleutel}:${nonce}:${i / 32}`);
    for (let j = 0; j < Math.min(32, cipher.length - i); j++) {
      out[i + j] = cipher[i + j] ^ blok[j];
    }
  }
  return new TextDecoder("utf-8").decode(out);
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

  if (resp.status === 404) {
    return { regels: [], sha: null, ok: true, status: 404 };
  }
  if (!resp.ok) {
    return { regels: [], sha: null, ok: false, status: resp.status };
  }

  const data = await resp.json();
  const inhoud = base64DecodeUtf8(data.content).trim();
  if (!inhoud) {
    return { regels: [], sha: data.sha, ok: true, status: 200 };
  }

  let tekst = inhoud;
  if (inhoud.startsWith("ENC1:")) {
    const ontsleuteld = await ontsleutel(inhoud, env.TELEGRAM_TOKEN);
    if (ontsleuteld === null) {
      return { regels: [], sha: data.sha, ok: true, status: 200 };
    }
    tekst = ontsleuteld;
  }

  const regels = tekst
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r && !r.startsWith("#"));

  return { regels, sha: data.sha, ok: true, status: 200 };
}

async function slaBestandOp(env, regels, sha, commitMsg) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/zoekopdrachten.txt`;
  const platteTekst = regels.length > 0 ? regels.join("\n") : "";
  const versleuteldeTekst = platteTekst
    ? (await versleutel(platteTekst, env.TELEGRAM_TOKEN)) + "\n"
    : "";
  const nieuweInhoud = base64EncodeUtf8(versleuteldeTekst);

  const resp = await fetch(apiUrl, {
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

  return { ok: resp.ok, status: resp.status };
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
