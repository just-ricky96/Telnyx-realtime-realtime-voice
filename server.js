/**
 * Telnyx ↔ OpenAI Realtime Speech-to-Speech Server (Outbound)
 *
 * Features:
 * - Outbound Call via Telnyx /v2/calls (GET /call?to=+49...)
 * - Webhook /telnyx-webhook → streaming_start
 * - Media WebSocket /media
 * - OpenAI Realtime (gpt-4o-realtime-preview)
 * - Voller Duplex: Caller spricht -> AI hört -> AI spricht zurück
 * - Persona: freundlicher deutscher Telefonassistent
 */

import dotenv from "dotenv";
import express from "express";
import http from "http";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import WebSocket from "ws";

dotenv.config();

// === ENV VARS ===
const PORT = process.env.PORT || 10000;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID;
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER;
const RENDER_DOMAIN = process.env.RENDER_DOMAIN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!TELNYX_API_KEY || !TELNYX_CONNECTION_ID || !TELNYX_FROM_NUMBER || !RENDER_DOMAIN || !OPENAI_API_KEY) {
  console.warn("⚠️ Achtung: Eine oder mehrere ENV Variablen fehlen!");
}

// === Express / HTTP Server ===
const app = express();
app.use(express.json());
const server = http.createServer(app);

app.get("/", (_req, res) => {
  res.send("OK – Telnyx ↔ OpenAI Realtime STS läuft.");
});

// Healthcheck
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Debug (optional)
app.get("/debug/env", (_req, res) => {
  res.json({
    PORT,
    TELNYX_API_KEY_prefix: TELNYX_API_KEY ? TELNYX_API_KEY.slice(0, 4) : null,
    TELNYX_API_KEY_length: TELNYX_API_KEY ? TELNYX_API_KEY.length : 0,
    TELNYX_CONNECTION_ID,
    TELNYX_FROM_NUMBER,
    RENDER_DOMAIN,
    OPENAI_API_KEY_set: !!OPENAI_API_KEY
  });
});

/**
 * 1) OUTBOUND CALL
 *    GET /call?to=+49DEINENUMMER
 */
app.get("/call", async (req, res) => {
  const to = req.query.to;

  if (!to) {
    return res
      .status(400)
      .json({ ok: false, error: "Fehlende Zielnummer: /call?to=+49..." });
  }

  if (!TELNYX_API_KEY || !TELNYX_CONNECTION_ID || !TELNYX_FROM_NUMBER) {
    return res.status(500).json({
      ok: false,
      error:
        "Telnyx ENV Variablen fehlen (TELNYX_API_KEY, TELNYX_CONNECTION_ID, TELNYX_FROM_NUMBER)."
    });
  }

  try {
    console.log("📞 Starte Outbound Call zu:", to);

    const response = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        to,
        from: TELNYX_FROM_NUMBER,
        connection_id: TELNYX_CONNECTION_ID,
        webhook_url: `https://${RENDER_DOMAIN}/telnyx-webhook`
      })
    });

    const data = await response.json();
    console.log("Telnyx /v2/calls response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return res
        .status(response.status)
        .json({ ok: false, error: data });
    }

    return res.json({ ok: true, telnyx: data });
  } catch (err) {
    console.error("Fehler beim Outbound Call:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * 2) TELNYX WEBHOOK
 *    - hört auf call.answered
 *    - startet Media Streaming auf wss://<RENDER_DOMAIN>/media
 */
app.post("/telnyx-webhook", async (req, res) => {
  try {
    const event = req.body?.data;
    const eventType = event?.event_type;
    const payload = event?.payload;
    const callControlId = payload?.call_control_id;

    console.log("🔔 Webhook:", eventType);

    if (eventType === "call.answered" && callControlId) {
      console.log("🎧 Starte Media Stream für Call:", callControlId);

      const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify({
          stream_url: `wss://${RENDER_DOMAIN}/media`,
          stream_track: "both"
        })
      });

      const json = await response.json();
      console.log(
        "Telnyx streaming_start response:",
        JSON.stringify(json, null, 2)
      );
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Fehler im Webhook:", err);
    res.status(500).json({ ok: false });
  }
});

/**
 * 3) MEDIA WEBSOCKET
 *    Pfad: wss://<RENDER_DOMAIN>/media
 *
 *    Telnyx <-> OpenAI Duplex Audio
 */

const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (telnyxWs) => {
  console.log("🔗 Media WebSocket verbunden (Telnyx)");

  // Verbindung zu OpenAI Realtime
  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  openaiWs.on("open", () => {
    console.log("✅ OpenAI Realtime verbunden");

    // Session konfigurieren: G.711 μ-law in/out
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          instructions:
            "Du bist ein freundlicher, natürlicher deutschsprachiger Telefonassistent. Antworte kurz und direkt, wie ein echter Mensch am Telefon. Stelle Rückfragen, wenn etwas unklar ist.",
          turn_detection: { type: "server_vad" }
        }
      })
    );

    // Begrüßung
    openaiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Hallo, hier ist der Assistent. Wie kann ich Ihnen helfen?"
            }
          ]
        }
      })
    );
    openaiWs.send(JSON.stringify({ type: "response.create" }));
  });

  // OpenAI → Telnyx (Audio nach draußen)
  openaiWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "response.audio.delta" && msg.delta?.audio) {
      const out = {
        event: "media",
        media: { payload: msg.delta.audio }
      };
      telnyxWs.send(JSON.stringify(out));
    }
  });

  // Telnyx → OpenAI (Audio vom Anrufer)
  telnyxWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Audio vom Caller
    if (msg.event === "media" && msg.media?.payload) {
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload
        })
      );
    }

    // Sprechpause / STOP von Telnyx -> neue Antwort erzeugen
    if (msg.event === "stop") {
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.commit"
        })
      );
      openaiWs.send(
        JSON.stringify({
          type: "response.create"
        })
      );
    }
  });

  const cleanup = () => {
    try {
      telnyxWs.close();
    } catch {}
    try {
      openaiWs.close();
    } catch {}
  };

  telnyxWs.on("close", cleanup);
  telnyxWs.on("error", cleanup);
  openaiWs.on("close", cleanup);
  openaiWs.on("error", cleanup);
});

// === Server starten ===
server.listen(PORT, () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});
