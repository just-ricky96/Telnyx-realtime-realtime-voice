/**
 * Telnyx ↔ OpenAI Realtime Speech-to-Speech Server
 * - Outbound Call via Telnyx Voice API
 * - Media Streaming über WebSocket zu OpenAI Realtime
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
const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID;
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER;

if (!TELNYX_API_KEY || !OPENAI_API_KEY || !RENDER_DOMAIN) {
  console.error("❌ Missing required env vars (TELNYX_API_KEY / OPENAI_API_KEY / RENDER_DOMAIN)");
}
if (!TELNYX_CONNECTION_ID || !TELNYX_FROM_NUMBER) {
  console.error("❌ Missing TELNYX_CONNECTION_ID or TELNYX_FROM_NUMBER (needed for outbound)");
}

// ----------------------------
// Express + HTTP server
// ----------------------------
const app = express();
app.use(express.json());
const server = http.createServer(app);

app.get("/", (_req, res) => {
  res.send("OK - STS Telefonagent läuft (outbound)");
});

// ----------------------------
// 1) Outbound Call starten
//    GET /call?to=+49123456789
// ----------------------------
app.get("/call", async (req, res) => {
  const to = req.query.to;

  if (!to) {
    return res
      .status(400)
      .send("Bitte Zielnummer als Query angeben, z.B. /call?to=+49123456789");
  }

  try {
    console.log("Starte Outbound Call zu:", to);

    const response = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TELNYX_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        to,
        from: TELNYX_FROM_NUMBER,
        connection_id: TELNYX_CONNECTION_ID,
        // damit Webhooks sicher bei uns landen:
        webhook_url: `https://${RENDER_DOMAIN}/telnyx-webhook`,
      }),
    });

    const data = await response.json();
    console.log("Outbound Call response:", JSON.stringify(data, null, 2));

    if (!response.ok) {
      return res.status(500).json({
        ok: false,
        error: data,
      });
    }

    res.json({
      ok: true,
      telnyx_response: data,
    });
  } catch (err) {
    console.error("Fehler beim Outbound Call:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ----------------------------
// 2) Telnyx Webhook → streaming_start
// ----------------------------
app.post("/telnyx-webhook", async (req, res) => {
  try {
    const data = req.body.data;
    const eventType = data?.event_type;
    const payload = data?.payload;
    const callControlId = payload?.call_control_id;

    console.log("Webhook:", eventType);

    // Sobald der Call (inbound oder outbound) beantwortet ist:
    if (eventType === "call.answered" && callControlId) {
      console.log("Starte Media Stream für Call:", callControlId);

      const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          stream_url: `wss://${RENDER_DOMAIN}/media`,
          stream_track: "both",
        }),
      });

      const json = await response.json();
      console.log("streaming_start response:", JSON.stringify(json, null, 2));
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Fehler im Webhook-Handler:", err);
    res.status(500).json({ ok: false });
  }
});

// ------------------------------------------------------
// 3) WebSocket Telnyx ↔ OpenAI Realtime
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

    // Session konfigurieren (G.711 µ-law passt zum Telnyx-Stream)
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          instructions:
            "Du bist ein natürlicher, freundlicher deutschsprachiger Telefonassistent. Sprich kurz und menschlich.",
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
              text: "Hallo, hier ist dein Assistent. Wie kann ich dir helfen?",
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

    // Ende einer Sprechpause – neue Antwort anfordern
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
