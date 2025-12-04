import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import WebSocket, { WebSocketServer } from "ws";  // <== WICHTIG

dotenv.config();

const app = express();
app.use(express.json());

// ENV Variablen
const PORT = process.env.PORT || 10000;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID;
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER;
const RENDER_DOMAIN = process.env.RENDER_DOMAIN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

console.log("Starte Server…");

// ----------------------------------------
// HEALTH CHECK
// ----------------------------------------
app.get("/health", (req, res) => {
  res.send("OK");
});

// ----------------------------------------
// OUTBOUND CALL START
// ----------------------------------------
app.get("/call", async (req, res) => {
  try {
    const toNumber = req.query.to;

    console.log("📞 Starte Outbound Call zu:", toNumber);

    const response = await axios.post(
      "https://api.telnyx.com/v2/calls",
      {
        connection_id: TELNYX_CONNECTION_ID,
        to: toNumber,
        from: TELNYX_FROM_NUMBER,
        webhook_url: `https://${RENDER_DOMAIN}/telnyx-webhook`
      },
      {
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`
        }
      }
    );

    console.log("📡 Telnyx Call Response:", response.data);

    res.json({ ok: true, telnyx: response.data });
  } catch (err) {
    console.error("❌ Fehler beim Call:", err.response?.data || err);
    res.json({ ok: false, error: err.response?.data || err });
  }
});

// ----------------------------------------
// TELNYX WEBHOOK
// ----------------------------------------
app.post("/telnyx-webhook", async (req, res) => {
  const event = req.body?.data?.event_type;
  const payload = req.body?.data?.payload;

  console.log("📨 Telnyx Webhook Event:", event);

  // ANRUFER HAT DEN CALL BEANTWORTET
  if (event === "call.answered") {
    console.log("📞 Call wurde angenommen – starte Media Stream…");

    const callControlId = payload.call_control_id;

    await axios.post(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/stream_start`,
      {
        stream_url: `wss://${RENDER_DOMAIN}/media`
      },
      {
        headers: { Authorization: `Bearer ${TELNYX_API_KEY}` }
      }
    );

    console.log("🎧 Media Stream gestartet!");
  }

  res.json({ received: true });
});

// ----------------------------------------
// MEDIA STREAM → OPENAI REALTIME
// ----------------------------------------
const server = app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});

// WebSocket-Server für Telnyx Media
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", async (mediaWS) => {
  console.log("🎤 Telnyx Media WebSocket verbunden");

  // OPENAI REALTIME WS VERBINDEN
  const openaiWS = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
    }
  );

  openaiWS.on("open", () => {
    console.log("🤖 OpenAI Realtime verbunden");
  });

  // AUDIO → OPENAI PIPE
  mediaWS.on("message", (msg) => {
    openaiWS.send(msg);
  });

  // AUDIO VON OPENAI → ZURÜCK AN TELNYX PIPE
  openaiWS.on("message", (msg) => {
    mediaWS.send(msg);
  });

  openaiWS.on("close", () => {
    console.log("❌ OpenAI WS geschlossen");
    mediaWS.close();
  });

  mediaWS.on("close", () => {
    console.log("❌ Telnyx WS geschlossen");
    openaiWS.close();
  });

  openaiWS.on("error", (err) => {
    console.error("OpenAI WS Fehler:", err);
  });

  mediaWS.on("error", (err) => {
    console.error("Telnyx Media WS Fehler:", err);
  });
});
