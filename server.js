import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

// ✔ HEALTH CHECK ENDPOINT
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "server running" });
});

// ✔ OUTBOUND CALL ENDPOINT: /call?to=+49123...
app.get("/call", async (req, res) => {
  try {
    const to = req.query.to;
    if (!to || !to.startsWith("+")) {
      return res.status(400).json({
        ok: false,
        error: "Parameter ?to= fehlt oder nicht im +E164 Format",
      });
    }

    console.log("📞 Starte Outbound Call zu:", to);

    const call = await fetch(
      "https://api.telnyx.com/v2/calls",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
        },
        body: JSON.stringify({
          connection_id: process.env.TELNYX_CONNECTION_ID,
          to,
          from: process.env.TELNYX_FROM_NUMBER,
          audio: {
            stream_url: `wss://${process.env.RENDER_DOMAIN}/media`, // Media Stream WS
          }
        }),
      }
    );

    const data = await call.json();
    console.log("📟 Telnyx Call Response:", data);

    res.json({ ok: true, telnyx: data });
  } catch (err) {
    console.error("❌ Fehler bei Outbound Call:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ✔ WEBSOCKET SERVER für MEDIA STREAMS
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (telnyxSocket) => {
  console.log("🔌 Media WebSocket verbunden (Telnyx)");

  // OPENAI REALTIME SESSION WEBSOCKET
  const openaiSocket = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17", {
    headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` }
  });

  openaiSocket.on("open", () => {
    console.log("🧠 OpenAI Realtime verbunden");

    openaiSocket.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: "Du bist ein sehr freundlicher deutscher Telefonassistent.",
        modalities: ["text", "audio"],
        audio_format: "pcm16",
        turn_detection: { type: "server_vad" }
      }
    }));
  });

  // TELNYX → OPENAI
  telnyxSocket.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.event === "media") {
        const pcm = Buffer.from(data.media.payload, "base64");
        openaiSocket.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcm.toString("base64")
        }));
      }
    } catch (e) {
      console.error("Telnyx Parse Error:", e);
    }
  });

  // OPENAI → TELNYX
  openaiSocket.on("message", (raw) => {
    const data = JSON.parse(raw.toString());

    if (data.type === "response.output_audio.delta") {
      telnyxSocket.send(
        JSON.stringify({
          event: "media",
          stream_id: "1",
          media: { payload: data.delta }
        })
      );
    }
  });

  openaiSocket.on("close", () => console.log("❌ OpenAI WS geschlossen"));
  telnyxSocket.on("close", () => console.log("❌ Telnyx WS geschlossen"));
});

// HTTP → WS UPGRADE (für /media)
app.server = app.listen(PORT, () => {
  console.log(`🚀 Server läuft auf Port ${PORT}`);
});

app.server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});
