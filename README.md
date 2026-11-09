# Agentic Credit Checkout

An AI agent that shops for you, decides whether to pay now or on **agentic credit**, and settles the payment over **PayPal**. Built for the PayPal AI Hackathon.

## Live demo

- https://checkout.reincredit.xyz
- Fallback: https://agentic-credit-checkout.onrender.com

## What it does

- A demo merchant store (3 products).
- An AI shopping agent (LLM-driven) chats with you, picks products, and decides the rail:
  - **Pay now** - PayPal Orders API (sandbox), instant capture.
  - **Agentic credit** - the agent underwrites a micro credit line live (stated income, purchase size, history), books a receivable with a repayment schedule, and PayPal still pays the merchant now.
- A lender dashboard showing every agent decision with its rationale, the order book, and receivables (AG Grid).

## Stack

- Node.js (Express) backend, vanilla JS frontend.
- PayPal Orders v2 API, sandbox environment.
- LLM: any OpenAI-compatible endpoint (DeepSeek by default) for the agent's reasoning.
- AG Grid Community (CDN) for the dashboard tables.

## Run it

```bash
cp .env.example .env   # fill in PayPal sandbox creds + LLM key
npm install
npm start
# open http://localhost:3000
```

## Repo layout

- `server.js` - API: products, agent chat, PayPal order create/capture, underwriting, transaction log
- `agent.js` - the agent brain (LLM prompt + decision tools)
- `public/` - store frontend + dashboard
- `data/` - JSON persistence (orders, receivables, decision log)

## License

MIT

## Agent-to-agent (A2A) discovery

The store is also a merchant agent: any A2A-compatible buyer agent can discover its
checkout capabilities at `/.well-known/agent-card.json` (catalog browse, pay-now
checkout, and pay-on-credit checkout with agentic underwriting). This is what makes
the demo true agentic commerce: the buyer side and the merchant side are both agents,
settling over PayPal rails.
