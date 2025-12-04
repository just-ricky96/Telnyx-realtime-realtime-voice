// server.js
import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

dotenv.config();

// ==== ENV ====
const {
  OPENAI_API_KEY,
  TELNYX_API_KEY,
  TELNYX_CONNECTION_ID,
  TELNYX_FROM_NUMBER,
  RENDER_DOMAIN,
  PORT = 10000,
} = process.env;

if (!OPENAI_API_KEY) console.error("⚠️ OPENAI_API_KEY fehlt in .env");
if (!TELNYX_API_KEY) console.error("⚠️ TELNYX_API_KEY fehlt in .env");
if (!TELNYX_CONNECTION_ID) console.error("⚠️ TELNYX_CONNECTION_ID fehlt in .env");
if (!TELNYX_FROM_NUMBER) console.error("⚠️ TELNYX_FROM_NUMBER fehlt in .env");
if (!RENDER_DOMAIN) console.error("⚠️ RENDER_DOMAIN fehlt in .env");

// ==== EXPRESS / HTTP SERVER ====
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Telnyx ↔ OpenAI Realtime Voice Server läuft ✅");
});

app.get("/health", (req, res) => {
  res.send("ok");
});

// Outbound-Call starten: /call?to=+49...
app.get("/call", async (req, res) => {
  const to = req.query.to;

  if (!to) {
    return res.status(400).json({
      ok: false,
      error: "Parameter 'to' fehlt, z.B. /call?to=%2B49123456789",
    });
  }

  console.log("📞 Starte Outbound Call zu:", to);

  try {
    const response = await axios.post(
      "https://api.telnyx.com/v2/calls",
      {
        connection_id: TELNYX_CONNECTION_ID,
        to,
        from: TELNYX_FROM_NUMBER,
        // Call-Control aktivieren
        webhook_url: `https://${RENDER_DOMAIN}/telnyx-webhook`,
        // wichtig: Call Control Modus
        client_state: Buffer.from("realtime-openai").toString("base64"),
      },
      {
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Telnyx Call Response:", response.data);
    res.json({ ok: true, telnyx: response.data });
  } catch (err) {
    console.error("❌ Fehler beim Erstellen des Calls:", err.response?.data || err.message);
    res.status(500).json({
      ok: false,
      error: err.response?.data || err.message,
    });
  }
});

// ==== TELNYX WEBHOOK ====
app.post("/telnyx-webhook", async (req, res) => {
  const event = req.body?.data?.event_type || req.body?.event_type;
  const payload = req.body?.data?.payload || req.body?.payload;

  console.log("☎️ Telnyx Webhook Event:", event);

  // Telnyx erwartet schnell eine 200
  res.status(200).json({ ok: true });

  if (!event || !payload) return;

  const callControlId =
    payload.call_control_id ||
    payload.call_control_identifier ||
    payload.call_control_id_string;

  if (!callControlId) {
    console.warn("⚠️ Kein call_control_id im Payload gefunden");
    return;
  }

  // Nur die wichtigsten Events behandeln
  if (event === "call.initiated") {
    console.log("📟 Call initiiert:", callControlId);
  }

  if (event === "call.answered") {
    console.log("✅ Call answered – starte Media Stream für", callControlId);
    await startTelnyxMediaStream(callControlId);
  }

  if (event === "call.hangup") {
    console.log("📴 Call hangup für", callControlId);
  }
});

// ==== TELNYX MEDIA STREAM STARTEN ====
async function startTelnyxMediaStream(callControlId) {
  try {
    const body = {
      stream_url: `wss://${RENDER_DOMAIN}/media`,
      // Wichtig: genau PCMU/8000 für OpenAI
      audio: {
        sample_rate: 8000,
        channels: 1,
        encoding: "PCMU", // G.711 µ-law
      },
    };

    console.log("🔊 Sende stream_start:", JSON.stringify(body));

    const resp = await axios.post(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/stream_start`,
      body,
      {
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ Telnyx streaming_start Response:", resp.data);
  } catch (err) {
    console.error(
      "❌ Fehler bei stream_start:",
      err.response?.data || err.message
    );
  }
}

// ==== WEBSOCKET SERVER FÜR TELNYX MEDIA ====
const httpServer = http.createServer(app);

// Telnyx verbindet sich hierher: wss://.../media
const mediaWss = new WebSocketServer({
  server: httpServer,
  path: "/media",
});

mediaWss.on("connection", (telnyxWs, req) => {
  console.log("🔌 Telnyx Media WebSocket verbunden");

  // Für jede Media-Verbindung einen eigenen OpenAI-Realtime-WS aufbauen
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // Wenn OpenAI verbunden ist, Session konfigurieren
  openaiWs.on("open", () => {
    console.log("🤖 OpenAI Realtime verbunden");

    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions:
          "Du bist ein freundlicher deutschsprachiger Telefonassistent. Sprich kurz, hilfreich und natürlich.",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        sample_rate: 8000,
        turn_detection: { type: "server_vad" },
      },
    };

    openaiWs.send(JSON.stringify(sessionUpdate));
  });

  openaiWs.on("error", (err) => {
    console.error("❌ OpenAI WS Fehler:", err.message);
  });

  openaiWs.on("close", () => {
    console.log("🔌 OpenAI WebSocket geschlossen");
  });

  // 👉 Telnyx → OpenAI (Audio & Events)
  telnyxWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.warn("⚠️ Konnte Telnyx-Message nicht parsen");
      return;
    }

    // Telnyx Media Frames
    const event = msg.event || msg.event_name;
    if (event === "start") {
      console.log(
        "🎬 Telnyx WS: start",
        JSON.stringify(msg.start || msg, null, 2)
      );
      // Nach Start schicken wir ein erstes "prompt"
      if (openaiWs.readyState === WebSocket.OPEN) {
        const converse = {
          type: "response.create",
          response: {
            instructions:
              "Begrüße den Anrufer freundlich und frage, wie du helfen kannst.",
          },
        };
        openaiWs.send(JSON.stringify(converse));
      }
      return;
    }

    if (event === "media") {
      const payload =
        msg.media?.payload ||
        msg.media?.data ||
        msg.payload ||
        msg.data?.payload;

      if (!payload) return;

      // payload = Base64 PCMU (8k)
      if (openaiWs.readyState === WebSocket.OPEN) {
        const audioEvent = {
          type: "input_audio_buffer.append",
          audio: payload,
        };
        openaiWs.send(JSON.stringify(audioEvent));
      }
      return;
    }

    if (event === "stop") {
      console.log("⏹️ Telnyx WS: stop");
      if (openaiWs.readyState === WebSocket.OPEN) {
        const commit = { type: "input_audio_buffer.commit" };
        openaiWs.send(JSON.stringify(commit));
      }
      return;
    }

    console.log("ℹ️ Telnyx WS sonstiges Event:", event);
  });

  telnyxWs.on("close", () => {
    console.log("🔌 Telnyx WebSocket geschlossen");
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  telnyxWs.on("error", (err) => {
    console.error("❌ Telnyx WS Fehler:", err.message);
  });

  // 👉 OpenAI → Telnyx (Audio zurückspielen)
  openaiWs.on("message", (data) => {
    // OpenAI schickt JSON-Events
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Debug ein bisschen Text
    if (msg.type === "response.output_text.delta") {
      const text = msg.delta || msg.text;
      if (text) console.log("🗣️ OpenAI Text:", text);
    }

    // Wichtiger Teil: Audio zurück
    if (msg.type === "response.audio.delta" && msg.delta) {
      const b64Audio = msg.delta; // g711_ulaw Base64

      if (telnyxWs.readyState === WebSocket.OPEN) {
        const mediaMsg = {
          event: "media",
          media: {
            payload: b64Audio,
          },
        };
        telnyxWs.send(JSON.stringify(mediaMsg));
      }
    }

    if (msg.type === "response.completed") {
      console.log("✅ OpenAI Response abgeschlossen");
    }
  });
});

// ==== SERVER STARTEN ====
httpServer.listen(PORT, () => {
  console.log("🚀 Server läuft auf Port", PORT);
  console.log("➡️ Healthcheck:", `https://${RENDER_DOMAIN}/health`);
  console.log("➡️ Outbound Call URL Beispiel:");
  console.log(
    `   https://${RENDER_DOMAIN}/call?to=%2B49123456789`
  );
});
