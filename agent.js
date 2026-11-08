// The agent brain. OpenAI-compatible chat endpoint; JSON-mode decision output.
// Env: LLM_BASE_URL (e.g. https://api.deepseek.com), LLM_API_KEY, LLM_MODEL (e.g. deepseek-chat)

const BASE = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
const MODEL = process.env.LLM_MODEL || 'deepseek-chat';

const SYSTEM = `You are Ria, an agentic shopping and credit assistant for a small demo store.
You help the shopper pick ONE product and choose how to pay:
- "pay_now": settle instantly over PayPal.
- "credit": agentic credit - you underwrite a micro credit line yourself. You MUST collect the shopper's stated monthly income (USD) and existing monthly EMI payments first, then decide.

Rules:
- Keep replies short and friendly. Ask at most one question per turn.
- Only recommend products from the catalog. Never invent products or prices.
- If the shopper asks for credit but has not given income and EMI yet, ask for them (action "chat").
- When you have everything needed, commit: pick action "pay_now" or "credit".

Respond with STRICT JSON only, no markdown:
{
  "reply": "what you say to the shopper",
  "action": "chat" | "pay_now" | "credit",
  "productId": "p1|p2|p3|null",
  "monthlyIncome": number|null,
  "existingEmi": number|null,
  "rationale": "one sentence of internal reasoning for the decision log"
}`;

async function decide({ message, history, ctx }) {
  const key = process.env.LLM_API_KEY;
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'system', content: `Catalog and credit state (JSON): ${JSON.stringify(ctx)}` },
    ...history.slice(-8),
    { role: 'user', content: message },
  ];
  if (!key) {
    return heuristic(message, ctx);
  }
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, response_format: { type: 'json_object' }, temperature: 0.3 }),
  });
  if (!r.ok) {
    console.error('llm error', r.status, await r.text());
    return heuristic(message, ctx);
  }
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content || '{}';
  try {
    const out = JSON.parse(text);
    return normalize(out);
  } catch {
    return heuristic(message, ctx);
  }
}

function normalize(o) {
  const action = ['chat', 'pay_now', 'credit'].includes(o.action) ? o.action : 'chat';
  return {
    reply: typeof o.reply === 'string' ? o.reply : 'Got it.',
    action,
    productId: typeof o.productId === 'string' ? o.productId : null,
    monthlyIncome: o.monthlyIncome ?? null,
    existingEmi: o.existingEmi ?? null,
    rationale: typeof o.rationale === 'string' ? o.rationale : '',
  };
}

// Offline fallback so the demo still runs without an LLM key.
function heuristic(message, ctx) {
  const m = (message || '').toLowerCase();
  const p = ctx.products.find(p => p.name.toLowerCase().split(/\s+/).some(w => w.length > 3 && m.includes(w))) || null;
  const wantsCredit = /credit|emi|install|pay later|later/.test(m);
  const income = (m.match(/income\D*(\d+)/) || m.match(/earn\D*(\d+)/) || m.match(/make\D*(\d+)/) || [])[1];
  const emi = (m.match(/emi\D*(\d+)/) || [])[1];
  if (p && wantsCredit && income) {
    return { reply: `Underwriting now for the ${p.name} on agentic credit.`, action: 'credit', productId: p.id, monthlyIncome: +income, existingEmi: +(emi || 0), rationale: 'keyword fallback: product + credit + income present' };
  }
  if (p && /buy|pay|checkout|now/.test(m)) {
    return { reply: `Creating a PayPal order for the ${p.name}.`, action: 'pay_now', productId: p.id, rationale: 'keyword fallback: buy intent' };
  }
  if (p && wantsCredit) {
    return { reply: `Happy to offer agentic credit on the ${p.name}. What is your monthly income in USD, and do you have existing EMIs?`, action: 'chat', productId: p.id, rationale: 'need income and EMI before underwriting' };
  }
  if (p) {
    return { reply: `The ${p.name} is $${p.price}. Pay now over PayPal, or try agentic credit?`, action: 'chat', productId: p.id, rationale: 'product identified, asking rail' };
  }
  return { reply: `We have ${ctx.products.map(p => `${p.name} ($${p.price})`).join(', ')}. What are you looking for?`, action: 'chat', rationale: 'no product identified yet' };
}

module.exports = { decide };
