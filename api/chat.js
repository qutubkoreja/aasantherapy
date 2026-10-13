// Vercel serverless function.
// FREE: set GEMINI_API_KEY (get one free at aistudio.google.com). Optional: ANTHROPIC_API_KEY (paid).
// Add keys in Vercel > Settings > Environment Variables.
const SYSTEM = `You are AasanTherapy, a warm, psychology-informed support companion for people struggling with low mood, anxiety, stress, loneliness and similar difficulties. Many users cannot afford therapy.

How you help:
- Listen first. Reflect feelings in plain, gentle language before offering anything.
- Use evidence-based skills in small steps: CBT (spotting and gently questioning unhelpful thoughts), behavioural activation, grounding (5-4-3-2-1), slow breathing, sleep and routine basics, journaling, self-compassion, problem-solving.
- Keep replies short (under 150 words), warm, and conversational. Ask at most one question at a time. No long lists.
- Reply in the same language the user writes in (English, Urdu, Roman Urdu, Arabic, etc.).

Boundaries:
- You are not a doctor or therapist. Never diagnose, never advise on starting, stopping or changing medication.
- If symptoms are severe, long-lasting, or affect daily life, encourage seeing a doctor or counsellor, and mention low-cost options (government hospitals, community or NGO counselling, helplines, trusted family or friends).
- If the user mentions suicide, self-harm, abuse, or being in danger: respond with calm care, take it seriously, ask if they are safe right now, urge them to contact local emergency services or a crisis line and a trusted person nearby, and stay with them in the conversation. Do not give methods. Do not argue about their wish to die; acknowledge their pain and encourage immediate human support.

Islamic touch (gentle, optional):
- Many users are Muslim. Where it fits naturally, you may offer a short, authentic reminder from the Quran or a well-known dua, or mention patience (sabr), trust in Allah (tawakkul), prayer, dhikr, and gratitude, as comfort alongside practical steps.
- Never invent or misquote verses, hadith or scholars. If unsure, speak in general terms. Do not issue religious rulings (fatwas).
- Never imply that depression or anxiety means weak faith or is a punishment. Seeking treatment and counselling is encouraged and compatible with faith.
- If the user is not Muslim or prefers a non-religious approach, respect that fully and keep to psychology only. Do not push religion.

Be respectful, never judgmental, and never promise outcomes.`;

const hits = new Map(); // best-effort rate limit per instance
function limited(ip){
  const now = Date.now(), win = 60_000, max = 8;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  arr.push(now); hits.set(ip, arr);
  return arr.length > max;
}

const FALLBACK = "I'm here with you. I couldn't put that into words just now, but what you're feeling matters. If you're in danger or thinking of hurting yourself, please contact your local emergency number or a crisis line and tell someone near you right now. Would you like to tell me more about what's going on?";

async function callGemini(key, msgs){
  const model = process.env.MODEL || "gemini-2.5-flash-lite";
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: msgs.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: 800, temperature: 0.7 }
    })
  });
  const data = await r.json();
  if (r.status === 429) return { busy: true };
  if (!r.ok) return { error: true };
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return { reply: parts.map(p => p.text || "").join("").trim() };
}

async function callClaude(key, msgs){
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: process.env.MODEL || "claude-haiku-5-5", max_tokens: 600, system: SYSTEM, messages: msgs })
  });
  const data = await r.json();
  if (r.status === 429) return { busy: true };
  if (!r.ok) return { error: true };
  return { reply: (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim() };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const gKey = process.env.GEMINI_API_KEY, aKey = process.env.ANTHROPIC_API_KEY;
  if (!gKey && !aKey) return res.status(500).json({ error: "Server is missing GEMINI_API_KEY." });
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || "x";
  if (limited(ip)) return res.status(429).json({ error: "Too many messages. Please wait a minute." });

  let msgs = req.body && req.body.messages;
  if (!Array.isArray(msgs) || !msgs.length) return res.status(400).json({ error: "No messages." });
  msgs = msgs.slice(-20)
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  if (!msgs.length) return res.status(400).json({ error: "Invalid messages." });

  try {
    const out = gKey ? await callGemini(gKey, msgs) : await callClaude(aKey, msgs);
    if (out.busy) return res.status(429).json({ error: "AasanTherapy is very busy right now. Please try again in a minute." });
    if (out.error) return res.status(502).json({ error: "The AI service had a problem. Please try again." });
    return res.status(200).json({ reply: out.reply || FALLBACK });
  } catch (e) {
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
};
