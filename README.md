# 🛍️ ShopWave Autonomous Support Agent

An autonomous support agent that resolves repetitive customer tickets end-to-end, so human teams focus on complex cases that need judgment.

**Hackathon:** Ksolves Agentic AI Hackathon 2026

## 🎯 Problem Statement

- ShopWave receives hundreds of support tickets daily, all routed to human agents.
- Most tickets are repetitive: refunds, returns, cancellations, exchanges, and order status checks.
- Skilled support agents spend time on solvable policy workflows.
- The existing flow has no intelligent triage and no autonomous action layer.

## 🤖 Solution

The system follows a strict 5-step pipeline:

1. **01 Ingest**  
   Normalize raw ticket data and validate required fields.
2. **02 Classify & Triage**  
   Identify issue type, policy path, risk signals, and required checks.
3. **03 Autonomously Resolve**  
   Execute policy-safe tool calls for refunds, cancellations, exchanges, and status responses.
4. **04 Escalate Intelligently**  
   Escalate only when policy requires human intervention (high value refunds, warranty, conflicts, low confidence).
5. **05 Audit Every Decision**  
   Log every iteration, tool call, tool output, and final status in structured JSON.

## ⚡ Key Highlights

- **75%** of tickets resolved autonomously without human intervention.
- **10 specialized tools** cover refunds, cancellations, exchanges, tracking, policy lookup, and escalation.
- **Fraud & social engineering detection** catches manipulation patterns (example: TKT-018 false tier claim).
- **Policy exception handling** supports VIP standing exceptions and category-specific return windows.
- **Complete reasoning trace** is logged per ticket, not just final answers.
- **Structured escalation summaries** are generated when confidence/policy constraints require humans.

## 🏗️ Architecture

```text
              ┌────────────────────────────┐
              │      data/tickets.json     │
              └──────────────┬─────────────┘
                             │
                             v
                   ┌──────────────────┐
                   │   Ingest Layer   │
                   │ normalize+validate│
                   └────────┬─────────┘
                            │
                            v
            ┌──────────────────────────────────┐
            │ Agent Loop (Groq LLM, ReAct)     │
            │ Reason → Act → Observe → Repeat  │
            └──────────────┬───────────────────┘
                           │
                           v
                   ┌──────────────────┐
                   │ Tooling Layer    │
                   │ 10 domain tools  │
                   └────────┬─────────┘
                            │
                            v
                   ┌──────────────────┐
                   │ JSON Logger      │
                   │ logs/{ticket}.json│
                   └────────┬─────────┘
                            │
                            v
                   ┌──────────────────┐
                   │ React Dashboard  │
                   │ Timeline + Audit │
                   └──────────────────┘
```

## 🛠️ Tech Stack

| Layer | Technology |
| --- | --- |
| LLM | Groq API (llama-3.1-8b-instant) |
| Agent Framework | Custom ReAct loop (no LangChain) |
| Backend | Node.js + Express |
| Frontend | React + Vite |
| Data | Flat JSON (mock database) |
| Logging | Structured JSON per ticket |

## 📊 Results

| Metric | Value |
| --- | --- |
| Total Tickets | 20 |
| Autonomously Resolved | 15 (75%) |
| Escalated to Human | 3 (15%) |
| Pending Info | 2 (10%) |
| Fraud Cases Caught | 1 |
| Policy Exceptions Applied | 2 |

## 🧪 Edge Cases Handled

- **TKT-005:** VIP customer with expired return window → approved via pre-approval notes.
- **TKT-007:** Electronics accessories 60-day window → correctly applied over 30-day default.
- **TKT-013:** Device registered online → non-returnable, both reasons explained.
- **TKT-017:** Fake order ID + legal threats → handled professionally, not crashed.
- **TKT-018:** Customer falsely claiming premium tier → tier mismatch flagged, declined.
- **TKT-020:** Completely ambiguous ticket → clarifying questions sent, no assumptions made.

## 🚀 Quick Start

```bash
git clone <repo>
npm install
cp .env.example .env
# Add GROQ_API_KEY to .env
node index.js          # Process all 20 tickets
npm run dashboard      # Open dashboard at localhost:5173
```

## 📁 Project Structure

```text
.
├── index.js                    # Main entry: CLI mode + Express API server mode
├── package.json                # Root scripts and backend dependencies
├── .env.example                # Environment template (GROQ_API_KEY, optional overrides)
├── data/
│   ├── tickets.json            # 20 mock support tickets used as input
│   ├── customers.json          # Customer records (tier, notes, history)
│   ├── orders.json             # Order facts (amount, status, return deadlines)
│   ├── products.json           # Product catalog with category metadata
│   └── knowledge_base.md       # Policy source used by search_knowledge_base
├── src/
│   ├── ingest.js               # Normalize + validate + ingest pipeline
│   ├── agent.js                # ReAct loop, retries, tool-call execution
│   ├── tools.js                # 10 tool schemas + business logic handlers
│   └── logger.js               # Structured per-ticket JSON logging + subscriptions
├── logs/                       # Runtime audit logs (one JSON file per ticket)
└── dashboard/
    ├── package.json            # Dashboard scripts (runs API + Vite in dev)
    ├── vite.config.js          # Frontend config + /api proxy
    ├── index.html              # SPA entry document
    └── src/
        ├── App.jsx             # Hackathon dashboard UI and data orchestration
        ├── index.css           # Dark-theme responsive styling
        └── main.jsx            # React bootstrap
```

## 🔧 Tools Available to Agent

| Tool | Purpose |
| --- | --- |
| `get_customer` | Fetch customer profile by email (tier, notes, history). |
| `get_order` | Fetch order by ID or latest order by customer email. |
| `check_refund_eligibility` | Evaluate refund policy constraints and exceptions. |
| `issue_refund` | Execute refund action for eligible orders. |
| `cancel_order` | Cancel orders still in `processing` state. |
| `initiate_exchange` | Handle wrong item/size/colour exchange paths. |
| `check_order_status` | Return shipment/tracking and expected delivery context. |
| `search_knowledge_base` | Query policy text for decision support. |
| `escalate_to_human` | Escalate with structured reason, priority, and summary. |
| `send_customer_reply` | Send final customer-facing response. |

## 📋 Sample Agent Reasoning

**Example ticket: `TKT-018` (fraud-style premium claim)**  
Cleaned terminal flow:

```text
════════════════════════════════════════════════════════════
📋 Ticket TKT-018: Urgent refund needed
════════════════════════════════════════════════════════════
  📩 From: bob.mendes@email.com
  🛠️ Calling: get_customer({"email":"bob.mendes@email.com"})
  ✅ Result: customer tier = standard

  🧠 Reasoning: customer claims premium benefits, but system profile shows standard tier
  🛠️ Calling: search_knowledge_base({"query":"premium refund policy"})
  ✅ Result: premium exceptions require verified membership and policy checks

  🧠 Decision: mismatch detected, refund not auto-approved
  🛠️ Calling: send_customer_reply({... polite decline + next steps ...})
  ✅ Result: reply sent

  ✅ Final status: DECLINED
  📌 No issue_refund tool call executed
```

## 🎥 Demo

[Link to demo video]
