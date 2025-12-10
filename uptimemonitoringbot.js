const fs = require("fs");
const https = require("https");
const net = require("net");
const dgram = require("dgram");
const { Client, GatewayIntentBits, Partials } = require("discord.js");

// node-fetch 3 ESM -> dynamischer Import als Funktion
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

// ---------------- Config laden ----------------

const configRaw = fs.readFileSync("./config.json", "utf-8");
const CONFIG = JSON.parse(configRaw);

const OWNER_ID = CONFIG.ownerId;
const CHECK_INTERVAL_MS = CONFIG.checkIntervalMs || 600000;
const WEBSITES = CONFIG.websites || [];
const PORTS = CONFIG.ports || [];

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!DISCORD_TOKEN) {
  console.error("Bitte Umgebungsvariable DISCORD_TOKEN mit deinem Bot-Token setzen.");
  process.exit(1);
}

// ---------------- Discord Client ----------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel] // nötig für DMs
});

let statusMessage = null; // DM, die wir immer wieder editieren
let ownerUser = null;      // wird nach Login gesetzt

// Merkt sich den letzten Status pro Website, um nur bei Änderungen zu alarmieren
// key = name oder URL, value = "ok" | "tls_error" | "down"
const lastWebsiteStates = {};

// ---------------- Hilfsfunktionen ----------------

function getWebsiteKey(cfg, index) {
  // Wenn du später mal eine eigene ID in der config setzen willst, kannst du die hier auch nutzen
  return cfg.id || `${index}:${cfg.url}`;
}


// PN schicken, wenn es ein Problem gibt
async function sendWebsiteProblemAlert(cfg, result) {
  if (!ownerUser) {
    try {
      ownerUser = await client.users.fetch(OWNER_ID);
    } catch (err) {
      console.error("Konnte Owner nicht fetchen für Alarm:", err);
      return;
    }
  }

  const name = cfg.name || "Unbenannt";
  const url = cfg.url;

  let title = "";
  if (result.state === "tls_error") {
    title = "🔒 SSL / Zertifikatsproblem";
  } else if (result.state === "down") {
    title = "⚠️ Seite nicht erreichbar / Fehler";
  } else {
    title = "ℹ️ Info";
  }

  const text =
    `${title}\n` +
    `**${name}** (${url})\n` +
    `${result.text}`;

  try {
    await ownerUser.send(text);
  } catch (err) {
    console.error("Konnte Alarm-DM nicht senden:", err);
  }
}

// Optional: PN bei Recovery (Problem -> OK)
async function sendWebsiteRecoveryAlert(cfg, result) {
  if (!ownerUser) {
    try {
      ownerUser = await client.users.fetch(OWNER_ID);
    } catch (err) {
      console.error("Konnte Owner nicht fetchen für Recovery:", err);
      return;
    }
  }

  const name = cfg.name || "Unbenannt";
  const url = cfg.url;

  const text =
    `✅ Recovery\n` +
    `**${name}** (${url}) ist wieder erreichbar / ohne SSL-Fehler.\n` +
    `${result.text}`;

  try {
    await ownerUser.send(text);
  } catch (err) {
    console.error("Konnte Recovery-DM nicht senden:", err);
  }
}

// ---------------- Website-Check ----------------
// Rückgabe: { text: string, state: "ok" | "tls_error" | "down" }

