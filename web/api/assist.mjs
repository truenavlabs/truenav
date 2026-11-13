// Vercel Node function: POST /api/assist
// Key: process.env.NEARAI_API_KEY only. Never logged, never returned, never sent to the client.
// Errors return a short JSON message. No stack trace, prompt or provider text is ever returned.
import { BAD_JSON, MAX_BODY_BYTES, handleAssist, internalError, logAssist } from "./assist-lib.mjs";

/** Read req.body without letting the platform parser throw. Bad JSON becomes a marker (400). */
function readBody(req, headers) {
  const declared = Number(headers["content-length"]);
  // Skip parsing an oversized body; handleAssist answers 413 from the content-length header.
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  try {
    return req.body;
  } catch {
    return { [BAD_JSON]: true };
  }
}

export default async function handler(req, res) {
  let result;
  try {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) headers[String(k).toLowerCase()] = v;
    result = await handleAssist({
      method: req.method,
      headers,
      body: readBody(req, headers),
      socketIp: req.socket && req.socket.remoteAddress,
    });
  } catch (err) {
    logAssist({ type: "internal", status: 500, errorName: err && err.name ? String(err.name).slice(0, 40) : "Error" });
    result = internalError();
  }
  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  res.status(result.status).json(result.body);
}
