/**
 * Telnyx ↔ OpenAI Realtime Speech-to-Speech Server (Outbound)
 *
 * Flow:
 * - GET /call?to=%2B49...  → Telnyx /v2/calls mit Media Streaming
 * - Telnyx baut WebSocket zu wss://<RENDER_DOMAIN>/media auf
 * - Wir streamen Audio Telnyx <-> OpenAI Realtime (g711_ulaw)
 * - KI ist freundlicher deutscher Telefonassistent
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

console.log("ENV Check:", {
  TELNYX_API_KEY_set: !!TELNYX_API_KEY,
  TELNYX_CONNECTION_ID,
  TELNYX_FROM_NUMBER,
  RENDER_DOMAIN,
  OPENAI_API_KEY_set: !!OPENAI_API_KEY,
});

// === Express / HTTP Server ===
const app = express();
app.use(express.json());
const server = http.createServer(app);

app.get("/", (_req, res) => {
  res.send("OK – Telnyx ↔ OpenAI Realtime STS (Outbound) läuft.");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * 1) OUTBOUND CALL STARTEN
 *    Aufruf im Browser:
 *    https://DEIN-RENDER-DOMAIN/call?to=%2B4917...
 */
app.get("/call", async (req, res) => {
  let to = req.query.to;

  if (!to) {
    return res
      .status(400)
      .json({ ok: false, error: "Fehlende Zielnummer: /call?to=%2B49..." });
  }

  // Minimale Bereinigung (falls jemand +4917... ohne Encoding schickt)
  to = String(to).trim();

  if (!TELNYX_API_KEY || !TELNYX_CONNECTION_ID || !TELNYX_FROM_NUMBER) {
    return res.status(500).json({
      ok: false,
      error:
        "Telnyx ENV Variablen fehlen (TELNYX_API_KEY, TELNYX_CONNECTION_ID, TELNYX_FROM_NUMBER).",
    });
  }

  try {
    console.log("📞 Starte Outbound Call zu:", to);

    // Wichtig: hier hängen wir direkt den Media-Stream dran
    const body = {
      to,
      from: TELNYX_FROM_NUMBER,
      connection_id: TELNYX_CONNECTION_ID,
      stream_url: `wss://${RENDER_DOMAIN}/media`,
      stream_track: "both_tracks",
      stream_bidirectional_mode: "rtp",
      stream_bidirectional_codec: "PCMU", // passt zu g711_ulaw
    };

    const response = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    console.log("Telnyx /v2/calls response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return res.status(response.status).json({ ok: false, error: data });
    }

    return res.json({ ok: true, telnyx: data });
  } catch (err) {
    console.error("Fehler beim Outbound Call:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * 2) MEDIA WEBSOCKET
 *    Telnyx verbindet sich hierhin nach Call-Setup:
 *    wss://<RENDER_DOMAIN>/media
 *
 *    Wir koppeln Telnyx <-> OpenAI Realtime (Duplex Audio)
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
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  // Flag, ob Session bereit ist
  let openaiReady = false;

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
            "Du bist ein freundlicher, natürlicher deutschsprachiger Telefonassistent. Antworte kurz, direkt und hilfsbereit. Sprich wie ein echter Mensch am Telefon.",
          turn_detection: { type: "server_vad" },
        },
      })
    );

    // Begrüßungs-Message vorbereiten
    openaiWs.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Hallo, hier ist der Assistent. Wie kann ich Ihnen helfen?",
            },
          ],
        },
      })
    );
    openaiWs.send(JSON.stringify({ type: "response.create" }));

    openaiReady = true;
  });

  // OpenAI → Telnyx (Audio aus KI zum Anrufer)
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
        media: { payload: msg.delta.audio },
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

    // Debug Events
    if (msg.event === "connected") {
      console.log("Telnyx WS event: connected");
    }
    if (msg.event === "start") {
      console.log("Telnyx WS event: start", msg.start?.media_format);
    }

    // Audio vom Caller
    if (msg.event === "media" && msg.media?.payload) {
      if (!openaiReady) return;
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        })
      );
    }

    // Telnyx schickt "stop", wenn ein Media-Chunk-Block fertig ist
    if (msg.event === "stop") {
      if (!openaiReady) return;
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.commit",
        })
      );
      openaiWs.send(
        JSON.stringify({
          type: "response.create",
        })
      );
    }
  });

  const cleanup = () => {
    console.log("🧹 Cleanup Telnyx/OpenAI WebSockets");
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
