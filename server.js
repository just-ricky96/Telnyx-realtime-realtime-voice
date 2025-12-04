import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import WebSocket, { WebSocketServer } from "ws";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

const {
  TELNYX_API_KEY,
  TELNYX_CONNECTION_ID,
  TELNYX_FROM_NUMBER,
  OPENAI_API_KEY,
  RENDER_DOMAIN
} = process.env;

console.log("🚀 Server starting with domain:", RENDER_DOMAIN);

// -------------------------------
// HEALTHCHECK
// -------------------------------
app.get("/health", (req, res) => {
  res.send("OK");
});

// -------------------------------
// OUTBOUND CALL ROUTE
// -------------------------------
app.get("/call", async (req, res) => {
  const to = req.query.to;
  if (!to) return res.json({ ok: false, error: "missing ?to=" });

  console.log("📞 Starte Outbound Call zu:", to);

  try {
    const telnyxResp = await axios.post(
      "https://api.telnyx.com/v2/calls",
      {
        connection_id: TELNYX_CONNECTION_ID,
        to,
        from: TELNYX_FROM_NUMBER,

        // ------------------------------------
        // 🔥 HIER aktivieren wir Media Streaming
        // ------------------------------------
        stream_url: `wss://${RENDER_DOMAIN}/media`,
        stream_track: "both_tracks",
        stream_codec: "PCMU" // ← **WICHTIG: Muss groß sein!**
      },
      {
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("📡 Telnyx Call Response:", telnyxResp.data);
    res.json({ ok: true, telnyx: telnyxResp.data });

  } catch (err) {
    console.error("❌ Fehler beim Outbound Call:", err.response?.data || err);
    res.json({ ok: false, error: err.response?.data || err });
  }
});

// -------------------------------
// WEBHOOK: call.answered
// -------------------------------
app.post("/webhook", async (req, res) => {
  const event = req.body.data?.event_type;
  console.log("📩 Telnyx Webhook Event:", event);

  if (event === "call.answered") {
    const call_control_id = req.body.data.payload.call_control_id;
    console.log("📞 call answered – starte Media Stream...");

    try {
      const startStream = await axios.post(
        `https://api.telnyx.com/v2/calls/${call_control_id}/actions/streaming_start`,
        {
          stream_url: `wss://${RENDER_DOMAIN}/media`,
          stream_track: "both_tracks",
          stream_codec: "PCMU"
        },
        {
          headers: {
            Authorization: `Bearer ${TELNYX_API_KEY}`,
            "Content-Type": "application/json"
          }
        }
      );

      console.log("🎧 Telnyx streaming_start Response:", startStream.data);

    } catch (err) {
      console.log("❌ Fehler streaming_start:", err.response?.data || err);
    }
  }

  res.json({ received: true });
});

// -------------------------------
// MEDIA STREAM WEBSOCKET
// -------------------------------
const wss = new WebSocketServer({ noServer: true });
let openaiWS = null;

wss.on("connection", (ws) => {
  console.log("🔌 Telnyx Media WebSocket verbunden");

  ws.on("message", async (raw) => {
    let message;

    try {
      message = JSON.parse(raw);
    } catch (e) {
      return console.log("⚠ Ungültiges Telnyx WS Paket");
    }

    // -----------------------
    // AUDIO FROM CALL → OPENAI
    // -----------------------
    if (message.event === "media") {
      const audioBase64 = message.media.payload;

      if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: audioBase64
        }));
      }
    }

    if (message.event === "start") {
      console.log("🎤 Telnyx WS: start", message);
    }
  });

  ws.on("close", () => {
    console.log("🔌 Telnyx WebSocket geschlossen");
  });

  // ---------------------------
  // OPENAI REALTIME verbinden
  // ---------------------------
  openaiWS = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-mini-tts",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWS.on("open", () => {
    console.log("🤖 OpenAI Realtime verbunden");

    // Start-Event, damit OpenAI direkt spricht
    openaiWS.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: "Du bist ein freundlicher deutscher Telefonassistent.",
      }
    }));
  });

  // ---------------------------
  // AUDIO VON OPENAI → CALL
  // ---------------------------
  openaiWS.on("message", (msg) => {
    const event = JSON.parse(msg);

    if (event.type === "response.audio.delta") {
      const audioChunk = event.delta;

      ws.send(JSON.stringify({
        event: "media",
        media: { payload: audioChunk }
      }));
    }
  });
});

// -------------------------------
// UPGRADE (WebSocket Routing)
// -------------------------------
const server = app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req)
    );
  } else {
    socket.destroy();
  }
});
