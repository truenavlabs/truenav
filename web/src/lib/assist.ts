// Client for POST /api/assist. Falls back to null so the help bubble can show FAQ hits.
export type ChatTurn = { role: "user" | "assistant"; content: string };

export async function askAssist(
  question: string,
  page: string,
  history: ChatTurn[] = [],
): Promise<{ answer: string; sources: string[] } | null> {
  const message = question.trim().slice(0, 1000);
  if (!message) return null;
  // Stay inside the server limits in web/api/_assist-lib.mjs (8 turns, 2000 UTF-8 bytes each, 8000 bytes total).
  const enc = new TextEncoder();
  const trimmed: ChatTurn[] = [];
  let total = 0;
  for (const turn of history.slice(-8).reverse()) {
    let content = turn.content.slice(0, 2000);
    while (enc.encode(content).length > 2000) content = content.slice(0, -50);
    const bytes = enc.encode(content).length;
    if (total + bytes > 8000) break;
    total += bytes;
    trimmed.unshift({ role: turn.role, content });
  }
  try {
    const res = await fetch("/api/assist", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ message, history: trimmed, page }),
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!data || typeof data !== "object") return null;
    const answer = (data as { answer?: unknown }).answer;
    if (typeof answer !== "string" || !answer.trim()) return null;
    const raw = (data as { sources?: unknown }).sources;
    const sources = Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && s.length > 0) : [];
    return { answer: answer.trim(), sources: sources.length ? sources : ["TrueNav FAQ"] };
  } catch {
    return null;
  }
}
