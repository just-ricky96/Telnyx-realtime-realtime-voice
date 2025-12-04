// server.js
import express from "express";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";

dotenv.config();

const app = express();
app.use(express.json());

// ===== ENV VARS ===================================================
const {
  OPENAI_API_KEY,
  TELNYX_API_KEY,
  TELNYX_CONNECTION_ID,
  TELNYX_FROM_NUMBER,
  RENDER_DOMAIN,
  PORT = 10000,
} = process.env;

console.log("🚀 Starte Telnyx <-> OpenAI Realtime Bridge");
console.log("ℹ️  Port:", PORT);
console.log("ℹ️  Render Domain:", RENDER_DOMAIN);

// ===== HTTP ENDPOINTS =============================================

// Healthcheck für Render
app.get("/health", (req, res) => {
  res.send("ok");
});

// Outbound Call starten: /call?to=%2B49123456789
app.get("/call", async (req, res) => {
  const to = req.query.to;

  if (!to) {
    return res.status(400).json({
      ok: false,
      error: "Missing 'to' query parameter. Use /call?to=%2B49123456789",
    });
  }

  try {
    console.log("📞 Starte Outbound Call zu:", to);

    const createResp = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify({
        connection_id: TELNYX_CONNECTION_ID,
        to,
        from: TELNYX_FROM_NUMBER,
        timeout_secs: 45,
      }),
    });

    const telnyxData = await createResp.json();
    console.log("📨 Telnyx Call Response:", JSON.stringify(telnyxData, null, 2));

    if (!createResp.ok) {
      return res.status(500).json({ ok: false, telnyx: telnyxData });
    }

    return res.json({ ok: true, telnyx: telnyxData });
  } catch (err) {
    console.error("❌ Fehler beim Starten des Calls:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Webhook für Telnyx Call Events
// In Telnyx hast du dafür eingetragen:
// https://DEIN-RENDER-DOMAIN/telnyx-webhook
app.post("/telnyx-webhook", async (req, res) => {
  try {
    const eventType = req.body.data?.event_type;
    const payload = req.body.data?.payload;
    const callControlId = payload?.call_control_id;

    console.log("📩 Telnyx Webhook Event:", eventType);

    // Wenn der Anruf angenommen wurde -> JETZT Media Stream starten
    if (eventType === "call.answered" && callControlId) {
      console.log("🎉 Call wurde angenommen – starte Media Stream…");

      try {
        const resp = await fetch(
          `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${TELNYX_API_KEY}`,
            },
            body: JSON.stringify({
              stream_url: `wss://${RENDER_DOMAIN}/media`,
              stream_track: "both_tracks",
              // G.711 μ-law -> kompatibel mit OpenAI g711_ulaw
              stream_codec: "pcmu",
            }),
          }
        );

        const json = await resp.json();
        console.log("🎧 Telnyx streaming_start Response:", json);
      } catch (err) {
        console.error("❌ Fehler bei streaming_start:", err);
      }
    }
  } catch (err) {
    console.error("❌ Fehler im Telnyx Webhook:", err);
  }

  // Telnyx erwartet immer eine Antwort
  res.json({ received: true });
});

// ===== HTTP SERVER STARTEN ========================================
const server = app.listen(PORT, () => {
  console.log(`✅ Server läuft auf Port ${PORT}`);
});

// ===== WEBSOCKET BRIDGE (TELNYX <-> OPENAI) =======================
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const path = req.url || "/";
  console.log("🌐 Neue WebSocket-Verbindung:", path);

  if (path.startsWith("/media")) {
    handleTelnyxMediaStream(ws);
  } else {
    console.log("❌ Unbekannter WS-Pfad, Verbindung wird geschlossen.");
    ws.close();
  }
});

// Telnyx Media Stream <-> OpenAI Realtime Audio Bridge
function handleTelnyxMediaStream(telnyxWs) {
  console.log("📡 Telnyx Media WebSocket verbunden");

  let currentStreamId = null;

  // Verbindung zu OpenAI Realtime
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("🤖 OpenAI Realtime verbunden");

    const sessionUpdate = {
      type: "session.update",
      session: {
        instructions:
          "Du bist ein freundlicher Telefonassistent. Sprich kurz, natürlich und hilfsbereit. Sprich immer Deutsch.",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "alloy",
        turn_detection: {
          type: "server_vad",
        },
      },
    };

    openaiWs.send(JSON.stringify(sessionUpdate));
    console.log("📤 Session-Config an OpenAI gesendet");
  });

  // ========= Telnyx -> OpenAI =========
  telnyxWs.on("message", (data, isBinary) => {
    try {
      if (isBinary) return;

      const msg = JSON.parse(data.toString("utf8"));

      if (msg.event === "start") {
        currentStreamId = msg.stream_id;
        console.log(
          "▶️ Telnyx Stream gestartet:",
          msg.start?.media || msg.start
        );
      } else if (msg.event === "media" && msg.media?.payload) {
        // base64 G.711 μ-law Audio von Telnyx
        const audioB64 = msg.media.payload;

        const openaiEvent = {
          type: "input_audio_buffer.append",
          // OpenAI erwartet base64 audio im gleichen Format wie input_audio_format
          audio: audioB64,
        };
        openaiWs.send(JSON.stringify(openaiEvent));
      } else if (msg.event === "stop") {
        console.log("⏹ Telnyx Media Stream beendet");
        openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      }
    } catch (err) {
      console.error("❌ Fehler Telnyx->OpenAI:", err);
    }
  });

  telnyxWs.on("close", () => {
    console.log("📴 Telnyx WS geschlossen");
    openaiWs.close();
  });

  telnyxWs.on("error", (err) => {
    console.error("❌ Telnyx WS Fehler:", err);
    openaiWs.close();
  });

  // ========= OpenAI -> Telnyx =========
  openaiWs.on("message", (data, isBinary) => {
    try {
      if (isBinary) return;

      const msg = JSON.parse(data.toString("utf8"));

      // Audio vom Assistenten
      if (
        msg.type === "response.audio.delta" &&
        msg.delta &&
        currentStreamId
      ) {
        // msg.delta ist base64 G.711 μ-law (g711_ulaw)
        const outbound = {
          event: "media",
          stream_id: currentStreamId,
          media: { payload: msg.delta },
        };
        telnyxWs.send(JSON.stringify(outbound));
      }

      if (msg.type === "response.completed") {
        console.log("🗣 OpenAI Antwort fertig");
      }
    } catch (err) {
      console.error("❌ Fehler OpenAI->Telnyx:", err);
    }
  });

  openaiWs.on("close", () => {
    console.log("📴 OpenAI WS geschlossen");
    telnyxWs.close();
  });

  openaiWs.on("error", (err) => {
    console.error("❌ OpenAI WS Fehler:", err);
    telnyxWs.close();
  });
}
