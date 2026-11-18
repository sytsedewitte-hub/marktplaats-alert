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
      const eigenaar = isEigenaar(env, chatId);
      const gebruikersData = eigenaar ? null : await haalGebruikersOp(env);

      if (!eigenaar && (!gebruikersData.ok || !gebruikersData.data.users?.[chatId])) {
        await beantwoordCallback(env.TELEGRAM_TOKEN, cq.id);
        return new Response("OK", { status: 200 });
      }

      const kmMatch = (cq.data || "").match(/^km:(\d+)$/);
      const urlMatch = (cq.message?.text || "").match(/https?:\/\/(?:www\.)?marktplaats\.nl\/(?:l|q)\/\S+/i);

      if (kmMatch && urlMatch) {
        const km = parseInt(kmMatch[1], 10);
        const gData = gebruikersData || (await haalGebruikersOp(env));
        const userPostcode = gData.ok ? gData.data.users?.[chatId]?.postcode : "";
        const gebruiktePostcode = userPostcode || env.STANDAARD_POSTCODE;
        const definitieveUrl = pasAfstandToe(urlMatch[0], km, gebruiktePostcode);
        let resultaat = await voegZoekopdrachtToe(env, chatId, definitieveUrl);

        if (km > 0 && !userPostcode && !eigenaar && resultaat.startsWith("✅")) {
          resultaat += "\n\n💡 <i>Tip: stel je eigen postcode in met <code>/postcode 1234AB</code></i>";
        }

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
    const tekst = msg.text.trim();
    const eigenaar = isEigenaar(env, chatId);

    // 2. /start (ook voor uitnodigingslinks: /start <code>)
    if (tekst === "/start" || tekst.startsWith("/start ")) {
      const code = tekst.slice(6).trim();
      const gebruikersRes = await haalGebruikersOp(env);
      const isAlLid = eigenaar || Boolean(gebruikersRes.ok && gebruikersRes.data.users?.[chatId]);

      if (!isAlLid) {
        if (!gebruikersRes.ok) {
          await stuurBericht(env.TELEGRAM_TOKEN, chatId, "❌ Er ging iets mis bij het controleren van je toegang.");
          return new Response("OK", { status: 200 });
        }

        const geldigeCode = (env.INVITE_CODE || "").trim() || gebruikersRes.data._invite_code || "";
        if (!code || !geldigeCode || code !== geldigeCode) {
          await stuurBericht(
            env.TELEGRAM_TOKEN,
            chatId,
            "🔒 Deze bot is privé. Vraag de eigenaar om een geldige uitnodigingslink."
          );
          return new Response("OK", { status: 200 });
        }

        const naam =
          [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") ||
          msg.from?.username ||
          `Gebruiker ${chatId}`;

        const data = gebruikersRes.data;
        if (!data.users) data.users = {};
        data.users[chatId] = {
          naam,
          postcode: "",
          zoekopdrachten: [],
        };

        const opgeslagen = await slaGebruikersOp(env, data, gebruikersRes.sha, `Nieuwe gebruiker aangemeld: ${naam}`);
        if (!opgeslagen.ok) {
          await stuurBericht(env.TELEGRAM_TOKEN, chatId, "❌ Aanmelden mislukt. Probeer het later opnieuw.");
          return new Response("OK", { status: 200 });
        }

        await stuurBericht(
          env.TELEGRAM_TOKEN,
          chatId,
          `👋 Welkom <b>${escapeHtml(naam)}</b>!\n\n` +
            "Je hebt nu toegang tot de Marktplaats Alert Bot:\n" +
            "1. Stel optioneel je postcode in met <code>/postcode 1234AB</code>\n" +
            "2. Plak een Marktplaats zoek- of categorielink (<code>/q/...</code> of <code>/l/...</code>)\n" +
            "3. Gebruik <code>/lijst</code> en <code>/verwijder [nummer]</code> om je zoekopdrachten te beheren."
        );
        return new Response("OK", { status: 200 });
      }

      await stuurHelpBericht(env.TELEGRAM_TOKEN, chatId, eigenaar);
      return new Response("OK", { status: 200 });
    }

    // Controleer toegang voor alle overige berichten
    const gebruikersRes = await haalGebruikersOp(env);
    const isGeregistreerd = Boolean(gebruikersRes.ok && gebruikersRes.data.users?.[chatId]);
    if (!eigenaar && !isGeregistreerd) {
      await stuurBericht(
        env.TELEGRAM_TOKEN,
        chatId,
        "🔒 Deze bot is privé. Vraag de eigenaar om een uitnodigingslink."
      );
      return new Response("OK", { status: 200 });
    }

    // 3. Beheerderscommando's (alleen eigenaar)
    if (eigenaar && (tekst === "/uitnodiging" || tekst === "/uitnodiging nieuw")) {
      if (!gebruikersRes.ok) {
        await stuurBericht(
          env.TELEGRAM_TOKEN,
          chatId,
          `❌ Kon gegevens niet ophalen van GitHub (HTTP ${gebruikersRes.status}).`
        );
        return new Response("OK", { status: 200 });
      }

      const forceerNieuw = tekst === "/uitnodiging nieuw";
      let code = (env.INVITE_CODE || "").trim();
      if (!code) {
        if (forceerNieuw || !gebruikersRes.data._invite_code) {
          code = genereerUitnodigingscode();
          gebruikersRes.data._invite_code = code;
          const opgeslagen = await slaGebruikersOp(
            env,
            gebruikersRes.data,
            gebruikersRes.sha,
            "Genereer uitnodigingscode"
          );
          if (!opgeslagen.ok) {
            await stuurBericht(
              env.TELEGRAM_TOKEN,
              chatId,
              `❌ Kon uitnodigingscode niet opslaan op GitHub (HTTP ${opgeslagen.status}).`
            );
            return new Response("OK", { status: 200 });
          }
        } else {
          code = gebruikersRes.data._invite_code;
        }
      }

      const botUsername = await haalBotUsernameOp(env.TELEGRAM_TOKEN);
      if (botUsername) {
        const link = `https://t.me/${botUsername}?start=${code}`;
        await stuurBericht(
          env.TELEGRAM_TOKEN,
          chatId,
          `🔗 <b>Uitnodigingslink voor je broertje/vrienden:</b>\n\n${escapeHtml(link)}\n\n` +
            (env.INVITE_CODE
              ? "Deel deze link; na klikken op <b>Start</b> is toegang direct actief."
              : "Deel deze link; na klikken op <b>Start</b> is toegang direct actief.\nNieuwe code maken? Gebruik <code>/uitnodiging nieuw</code>.")
        );
      } else {
        await stuurBericht(
          env.TELEGRAM_TOKEN,
          chatId,
          `🔑 <b>Uitnodigingscode:</b> <code>${escapeHtml(code)}</code>\nLaat de ander naar de bot gaan en sturen: <code>/start ${escapeHtml(code)}</code>`
        );
      }
      return new Response("OK", { status: 200 });
    }

    if (eigenaar && tekst === "/gebruikers") {
      if (!gebruikersRes.ok) {
        await stuurBericht(
          env.TELEGRAM_TOKEN,
          chatId,
          `❌ Kon gebruikers niet ophalen (HTTP ${gebruikersRes.status}).`
        );
        return new Response("OK", { status: 200 });
      }
      const leden = Object.entries(gebruikersRes.data.users || {}).filter(([id]) => id !== String(env.TELEGRAM_CHAT_ID));
      if (leden.length === 0) {
        await stuurBericht(
          env.TELEGRAM_TOKEN,
          chatId,
          "Er zijn nog geen extra gebruikers aangemeld. Gebruik <code>/uitnodiging</code> om een link te maken."
        );
      } else {
        const overzicht = leden
          .map(([id, u], i) => {
            const aantal = (u.zoekopdrachten || []).length;
            const pc = u.postcode || "standaard";
            return `${i + 1}. <b>${escapeHtml(u.naam || id)}</b> (${aantal} zoekopdracht${aantal === 1 ? "" : "en"}, postcode: ${escapeHtml(pc)})`;
          })
          .join("\n");
        await stuurBericht(
          env.TELEGRAM_TOKEN,
          chatId,
          `👥 <b>Aangemelde gebruikers:</b>\n\n${overzicht}\n\nVerwijderen met: <code>/verwijder_gebruiker nummer</code>`
        );
      }
      return new Response("OK", { status: 200 });
    }

    if (eigenaar && tekst.startsWith("/verwijder_gebruiker")) {
      const nr = parseInt(tekst.replace("/verwijder_gebruiker", "").trim(), 10);
      if (!gebruikersRes.ok) {
        await stuurBericht(
          env.TELEGRAM_TOKEN,
          chatId,
          `❌ Kon gebruikers niet ophalen (HTTP ${gebruikersRes.status}).`
        );
        return new Response("OK", { status: 200 });
      }
      const leden = Object.entries(gebruikersRes.data.users || {}).filter(([id]) => id !== String(env.TELEGRAM_CHAT_ID));
      if (!nr || nr < 1 || nr > leden.length) {
        await stuurBericht(env.TELEGRAM_TOKEN, chatId, "Geef een geldig nummer op uit <code>/gebruikers</code>.");
        return new Response("OK", { status: 200 });
      }
      const [verwijderId, verwijderInfo] = leden[nr - 1];
      delete gebruikersRes.data.users[verwijderId];
      const opgeslagen = await slaGebruikersOp(
        env,
        gebruikersRes.data,
        gebruikersRes.sha,
        `Verwijder gebruiker ${verwijderInfo.naam || verwijderId}`
      );
      if (!opgeslagen.ok) {
        await stuurBericht(env.TELEGRAM_TOKEN, chatId, `❌ Verwijderen mislukt (HTTP ${opgeslagen.status}).`);
        return new Response("OK", { status: 200 });
      }
      await stuurBericht(
        env.TELEGRAM_TOKEN,
        chatId,
        `🗑️ Gebruiker <b>${escapeHtml(verwijderInfo.naam || verwijderId)}</b> verwijderd.`
      );
      return new Response("OK", { status: 200 });
    }

    // 4. Commando: /postcode <1234AB>
    if (tekst === "/postcode" || tekst.startsWith("/postcode ")) {
      const invoer = tekst.replace("/postcode", "").trim().replace(/\s+/g, "").toUpperCase();
      if (!/^[1-9][0-9]{3}[A-Z]{2}$/.test(invoer)) {
        const huidige = (gebruikersRes.ok && gebruikersRes.data.users?.[chatId]?.postcode) || (eigenaar ? env.STANDAARD_POSTCODE : "");
        await stuurBericht(
          env.TELEGRAM_TOKEN,
          chatId,
          `📍 Geef een geldige Nederlandse postcode op, bijv. <code>/postcode 1234AB</code>.` +
            (huidige ? `\nHuidige postcode: <code>${escapeHtml(huidige)}</code>` : "")
        );
        return new Response("OK", { status: 200 });
      }

      if (!gebruikersRes.ok) {
        await stuurBericht(env.TELEGRAM_TOKEN, chatId, `❌ Kon gegevens niet ophalen (HTTP ${gebruikersRes.status}).`);
        return new Response("OK", { status: 200 });
      }

      if (!gebruikersRes.data.users) gebruikersRes.data.users = {};
      if (!gebruikersRes.data.users[chatId]) {
        gebruikersRes.data.users[chatId] = { naam: eigenaar ? "Eigenaar" : chatId, postcode: invoer, zoekopdrachten: [] };
      } else {
        gebruikersRes.data.users[chatId].postcode = invoer;
      }

      const opgeslagen = await slaGebruikersOp(env, gebruikersRes.data, gebruikersRes.sha, "Postcode bijgewerkt via Telegram");
      if (!opgeslagen.ok) {
        await stuurBericht(env.TELEGRAM_TOKEN, chatId, `❌ Opslaan mislukt (HTTP ${opgeslagen.status}).`);
        return new Response("OK", { status: 200 });
      }

      await stuurBericht(env.TELEGRAM_TOKEN, chatId, `📍 Je standaard postcode is nu ingesteld op <b>${escapeHtml(invoer)}</b>.`);
      return new Response("OK", { status: 200 });
    }

    // 5. Commando: /lijst
    if (tekst === "/lijst") {
      const { regels, ok, status } = await haalZoekopdrachtenOp(env, chatId);
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

    // 6. Commando: /verwijder <nummer>
    if (tekst.startsWith("/verwijder")) {
      const nr = parseInt(tekst.replace("/verwijder", "").trim(), 10);
      const { regels, sha, gebruikersData, ok, status } = await haalZoekopdrachtenOp(env, chatId);

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
      const opgeslagen = await slaZoekopdrachtenOp(
        env,
        chatId,
        regels,
        sha,
        gebruikersData,
        "Verwijder zoekopdracht via Telegram"
      );
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

    // 7. Nieuwe Marktplaats zoek- of categorielink ontvangen (alleen /l/ of /q/)
    const mpMatch = tekst.match(/(https?:\/\/(?:www\.)?marktplaats\.nl\/(?:l|q)\/\S+)(?:\s+(\d+))?/i);
    if (mpMatch) {
      const ruweUrl = mpMatch[1];
      const directKm = mpMatch[2];

      if (directKm !== undefined) {
        const userPostcode = gebruikersRes.ok ? gebruikersRes.data.users?.[chatId]?.postcode : "";
        const definitieveUrl = pasAfstandToe(ruweUrl, parseInt(directKm, 10), userPostcode || env.STANDAARD_POSTCODE);
        const resultaat = await voegZoekopdrachtToe(env, chatId, definitieveUrl);
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

    await stuurHelpBericht(env.TELEGRAM_TOKEN, chatId, eigenaar);
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

function isEigenaar(env, chatId) {
  return String(chatId) === String(env.TELEGRAM_CHAT_ID);
}

function genereerUitnodigingscode() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function haalBotUsernameOp(token) {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await resp.json();
    return data.ok ? data.result?.username || "" : "";
  } catch {
    return "";
  }
}

async function stuurHelpBericht(token, chatId, eigenaar) {
  let tekst =
    "👋 <b>Marktplaats Alert Bot</b>\n\n" +
    "• Plak een Marktplaats zoek- of categorielink (<code>/q/...</code> of <code>/l/...</code>) om een alert in te stellen.\n" +
    "• Gebruik <code>/lijst</code> om je actieve zoekopdrachten te bekijken.\n" +
    "• Gebruik <code>/verwijder [nummer]</code> om een zoekopdracht te verwijderen.\n" +
    "• Gebruik <code>/postcode 1234AB</code> om je eigen postcode in te stellen.";

  if (eigenaar) {
    tekst +=
      "\n\n<b>Beheerder:</b>\n" +
      "• <code>/uitnodiging</code> — maak of bekijk je uitnodigingslink\n" +
      "• <code>/gebruikers</code> — bekijk aangemelde gebruikers\n" +
      "• <code>/verwijder_gebruiker [nummer]</code> — verwijder een gebruiker";
  }

  await stuurBericht(token, chatId, tekst);
}

async function haalZoekopdrachtenOp(env, chatId) {
  if (isEigenaar(env, chatId)) {
    const res = await haalBestandOp(env);
    return { ...res, gebruikersData: null };
  }
  const gRes = await haalGebruikersOp(env);
  if (!gRes.ok) {
    return { regels: [], sha: null, gebruikersData: null, ok: false, status: gRes.status };
  }
  const user = gRes.data.users?.[chatId];
  return {
    regels: [...(user?.zoekopdrachten || [])],
    sha: gRes.sha,
    gebruikersData: gRes.data,
    ok: true,
    status: 200,
  };
}

async function slaZoekopdrachtenOp(env, chatId, regels, sha, gebruikersData, commitMsg) {
  if (isEigenaar(env, chatId)) {
    return slaBestandOp(env, regels, sha, commitMsg);
  }
  const data = gebruikersData || {};
  if (!data.users) data.users = {};
  if (!data.users[chatId]) {
    data.users[chatId] = { naam: `Gebruiker ${chatId}`, postcode: "", zoekopdrachten: [] };
  }
  data.users[chatId].zoekopdrachten = regels;
  return slaGebruikersOp(env, data, sha, commitMsg);
}

async function voegZoekopdrachtToe(env, chatId, url) {
  const { regels, sha, gebruikersData, ok, status } = await haalZoekopdrachtenOp(env, chatId);
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
  const opgeslagen = await slaZoekopdrachtenOp(
    env,
    chatId,
    regels,
    sha,
    gebruikersData,
    "Nieuwe zoekopdracht via Telegram"
  );
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

async function haalGebruikersOp(env) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/gebruikers.json`;
  const resp = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "Cloudflare-Worker",
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (resp.status === 404) {
    return { data: { users: {} }, sha: null, ok: true, status: 404 };
  }
  if (!resp.ok) {
    return { data: { users: {} }, sha: null, ok: false, status: resp.status };
  }

  const fileData = await resp.json();
  const inhoud = base64DecodeUtf8(fileData.content).trim();
  if (!inhoud) {
    return { data: { users: {} }, sha: fileData.sha, ok: true, status: 200 };
  }

  try {
    const parsed = JSON.parse(inhoud);
    if (typeof parsed.data === "string" && parsed.data.startsWith("ENC1:")) {
      const ontsleuteld = await ontsleutel(parsed.data, env.TELEGRAM_TOKEN);
      if (ontsleuteld !== null) {
        const obj = JSON.parse(ontsleuteld);
        if (!obj.users) obj.users = {};
        return { data: obj, sha: fileData.sha, ok: true, status: 200 };
      }
      return { data: { users: {} }, sha: fileData.sha, ok: true, status: 200 };
    }
    if (!parsed.users) parsed.users = {};
    return { data: parsed, sha: fileData.sha, ok: true, status: 200 };
  } catch {
    return { data: { users: {} }, sha: fileData.sha, ok: true, status: 200 };
  }
}

async function slaGebruikersOp(env, dataObj, sha, commitMsg) {
  const apiUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/gebruikers.json`;
  const payloadJson = JSON.stringify(dataObj || { users: {} });
  const versleuteld = await versleutel(payloadJson, env.TELEGRAM_TOKEN);
  const nieuweInhoud = base64EncodeUtf8(JSON.stringify({ data: versleuteld }, null, 2) + "\n");

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