async function checkWebsite(cfg) {
  const name = cfg.name || "Unbenannt";
  const url = cfg.url;
  const verifyTls = cfg.verifyTls !== false; // default: true
  const timeoutMs = cfg.timeoutMs || 5000;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let agent = undefined;
  if (!verifyTls) {
    agent = new https.Agent({ rejectUnauthorized: false });
  }

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      agent
    });

    const status = res.status;
    clearTimeout(timeout);

    if (url.toLowerCase().startsWith("http://")) {
      if (status >= 200 && status < 400) {
        return {
          text: `⚠️ **${name}** (${url}) – HTTP ${status} (ohne TLS, evtl. unsicher)`,
          state: "down" // wir werten "ohne TLS" als potentiell unsicher
        };
      } else {
        return {
          text: `❌ **${name}** (${url}) – HTTP ${status} (ohne TLS)`,
          state: "down"
        };
      }
    }

    if (status >= 200 && status < 400) {
      return {
        text: `✅ **${name}** (${url}) – HTTP ${status}`,
        state: "ok"
      };
    } else {
      return {
        text: `❌ **${name}** (${url}) – HTTP ${status}`,
        state: "down"
      };
    }
  } catch (err) {
    clearTimeout(timeout);

    // Zertifikats-/TLS-Fehler → „Website nicht sicher“
    if (
      err.code &&
      (err.code.startsWith("CERT_") ||
        err.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
        err.code === "DEPTH_ZERO_SELF_SIGNED_CERT")
    ) {
      return {
        text: `🔒❌ **${name}** (${url}) – TLS/Zertifikatfehler (Website nicht sicher?) – ${err.code}`,
        state: "tls_error"
      };
    }

    if (err.name === "AbortError") {
      return {
        text: `⏱️ **${name}** (${url}) – Timeout nach ${timeoutMs}ms`,
        state: "down"
      };
    }

    return {
      text: `❌ **${name}** (${url}) – Fehler: ${err.name || "Error"}: ${err.message}`,
      state: "down"
    };
  }
}

// ---------------- TCP-Check ----------------

function checkTcpPort(cfg) {
  const name = cfg.name || "Unbenannt";
  const host = cfg.host;
  const port = cfg.port;
  const timeoutMs = cfg.timeoutMs || 3000;

  return new Promise((resolve) => {

    const attempt = (tryNumber = 1) => {
      const socket = new net.Socket();
      let didRetry = false;

      const cleanup = () => {
        socket.removeListener("error", onError);
        socket.removeListener("connect", onConnect);
        socket.removeListener("timeout", onTimeout);
        socket.destroy();
      };

      const onError = (err) => {
        cleanup();
        resolve(
          `❌ **${name}** TCP ${host}:${port} – nicht erreichbar (${err.code || err.message})`
        );
      };

      const onConnect = () => {
        cleanup();
        resolve(`✅ **${name}** TCP ${host}:${port} – erreichbar`);
      };

      const onTimeout = () => {
        cleanup();

        if (tryNumber === 1) {
          // 👉 genau EIN Retry
          attempt(2);
          didRetry = true;
          return;
        }

        // nach dem Retry endgültig aufgeben
        resolve(`⏱️ **${name}** TCP ${host}:${port} – Timeout nach ${timeoutMs}ms (nach Retry)`);
      };

      socket.setTimeout(timeoutMs);
      socket.once("error", onError);
      socket.once("connect", onConnect);
      socket.once("timeout", onTimeout);

      socket.connect(port, host);
    };

    attempt();
  });
}

// ---------------- UDP-Check ----------------

function checkUdpPort(cfg) {
  const name = cfg.name || "Unbenannt";
  const host = cfg.host;
  const port = cfg.port;
  const timeoutMs = cfg.timeoutMs || 3000;

  // UDP ist tricky: keine Garantie auf Antwort.
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");

    let finished = false;
    const done = (msg) => {
      if (!finished) {
        finished = true;
        socket.close();
        resolve(msg);
      }
    };

    socket.on("error", (err) => {
      done(`❌ **${name}** UDP ${host}:${port} – Fehler: ${err.code || err.message}`);
    });

    // wir erwarten i.d.R. keine Antwort
    socket.send(Buffer.alloc(0), port, host, (err) => {
      if (err) {
        return done(`❌ **${name}** UDP ${host}:${port} – Fehler beim Senden: ${err.code || err.message}`);
      }

      setTimeout(() => {
        done(
          `ℹ️ **${name}** UDP ${host}:${port} – Paket gesendet, keine Antwort (UDP schwer zuverlässig zu prüfen)`
        );
      }, timeoutMs);
    });
  });
}

