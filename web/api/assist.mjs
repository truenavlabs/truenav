// Vercel Node function: POST /api/assist
// Key: process.env.NEARAI_API_KEY only. Never logged, never returned, never sent to the client.
import { handleAssist } from "./assist-lib.mjs";

export default async function handler(req, res) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers || {})) headers[String(k).toLowerCase()] = v;
  const result = await handleAssist({
    method: req.method,
    headers,
    body: req.body,
    socketIp: req.socket && req.socket.remoteAddress,
  });
  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  res.status(result.status).json(result.body);
}
