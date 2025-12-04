/**
 * Telnyx ↔ OpenAI Realtime Speech-to-Speech Server
 */

import dotenv from "dotenv";
import express from "express";
import http from "http";
import fetch from "node-fetch";
import { WebSocketServer } from "ws";
import WebSocket from "ws";

dotenv.config();

const PORT = process.env.PORT || 10000;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const RENDER_DOMAIN = process.env.RENDER_DOMAIN;

// ----------------------------
// Express + HTTP server
// ----------------------------
const app = express();
app.use(express.json());
const server = http.createServer(app);

app.get("/", (_req, res) => {
  res.send("OK - STS Telefonagent läuft");
});

// ----------------------------
// 1) Telnyx Webhook → streaming_start
// ----------------------------
app.post("/telnyx-webhook", async (req, res) => {
  try {
    const data = req.body.data;
    const eventType = data?.event_type;
    const payload = data?.payload;
    const callControlId = payload?.call_control_id;

    console.log("Webhook:", eventType);

    // Wenn der Call beantwortet ist, Media Streaming starten
    if (eventType === "call.answered" && callControlId) {
      console.log("Starte Media Stream für Call:", callControlId);

      const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          stream_track: "both",
          stream_url: `wss://${RENDER_DOMAIN}/media`,
        }),
      });

      const json = await response.json();
      console.log("streaming_start response:", json);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Fehler im Webhook-Handler:", err);
    res.status(500).json({ ok: false });
  }
});

// ------------------------------------------------------
// 2) WebSocket Telnyx ↔ OpenAI Realtime
// ------------------------------------------------------
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (telnyxWs) => {
  console.log("Media WebSocket verbunden (Telnyx)");

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

  openaiWs.on("open", () => {
    console.log("OpenAI Realtime verbunden");

    // Session konfigurieren
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          instructions:
            "Du bist ein natürlicher, freundlicher Telefonassistent. Sprich kurz und menschlich.",
          turn_detection: { type: "server_vad" },
        },
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
              text: "Hallo, hier ist der Assistent. Wie kann ich helfen?",
            },
          ],
        },
      })
    );
    openaiWs.send(JSON.stringify({ type: "response.create" }));
  });

  // Audio OUT von OpenAI → Telnyx
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

  // Audio IN von Telnyx → OpenAI
  telnyxWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        })
      );
    }

    if (msg.event === "stop") {
      openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      openaiWs.send(JSON.stringify({ type: "response.create" }));
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

// ----------------------------
server.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
