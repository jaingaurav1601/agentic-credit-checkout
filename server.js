// Agentic Credit Checkout - server
// PayPal Orders v2 (sandbox) + LLM agent + micro-credit underwriting.
const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { decide } = require('./agent');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function loadDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ orders: [], receivables: [], decisions: [], creditLine: { limit: 500, used: 0 } }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

const PRODUCTS = [
  { id: 'p1', name: 'Wireless Earbuds Pro', price: 79.0, blurb: 'ANC, 30h battery, wireless charging' },
  { id: 'p2', name: 'Smart Desk Lamp', price: 45.5, blurb: 'Circadian modes, app control, USB-C' },
  { id: 'p3', name: 'Mechanical Keyboard 65%', price: 129.99, blurb: 'Hot-swap, gasket mount, PBT caps' },
];

// ---------- PayPal helpers ----------
const PP_BASE = process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';
async function ppToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_SECRET}`).toString('base64');
  const r = await fetch(`${PP_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`paypal token failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}
async function ppCreateOrder(amount, description) {
  const token = await ppToken();
  const r = await fetch(`${PP_BASE}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ amount: { currency_code: 'USD', value: amount.toFixed(2) }, description }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`paypal create failed: ${JSON.stringify(j)}`);
  return j;
}
async function ppCapture(orderId) {
  const token = await ppToken();
  const r = await fetch(`${PP_BASE}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`paypal capture failed: ${JSON.stringify(j)}`);
  return j;
}

// ---------- Underwriting ----------
function underwrite({ amount, monthlyIncome, existingEmi }) {
  const db = loadDb();
  const available = db.creditLine.limit - db.creditLine.used;
  const dti = monthlyIncome > 0 ? (existingEmi / monthlyIncome) : 1;
  const reasons = [];
  let approved = true;
  if (amount > available) { approved = false; reasons.push(`amount $${amount.toFixed(2)} exceeds available credit $${available.toFixed(2)}`); }
  if (dti > 0.4) { approved = false; reasons.push(`debt-to-income ${(dti * 100).toFixed(0)}% above 40% policy cap`); }
  if (monthlyIncome <= 0) { approved = false; reasons.push('no stated income'); }
  if (approved) reasons.push(`within credit line ($${available.toFixed(2)} available), DTI ${(dti * 100).toFixed(0)}% under 40% cap`);
  const apr = 0; // demo: 0% if repaid in 3 monthly instalments
  const schedule = approved ? [0, 1, 2].map(i => ({
    due: new Date(Date.now() + (i + 1) * 30 * 864e5).toISOString().slice(0, 10),
    amount: +(amount / 3).toFixed(2),
  })) : [];
  return { approved, reasons, apr, schedule, lineAvailable: available };
}

// ---------- API ----------
app.get('/api/products', (req, res) => res.json(PRODUCTS));

app.get('/api/state', (req, res) => {
  const db = loadDb();
  res.json({ creditLine: db.creditLine, orders: db.orders, receivables: db.receivables, decisions: db.decisions.slice(-50) });
});

// Agent conversation: user message -> agent decision (tool calls handled server-side)
app.post('/api/agent', async (req, res) => {
  const { message, history } = req.body || {};
  const db = loadDb();
  const ctx = {
    products: PRODUCTS,
    creditLine: db.creditLine,
    openReceivables: db.receivables.filter(r => r.status === 'open'),
  };
  try {
    const out = await decide({ message, history: history || [], ctx });
    // execute tool actions
    let payment = null;
    if (out.action === 'pay_now' || out.action === 'credit') {
      const product = PRODUCTS.find(p => p.id === out.productId);
      if (!product) throw new Error('unknown product');
      if (out.action === 'credit') {
        const uw = underwrite({ amount: product.price, monthlyIncome: +out.monthlyIncome || 0, existingEmi: +out.existingEmi || 0 });
        db.decisions.push({ ts: new Date().toISOString(), type: 'underwrite', product: product.name, amount: product.price, income: out.monthlyIncome, emi: out.existingEmi, approved: uw.approved, reasons: uw.reasons, rationale: out.rationale });
        if (uw.approved) {
          const order = await ppCreateOrder(product.price, `${product.name} (agentic credit)`);
          payment = { provider: 'paypal', orderId: order.id, approveUrl: (order.links || []).find(l => l.rel === 'approve')?.href, rail: 'credit', schedule: uw.schedule };
          db.creditLine.used += product.price;
          db.receivables.push({ id: `r${Date.now()}`, ts: new Date().toISOString(), product: product.name, principal: product.price, schedule: uw.schedule, status: 'open' });
        } else {
          payment = { rail: 'credit', declined: true, reasons: uw.reasons };
        }
      } else {
        const order = await ppCreateOrder(product.price, product.name);
        payment = { provider: 'paypal', orderId: order.id, approveUrl: (order.links || []).find(l => l.rel === 'approve')?.href, rail: 'pay_now' };
        db.decisions.push({ ts: new Date().toISOString(), type: 'pay_now', product: product.name, amount: product.price, rationale: out.rationale });
      }
      saveDb(db);
    } else {
      db.decisions.push({ ts: new Date().toISOString(), type: 'chat', message, rationale: out.rationale });
      saveDb(db);
    }
    res.json({ reply: out.reply, action: out.action, payment, rationale: out.rationale });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Capture after buyer approves on PayPal
app.post('/api/capture', async (req, res) => {
  const { orderId } = req.body || {};
  try {
    const j = await ppCapture(orderId);
    const db = loadDb();
    const cap = j.purchase_units?.[0]?.payments?.captures?.[0];
    db.orders.push({ id: j.id, ts: new Date().toISOString(), status: j.status, amount: cap?.amount?.value, currency: cap?.amount?.currency_code, captureId: cap?.id });
    saveDb(db);
    res.json({ status: j.status, captureId: cap?.id });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`agentic-credit-checkout on :${PORT}`));
