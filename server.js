import dotenv from "dotenv";
import WebSocket from "ws";
import http from "http";

dotenv.config();

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("OK - Telnyx <-> OpenAI Realtime bridge läuft");
});

server.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
