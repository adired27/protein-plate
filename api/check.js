// POST /api/check
// Verifies the signed-in user, uses up one of their daily photo checks,
// asks Claude to compare their numbers with the photo, and returns a cleaned-up verdict.
// The Anthropic API key only ever lives here, on the server.

const LIMIT = Number(process.env.DAILY_CHECK_LIMIT || 10);
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_ANON_KEY;

const ITEMS = ["eggs", "nuts", "chicken"];
const VERDICTS = ["ok", "too_high", "too_low", "not_seen"];

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
  if (!process.env.ANTHROPIC_API_KEY || !SB_URL || !SB_KEY) {
    return res.status(500).json({ error: "server_not_configured" });
  }

  // 1. Who is this? Ask Supabase to validate the user's session token.
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "unauthorized" });
  const userRes = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!userRes || !userRes.ok) return res.status(401).json({ error: "unauthorized" });

  // 2. Validate the input. Never trust numbers or text straight from the browser.
  const body = typeof req.body === "string" ? safeJson(req.body) : req.body || {};
  const image = typeof body.image === "string" ? body.image : "";
  if (!image || image.length > 4_000_000 || !/^[A-Za-z0-9+/=]+$/.test(image)) {
    return res.status(400).json({ error: "bad_photo" });
  }
  const form = {
    eggs: clamp(Math.round(Number(body.eggs) || 0), 0, 20),
    nuts: clamp(Math.round((Number(body.nuts) || 0) * 2) / 2, 0, 20),
    chicken: clamp(Math.round(Number(body.chicken) || 0), 0, 1000),
  };
  const note = String(body.note || "").slice(0, 300).replace(/["\\]/g, "'");

  // 3. Use up one of today's checks. Runs as the user, so it can only count their own checks.
  const claim = await fetch(`${SB_URL}/rest/v1/rpc/claim_check`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_limit: LIMIT }),
  }).catch(() => null);
  if (!claim || !claim.ok) return res.status(502).json({ error: "upstream" });
  const used = await claim.json();
  if (used === null) return res.status(429).json({ error: "daily_limit", limit: LIMIT });

  // 4. Ask Claude.
  let aiRes;
  try {
    aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
            { type: "text", text: buildPrompt(form, note) },
          ],
        }],
      }),
    });
  } catch {
    return res.status(502).json({ error: "upstream" });
  }

  if (!aiRes.ok) {
    const err = await aiRes.json().catch(() => ({}));
    const msg = String(err?.error?.message || "");
    console.error("Anthropic error", aiRes.status, msg);
    if (aiRes.status === 400 && /usage limits/i.test(msg)) return res.status(503).json({ error: "budget" });
    if (aiRes.status === 400 && /image/i.test(msg)) return res.status(400).json({ error: "bad_photo" });
    if (aiRes.status === 429 || aiRes.status === 529) return res.status(503).json({ error: "busy" });
    return res.status(502).json({ error: "upstream" });
  }

  const data = await aiRes.json();
  const text = (data.content || []).map(b => (b.type === "text" ? b.text : "")).join("");
  const out = parseJson(text);
  if (!out) return res.status(502).json({ error: "unreadable" });

  return res.status(200).json({ ...clean(out, form), remaining: Math.max(0, LIMIT - used) });
}

function buildPrompt(form, note) {
  return `You are checking a person's meal log against a photo of the meal. They say this meal contains:
- eggs: ${form.eggs} whole eggs (any style: boiled, omelette, bhurji, curry)
- nuts: ${form.nuts} fistfuls (one fistful is about 30 g; count nuts and seeds together: almonds, cashews, peanuts, walnuts, pistachios, pumpkin, sunflower and similar seeds)
- chicken: ${form.chicken} grams of cooked edible meat (not bone, skin or gravy)
${note ? `Their note: "${note}"\n` : ""}
Only these three foods matter. Ignore every other food in the photo (dal, sprouts, chana, salad, rice, roti, curd, paneer and so on): do not mention, count or estimate them.
For EACH of eggs, nuts and chicken, judge whether the photo makes their number reasonable.
Be fair, not strict: accept anything within roughly 30% of what you see, and accept when food could plausibly be hidden (eggs mixed into bhurji, chicken under gravy, bone-in pieces, a partly cut-off plate). Use the plate (about 26 cm across), katori, spoon or hand for scale.
Verdicts: "ok" = reasonable; "too_high" = the photo clearly shows much less; "too_low" = the photo clearly shows much more (including when they entered 0 but the food is clearly there); "not_seen" = they entered more than 0 but that food is clearly not in the photo. When they entered 0 and the food is absent, verdict is "ok".
"estimate" is your own amount in the same unit: a whole number of eggs, fistfuls in steps of 0.5, chicken grams rounded to 10.
If the photo is not a meal or too unclear to judge, set photo_ok to false and explain in note.
Reply with only JSON, no other text:
{"photo_ok":true,"checks":[{"item":"eggs","verdict":"ok","estimate":2,"reason":"short sentence"},{"item":"nuts","verdict":"ok","estimate":0,"reason":""},{"item":"chicken","verdict":"too_high","estimate":90,"reason":"short sentence"}],"note":""}`;
}

// Turn whatever Claude returned into a strict, safe shape.
function clean(out, form) {
  const checks = {};
  for (const c of Array.isArray(out.checks) ? out.checks : []) {
    if (!ITEMS.includes(c?.item)) continue;
    let est = Math.max(0, Number(c.estimate) || 0);
    est = c.item === "eggs" ? Math.round(est) : c.item === "nuts" ? Math.round(est * 2) / 2 : Math.round(est / 10) * 10;
    checks[c.item] = {
      verdict: VERDICTS.includes(c.verdict) ? c.verdict : "ok",
      estimate: est,
      reason: String(c.reason || "").slice(0, 160),
    };
  }
  for (const k of ITEMS) checks[k] ||= { verdict: "ok", estimate: form[k], reason: "" };
  return { photo_ok: out.photo_ok !== false, note: String(out.note || "").slice(0, 200), checks, others: [] };
}

function parseJson(text) {
  const t = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}
function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
