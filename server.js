import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ---------------------
// OUTBOUND CALL START
// ---------------------
app.get("/call", async (req, res) => {
  const to = req.query.to;
  const from = process.env.TELNYX_FROM_NUMBER;
  const connectionId = process.env.TELNYX_CONNECTION_ID;
  const apiKey = process.env.TELNYX_API_KEY;

  if (!to) return res.json({ ok: false, error: "Missing ?to= parameter" });

  const body = {
    connection_id: connectionId,
    to: to,
    from: from,
    audio: {
      stream_url: `wss://${process.env.RENDER_DOMAIN}/media`
    }
  };

  const response = await fetch("https://api.telnyx.com/v2/calls/outbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();
  console.log("Outbound Call Response:", JSON.stringify(data, null, 2));

  res.json({ ok: true, telnyx: data });
});

// ---------------------
// MEDIA STREAMS (DUPLEX)
// ---------------------
const wss = new WebSocketServer({ noServer: true });

let telnyxSocket = null;
let openaiSocket = null;

async function connectToOpenAI() {
  return new Promise((resolve) => {
    const socket = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1"
        }
      }
    );

    socket.on("open", () => {
      console.log("OpenAI Realtime verbunden");

      // Initial Prompt + "Start talking"
      socket.send(
        JSON.stringify({
          type: "response.create",
          response: {
            instructions:
              "Du bist ein sehr freundlicher Telefonassistent. Begrüße den Anrufer und frage, wie du helfen kannst.",
            modalities: ["audio"],
            audio: { voice: "alloy" }
          }
        })
      );

      resolve(socket);
    });

    socket.on("message", (msg) => {
      const data = JSON.parse(msg);
      if (
        data.type === "response.audio.delta" &&
        telnyxSocket &&
        telnyxSocket.readyState === WebSocket.OPEN
      ) {
        telnyxSocket.send(
          JSON.stringify({
            type: "media",
            data: Buffer.from(data.delta, "base64").toString("base64")
          })
        );
      }
    });
  });
}

// ---------------------
// UPGRADE WEBSOCKET
// ---------------------
const server = app.listen(PORT, () =>
  console.log("Server läuft auf Port", PORT)
);

server.on("upgrade", async (req, socket, head) => {
  if (req.url === "/media") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
});

// ---------------------
// WS: MEDIA CONNECTION
// ---------------------
wss.on("connection", async (ws) => {
  console.log("Media WebSocket verbunden (Telnyx)");
  telnyxSocket = ws;

  // Connect to OpenAI
  openaiSocket = await connectToOpenAI();

  ws.on("message", (msg) => {
    const data = JSON.parse(msg);

    if (data.type === "media" && openaiSocket) {
      openaiSocket.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: data.data
        })
      );
    }

    if (data.type === "media" && data.event === "stop") {
      openaiSocket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
  });

  ws.on("close", () => {
    console.log("Telnyx Verbindung geschlossen");
    if (openaiSocket) openaiSocket.close();
  });
});