async function deleteOldBotMessages() {
  try {
    if (!ownerUser) {
      ownerUser = await client.users.fetch(OWNER_ID);
    }

    const dm = await ownerUser.createDM();

    // Nachrichten in Batches laden (Discord erlaubt max. 100 auf einmal)
    let messages = await dm.messages.fetch({ limit: 100 });
    let deleted = 0;

    while (messages.size > 0) {
      for (const msg of messages.values()) {
        if (msg.author.id === client.user.id) {
          try {
            await msg.delete();
            deleted++;
          } catch (err) {
            console.error("Konnte Nachricht nicht löschen:", err);
          }
        }
      }

      // nächste Runde
      messages = await dm.messages.fetch({ limit: 100, before: messages.last().id });
    }

    console.log(`Alle alten Bot-Nachrichten gelöscht: ${deleted} Stück`);
  } catch (err) {
    console.error("Fehler beim Löschen der Bot-Nachrichten:", err);
  }
}

// ---------------- Monitoring-Loop ----------------

async function doMonitoringCycle() {
  try {
    const lines = [];

    if (WEBSITES.length > 0) {
      lines.push("📡 **Webseiten-Status:**");
      for (let i = 0; i < WEBSITES.length; i++) {
        const cfg = WEBSITES[i];
        const result = await checkWebsite(cfg);
        lines.push(`- ${result.text}`);

        const key = getWebsiteKey(cfg, i);
        const prevState = lastWebsiteStates[key] || "ok";

        // Problemstatus -> Alarm, wenn neu
        if (result.state !== "ok" && result.state !== prevState) {
            await sendWebsiteProblemAlert(cfg, result);
        }

        // Recovery -> optionaler Alarm, wenn wieder ok
        if (result.state === "ok" && prevState !== "ok") {
            await sendWebsiteRecoveryAlert(cfg, result);
        }

        lastWebsiteStates[key] = result.state;
        }

      lines.push("");
    }

    if (PORTS.length > 0) {
      lines.push("🔌 **Port-Status:**");
      for (const cfg of PORTS) {
        const proto = (cfg.protocol || "tcp").toLowerCase();
        let res;
        if (proto === "tcp") {
          res = await checkTcpPort(cfg);
        } else if (proto === "udp") {
          res = await checkUdpPort(cfg);
        } else {
          res = `❓ **${cfg.name || "Unbenannt"}** – unbekanntes Protokoll: ${proto}`;
        }
        lines.push(`- ${res}`);
      }
      lines.push("");
    }

    lines.push(`⏱️ Nächster Check in ${Math.round(CHECK_INTERVAL_MS / 1000)} Sekunden.`);
    lines.push(`⏱️ Letzter Check um ${new Date().toLocaleString("de-DE", { timeZone: "UTC" })}`);

    const content = lines.join("\n");

    if (!statusMessage) {
      if (!ownerUser) {
        ownerUser = await client.users.fetch(OWNER_ID);
      }
      statusMessage = await ownerUser.send(content);
    } else {
      try {
        await statusMessage.edit(content);
      } catch (e) {
        if (!ownerUser) {
          ownerUser = await client.users.fetch(OWNER_ID);
        }
        statusMessage = await ownerUser.send(content);
      }
    }
  } catch (err) {
    console.error("Fehler im Monitoring-Cycle:", err);
  }
}

// ---------------- Discord Events ----------------

client.on("ready", async () => {
  console.log(`Eingeloggt als ${client.user.tag}`);

  try {
    ownerUser = await client.users.fetch(OWNER_ID);
    await deleteOldBotMessages();
    statusMessage = await ownerUser.send(
      `👋 Hi! Ich überwache jetzt ${WEBSITES.length} Webseiten und ${PORTS.length} Ports für dich.\n` +
      `Intervall: ${Math.round(CHECK_INTERVAL_MS / 1000)} Sekunden.\n` +
      `Ich schicke dir zusätzlich eine PN, wenn ein SSL-/Zertifikatsproblem oder eine Seite nicht erreichbar ist.`
    );
  } catch (err) {
    console.error("Konnte DM an Owner nicht schicken:", err);
  }

  // Direkt erster Check:
  await doMonitoringCycle();

  // Danach Intervall starten
  setInterval(doMonitoringCycle, CHECK_INTERVAL_MS);
});

client.login(DISCORD_TOKEN);
