// server.js
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { createServer } from "http";
import WebSocket, { WebSocketServer } from "ws";

const {
  OPENAI_API_KEY,
  TELNYX_API_KEY,
  TELNYX_CONNECTION_ID,
  TELNYX_FROM_NUMBER,
  RENDER_DOMAIN,
  PORT,
} = process.env;

if (!OPENAI_API_KEY) console.error("⚠️ OPENAI_API_KEY fehlt");
if (!TELNYX_API_KEY) console.error("⚠️ TELNYX_API_KEY fehlt");
if (!TELNYX_CONNECTION_ID) console.error("⚠️ TELNYX_CONNECTION_ID fehlt");
if (!TELNYX_FROM_NUMBER) console.error("⚠️ TELNYX_FROM_NUMBER fehlt");
if (!RENDER_DOMAIN) console.error("⚠️ RENDER_DOMAIN fehlt");

const app = express();
app.use(express.json());

// Simple Health-Check
app.get("/", (_req, res) => {
  res.send("Telnyx ⇄ OpenAI Realtime Voice server läuft.");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Outbound Call Endpoint
// Beispiel: /call?to=%2B4917684473806
app.get("/call", async (req, res) => {
  const to = req.query.to;

  if (!to) {
    return res.status(400).json({
      ok: false,
      error: "Fehlender Parameter 'to' (E.164 Nummer, z.B. +49123456789)",
    });
  }

  try {
    console.log("Starte Outbound Call zu:", to);

    // 1) Outbound Call über Telnyx
    const createCallResp = await fetch("https://api.telnyx.com/v2/calls", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TELNYX_API_KEY}`,
      },
      body: JSON.stringify({
        connection_id: TELNYX_CONNECTION_ID,
        from: TELNYX_FROM_NUMBER,
        to,
      }),
    });

    const callJson = await createCallResp.json();
    console.log("Telnyx Call Response:", JSON.stringify(callJson, null, 2));

    if (!createCallResp.ok || !callJson.data) {
      return res.status(500).json({
        ok: false,
        error: "Telnyx Call fehlgeschlagen",
        telnyx: callJson,
      });
    }

    const callControlId = callJson.data.call_control_id;
    console.log("call_control_id:", callControlId);

    // 2) Media-Stream starten, damit Telnyx Audio zu unserem WS schickt
    const streamUrl = `wss://${RENDER_DOMAIN}/media`;
    console.log("Starte Media Stream zu:", streamUrl);

    const streamingResp = await fetch(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TELNYX_API_KEY}`,
        },
        body: JSON.stringify({
          stream_url: streamUrl,
          stream_track: "both_tracks", // inbound & outbound
          stream_codec: "pcmu", // G.711 μ-law
        }),
      }
    );

    const streamingJson = await streamingResp.json();
    console.log(
      "Telnyx streaming_start Response:",
      JSON.stringify(streamingJson, null, 2)
    );

    if (!streamingResp.ok) {
      return res.status(500).json({
        ok: false,
        error: "streaming_start fehlgeschlagen",
        telnyx: streamingJson,
      });
    }

    return res.json({
      ok: true,
      telnyx: {
        call: callJson,
        streaming_start: streamingJson,
      },
    });
  } catch (err) {
    console.error("Fehler bei /call:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// HTTP-Server + WebSocket-Server
const httpServer = createServer(app);

// WS-Server nur für Telnyx Media Streams
const wss = new WebSocketServer({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  const { url } = req;
  if (url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log("📡 Telnyx Media WebSocket verbunden");
      handleTelnyxMediaWebSocket(ws);
    });
  } else {
    socket.destroy();
  }
});

// Logik für eine Telnyx-Media-WebSocket-Verbindung
function handleTelnyxMediaWebSocket(telnyxWs) {
  let streamId = null;
  let openaiWs = null;
  let openaiReady = false;

  // Verbindung zu OpenAI Realtime aufbauen
  function connectOpenAI() {
    console.log("🔗 Verbinde zu OpenAI Realtime …");

    openaiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    openaiWs.on("open", () => {
      console.log("✅ OpenAI Realtime verbunden");
      openaiReady = true;

      // Session konfigurieren – STS mit μ-law
      const sessionUpdate = {
        type: "session.update",
        session: {
          // wichtig: Audio-Formate auf μ-law 8k stellen
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          instructions:
            "Du bist ein freundlicher, hilfsbereiter deutscher Telefonassistent. " +
            "Sprich kurz und natürlich, wie ein menschlicher Callcenter-Mitarbeiter.",
          turn_detection: {
            type: "server_vad",
          },
        },
      };

      openaiWs.send(JSON.stringify(sessionUpdate));
    });

    openaiWs.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        console.error("Fehler beim Parsen von OpenAI-Event:", e);
        return;
      }

      // Debug bei Bedarf:
      // console.log("OpenAI Event:", msg.type);

      // Audio von OpenAI → zurück in den Call schicken
      if (msg.type === "response.audio.delta") {
        if (!streamId) return; // warten bis Start-Event von Telnyx da ist

        const base64Audio = msg.delta; // g711 μ-law (8k)
        const telnyxMediaMsg = {
          event: "media",
          stream_id: streamId,
          media: {
            payload: base64Audio,
          },
        };

        try {
          telnyxWs.send(JSON.stringify(telnyxMediaMsg));
        } catch (err) {
          console.error("Fehler beim Senden von Audio an Telnyx:", err);
        }
      }

      // Optionale Logs für Text / Transkripte
      if (msg.type === "response.output_text.delta") {
        console.log("Assistant Text (delta):", msg.delta);
      }
      if (msg.type === "response.output_text.done") {
        console.log("Assistant Text (done):", msg.text);
      }
      if (msg.type === "response.output_audio_transcript.delta") {
        console.log("Assistant Audio Transcript (delta):", msg.delta);
      }
      if (msg.type === "response.output_audio_transcript.done") {
        console.log("Assistant Audio Transcript (done):", msg.transcript);
      }
    });

    openaiWs.on("close", () => {
      console.log("❌ OpenAI Realtime Verbindung geschlossen");
      openaiReady = false;
    });

    openaiWs.on("error", (err) => {
      console.error("OpenAI WebSocket Fehler:", err);
      openaiReady = false;
    });
  }

  connectOpenAI();

  // Telnyx → Server Events
  telnyxWs.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      console.error("Fehler beim Parsen von Telnyx-Event:", e);
      return;
    }

    const { event } = msg;

    if (event === "start") {
      streamId = msg.stream_id;
      const media = msg.media || {};
      console.log(
        "Telnyx WS event: start",
        JSON.stringify(
          {
            streamId,
            channels: media.channels,
            encoding: media.encoding,
            sample_rate: media.sample_rate,
          },
          null,
          2
        )
      );
    }

    if (event === "media") {
      if (!openaiReady || !openaiWs) return;

      const payload = msg.media && msg.media.payload;
      if (!payload) return;

      // Telnyx schickt PCMU (μ-law) 8k Base64 → 1:1 an OpenAI
      const openaiEvent = {
        type: "input_audio_buffer.append",
        audio: payload,
      };

      try {
        openaiWs.send(JSON.stringify(openaiEvent));
      } catch (err) {
        console.error("Fehler beim Senden von Audio an OpenAI:", err);
      }
    }

    if (event === "stop") {
      console.log("Telnyx WS event: stop");
      // Verbindung wird gleich geschlossen
    }
  });

  telnyxWs.on("close", () => {
    console.log("❌ Telnyx Media WebSocket geschlossen");
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  telnyxWs.on("error", (err) => {
    console.error("Telnyx WebSocket Fehler:", err);
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });
}

// Server starten
const port = Number(PORT) || 10000;
httpServer.listen(port, () => {
  console.log(`🚀 Server läuft auf Port ${port}`);
  console.log(`   Healthcheck: https://${RENDER_DOMAIN}/health`);
  console.log(`   Call starten: https://${RENDER_DOMAIN}/call?to=%2B49123456789`);
});
