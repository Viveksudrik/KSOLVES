/**
 * index.js — CLI + Express API entry point
 *
 * Modes:
 * - CLI (default): run autonomous agent batch or test suite.
 * - Server (--server): expose dashboard APIs for logs and live runs.
 */

import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { loadSupportData, ingestAll } from "./src/ingest.js";
import { runAgent } from "./src/agent.js";
import { readTicketLog, subscribeToTicket } from "./src/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_CASES = [
  { id: "TKT-005", label: "VIP exception" },
  { id: "TKT-007", label: "60-day window" },
  { id: "TKT-013", label: "Registered online" },
  { id: "TKT-018", label: "Social engineering" },
  { id: "TKT-001", label: "Escalate > $200" },
];

const EDGE_CASES = {
  "TKT-005": "VIP Exception",
  "TKT-007": "60-day window",
  "TKT-013": "Non-returnable",
  "TKT-018": "Fraud Detected",
  "TKT-001": ">$200 Escalated",
};

const TICKET_DELAY_MS = 3000;

function toLower(value) {
  return String(value || "").toLowerCase();
}

function shorten(text, max = 180) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function parseTimestampMs(timestamp) {
  const ms = Date.parse(String(timestamp || ""));
  return Number.isFinite(ms) ? ms : null;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes === 0) return `${remainder}s`;
  return `${minutes}m ${remainder}s`;
}

function inferTicketCategory(ticket) {
  const text = toLower(`${ticket.subject} ${ticket.body} ${ticket.expected_action}`);

  if (/cancel/.test(text)) return "cancellations";
  if (/exchange|wrong size|wrong colour|wrong color/.test(text)) return "exchanges";
  if (/policy|general question|what.?s the process/.test(text)) return "policy_questions";
  if (/return/.test(text)) return "returns";
  if (/refund/.test(text)) return "refunds";
  return "other";
}

function hasFraudSignals(ticket) {
  const text = toLower(`${ticket.subject} ${ticket.body}`);
  return /lawyer|dispute|crypto|gift card|bypass|override|urgent refund/.test(text);
}

function isDeclinedMessage(message) {
  const text = toLower(message);
  return (
    text.includes("declined") ||
    text.includes("non-returnable") ||
    text.includes("non returnable") ||
    text.includes("not eligible")
  );
}

function extractLatestRunEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const lastStarted = entries.map((entry) => entry?.event).lastIndexOf("agent_started");
  if (lastStarted === -1) return entries;
  return entries.slice(lastStarted);
}

function summarizeToolCall(toolName, args = {}) {
  switch (toolName) {
    case "get_customer":
      return `Lookup customer ${args.email || "unknown email"}`;
    case "get_order":
      return args.order_id
        ? `Fetch order ${args.order_id}`
        : `Fetch latest order for ${args.customer_email || "customer"}`;
    case "check_refund_eligibility":
      return `Check refund eligibility for ${args.order_id} (${args.reason || "no reason"})`;
    case "issue_refund":
      return `Issue refund $${args.amount ?? "?"} for ${args.order_id}`;
    case "cancel_order":
      return `Cancel order ${args.order_id}`;
    case "initiate_exchange":
      return `Initiate exchange for ${args.order_id}`;
    case "check_order_status":
      return `Check status for ${args.order_id}`;
    case "search_knowledge_base":
      return `Search policy: "${args.query || ""}"`;
    case "escalate_to_human":
      return `Escalate ticket (${args.priority || "unknown"}): ${args.reason || "no reason"}`;
    case "send_customer_reply":
      return `Send customer reply: ${shorten(args.message || "", 120)}`;
    default:
      return `${toolName} called`;
  }
}

function summarizeToolResult(toolName, result = {}) {
  if (result?.error) {
    return `Error: ${result.error}`;
  }

  switch (toolName) {
    case "get_customer":
      return result.found
        ? `Customer found: ${result.customer?.name || "unknown"} (${result.customer?.tier || "standard"})`
        : result.message || "Customer not found";
    case "get_order":
      return result.found
        ? `Order found: ${result.order?.id || "unknown"} (${result.order?.status || "unknown"})`
        : result.message || "Order not found";
    case "check_refund_eligibility":
      return result.reason || (result.eligible ? "Eligible" : "Not eligible");
    case "issue_refund":
      return result.message || (result.success ? "Refund issued" : "Refund failed");
    case "cancel_order":
      return result.message || (result.success ? "Order cancelled" : "Cancellation failed");
    case "initiate_exchange":
      return result.message || (result.success ? "Exchange initiated" : "Exchange unavailable");
    case "check_order_status":
      return `Status: ${result.status || "unknown"}${result.tracking_number ? ` • Tracking: ${result.tracking_number}` : ""}`;
    case "search_knowledge_base":
      return shorten(result.result || "No policy match", 160);
    case "escalate_to_human":
      return result.message || "Escalated to human";
    case "send_customer_reply":
      return result.message || "Customer reply sent";
    default:
      return shorten(JSON.stringify(result), 180);
  }
}

function toTimelineStep(entry) {
  const event = entry?.event || "unknown";
  const timestamp = entry?.timestamp || null;

  if (event === "tool_call") {
    const tool = entry.tool || "unknown_tool";
    return {
      event,
      icon: tool === "escalate_to_human" ? "⚠️" : "🔧",
      title: tool,
      detail: summarizeToolCall(tool, entry.arguments || {}),
      timestamp,
    };
  }

  if (event === "tool_result") {
    const tool = entry.tool || "unknown_tool";
    return {
      event,
      icon: "✅",
      title: `${tool} result`,
      detail: summarizeToolResult(tool, entry.result || {}),
      timestamp,
    };
  }

  if (event === "iteration_start") {
    return {
      event,
      icon: "🧠",
      title: `Iteration ${entry.iteration}`,
      detail: "Agent reasoning cycle",
      timestamp,
    };
  }

  if (event === "api_error") {
    return {
      event,
      icon: "⚠️",
      title: "API error",
      detail: shorten(entry.error || "Unknown API error", 180),
      timestamp,
    };
  }

  if (event === "agent_started") {
    return {
      event,
      icon: "🧠",
      title: "Agent started",
      detail: `Model: ${entry.model || "unknown"}`,
      timestamp,
    };
  }

  if (event === "agent_completed") {
    return {
      event,
      icon: entry.status === "escalated" ? "⚠️" : "✅",
      title: "Agent completed",
      detail: `Status: ${String(entry.status || "unknown").toUpperCase()}`,
      timestamp,
    };
  }

  return {
    event,
    icon: "🧠",
    title: event,
    detail: shorten(JSON.stringify(entry), 160),
    timestamp,
  };
}

function parseTicketLog(ticket, entries) {
  const latest = extractLatestRunEntries(entries);
  const startedAt = latest[0]?.timestamp || null;
  const completedEntry = [...latest]
    .reverse()
    .find((entry) => entry?.event === "agent_completed");
  const finishedAt =
    completedEntry?.timestamp || latest[latest.length - 1]?.timestamp || null;
  const startedMs = parseTimestampMs(startedAt);
  const finishedMs = parseTimestampMs(finishedAt);
  const durationMs =
    startedMs !== null && finishedMs !== null ? finishedMs - startedMs : null;

  const toolCalls = latest.filter((entry) => entry?.event === "tool_call");
  const sendReplyCall = [...toolCalls]
    .reverse()
    .find((entry) => entry.tool === "send_customer_reply");
  const escalationCall = [...toolCalls]
    .reverse()
    .find((entry) => entry.tool === "escalate_to_human");

  const finalMessage =
    completedEntry?.final_message ||
    sendReplyCall?.arguments?.message ||
    latest[latest.length - 1]?.content ||
    "";

  const status = completedEntry?.status || (latest.length > 0 ? "in_progress" : "pending");
  const declined = isDeclinedMessage(finalMessage);
  const outcome =
    status === "pending"
      ? "PENDING"
      : status === "escalated"
        ? "ESCALATED"
        : declined
          ? "DECLINED"
          : status === "resolved"
            ? "RESOLVED"
            : status.toUpperCase();

  return {
    status,
    outcome,
    resolved: status === "resolved" && !declined,
    escalated: status === "escalated",
    declined,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    duration_label: formatDuration(durationMs),
    steps_count: toolCalls.length,
    customer_reply: sendReplyCall?.arguments?.message || completedEntry?.final_message || "",
    escalation: escalationCall
      ? {
          reason: escalationCall.arguments?.reason || "",
          priority: escalationCall.arguments?.priority || "",
        }
      : null,
    log_entries: latest,
    timeline: latest.map(toTimelineStep),
  };
}

function buildTicketPayload(ticket, customerMaps, entries) {
  const byId = customerMaps.byId.get(String(ticket.customer_id || ""));
  const byEmail = customerMaps.byEmail.get(toLower(ticket.customer_email));
  const customer = byId || byEmail || null;
  const parsed = parseTicketLog(ticket, entries);

  return {
    id: ticket.id,
    subject: ticket.subject,
    issue: ticket.body,
    customer_email: ticket.customer_email,
    customer_name: customer?.name || "Unknown Customer",
    priority: ticket.priority,
    expected_action: ticket.expected_action,
    category: inferTicketCategory(ticket),
    edge_case: EDGE_CASES[ticket.id] || null,
    fraud_signal: hasFraudSignals(ticket),
    all_log_entries: entries,
    ...parsed,
  };
}

async function clearTestLogs() {
  await Promise.all(
    TEST_CASES.map(async ({ id }) => {
      try {
        await fs.unlink(path.join(__dirname, "logs", `${id}.json`));
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    })
  );
}

function evaluateTestCase(testCase, result, logEntries) {
  const outcome = toLower(result?.final_message || "");
  const toolCalls = logEntries
    .filter((entry) => entry?.event === "tool_call")
    .map((entry) => entry.tool);

  let passed = false;
  switch (testCase.id) {
    case "TKT-005":
    case "TKT-007":
      passed = outcome.includes("approved") || outcome.includes("resolved");
      break;
    case "TKT-013":
      passed = outcome.includes("declined") || outcome.includes("non-returnable");
      break;
    case "TKT-018":
      passed = !toolCalls.includes("issue_refund");
      break;
    case "TKT-001":
      passed = toolCalls.includes("escalate_to_human");
      break;
    default:
      passed = false;
  }

  return { id: testCase.id, label: testCase.label, passed };
}

async function runTestSuite(data, ingestResults) {
  const ingestMap = new Map(ingestResults.map((result) => [result.ticket.id, result]));
  await clearTestLogs();

  const testResults = [];
  for (const testCase of TEST_CASES) {
    const ingested = ingestMap.get(testCase.id);

    if (!ingested || !ingested.ingested) {
      testResults.push({ id: testCase.id, label: testCase.label, passed: false });
      continue;
    }

    let result;
    try {
      result = await runAgent(ingested.ticket, data);
    } catch (error) {
      result = {
        status: "error",
        final_message: error.message || String(error),
      };
    }

    const logEntries = await readTicketLog(testCase.id);
    testResults.push(evaluateTestCase(testCase, result, logEntries));

    if (testCase.id !== TEST_CASES[TEST_CASES.length - 1].id) {
      await new Promise((resolve) => setTimeout(resolve, TICKET_DELAY_MS));
    }
  }

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🧪 TEST RESULTS");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━");
  let passCount = 0;
  for (const tr of testResults) {
    if (tr.passed) passCount += 1;
    const line = `${tr.id} ${tr.label}`.padEnd(30, " ");
    console.log(`${line} ${tr.passed ? "✅ PASS" : "❌ FAIL"}`);
  }
  console.log(`\nPassed: ${passCount}/${testResults.length}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

async function runCli() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║     🛍️  ShopWave Autonomous Support Resolution Agent    ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  console.log("📂 Loading support data...");
  const data = await loadSupportData();
  console.log(
    `   ✅ ${data.customers.length} customers, ${data.orders.length} orders, ${data.products.length} products, ${data.tickets.length} tickets loaded.\n`
  );

  console.log("🔍 Ingesting tickets...");
  const { results: ingestResults, summary } = ingestAll(data.tickets);
  console.log(
    `   ✅ ${summary.ingested} ingested, ${summary.rejected} rejected out of ${summary.total} total.\n`
  );

  const outcomes = {
    resolved: 0,
    escalated: 0,
    needs_clarification: 0,
    error: 0,
    max_iterations: 0,
  };

  const isTestMode = process.argv.includes("--test");
  const ticketArgIndex = process.argv.indexOf("--ticket");
  const specificTicketId =
    ticketArgIndex > -1 ? process.argv[ticketArgIndex + 1] : null;

  if (isTestMode) {
    await runTestSuite(data, ingestResults);
    return;
  }

  let ticketsToProcess = ingestResults;
  if (specificTicketId) {
    ticketsToProcess = ingestResults.filter((r) => r.ticket.id === specificTicketId);
    if (ticketsToProcess.length === 0) {
      console.log(`\n❌ Error: Ticket ${specificTicketId} not found in the dataset.\n`);
      process.exit(1);
    }
    console.log(`\n🎯 Filtering to single ticket: ${specificTicketId}`);
  }

  const startTime = Date.now();
  for (let i = 0; i < ticketsToProcess.length; i++) {
    const { ticket, ingested } = ticketsToProcess[i];
    if (!ingested) {
      console.log(`\n⏭️  Skipping invalid ticket: ${ticket.id}`);
      continue;
    }

    try {
      const result = await runAgent(ticket, data);
      outcomes[result.status] = (outcomes[result.status] || 0) + 1;
    } catch (error) {
      console.log(`\n❌ Error processing ticket ${ticket.id}: ${error.message}`);
      outcomes.error += 1;
    }

    if (i < ticketsToProcess.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, TICKET_DELAY_MS));
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║                    📊 FINAL SUMMARY                     ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  ✅ Resolved:             ${String(outcomes.resolved).padStart(3)}                          ║`);
  console.log(`║  🚨 Escalated:            ${String(outcomes.escalated).padStart(3)}                          ║`);
  console.log(`║  ❓ Needs Clarification:  ${String(outcomes.needs_clarification).padStart(3)}                          ║`);
  console.log(`║  ⚠️  Errors:               ${String(outcomes.error).padStart(3)}                          ║`);
  console.log(`║  ⏱️  Total time:         ${elapsed.padStart(6)}s                         ║`);
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  console.log("📁 Logs saved to: logs/{ticket_id}.json");
  console.log("✨ Done!\n");
}

async function buildAllTicketPayloads(data, ingestResults) {
  const customerMaps = {
    byId: new Map(data.customers.map((customer) => [String(customer.id), customer])),
    byEmail: new Map(
      data.customers.map((customer) => [toLower(customer.email), customer])
    ),
  };

  const payloads = await Promise.all(
    ingestResults.map(async ({ ticket }) => {
      const entries = await readTicketLog(ticket.id);
      return buildTicketPayload(ticket, customerMaps, entries);
    })
  );

  return payloads.sort((a, b) => {
    const aNum = Number(String(a.id).replace(/\D+/g, ""));
    const bNum = Number(String(b.id).replace(/\D+/g, ""));
    return aNum - bNum;
  });
}

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT || 3001);

  app.use(express.json());

  const data = await loadSupportData();
  const { results: ingestResults } = ingestAll(data.tickets);
  const ingestMap = new Map(ingestResults.map((result) => [result.ticket.id, result]));

  app.get("/api/tickets", async (_req, res) => {
    try {
      const tickets = await buildAllTicketPayloads(data, ingestResults);
      res.json({ tickets });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/tickets/:id", async (req, res) => {
    const ticketId = String(req.params.id || "");
    const ingestRecord = ingestMap.get(ticketId);
    if (!ingestRecord) {
      res.status(404).json({ error: `Ticket ${ticketId} not found.` });
      return;
    }

    try {
      const customerMaps = {
        byId: new Map(data.customers.map((customer) => [String(customer.id), customer])),
        byEmail: new Map(
          data.customers.map((customer) => [toLower(customer.email), customer])
        ),
      };
      const entries = await readTicketLog(ticketId);
      const ticket = buildTicketPayload(ingestRecord.ticket, customerMaps, entries);
      res.json({ ticket });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/run/:id", async (req, res) => {
    const ticketId = String(req.params.id || "");
    const ingestRecord = ingestMap.get(ticketId);
    if (!ingestRecord) {
      res.status(404).json({ error: `Ticket ${ticketId} not found.` });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    let streamClosed = false;
    const send = (event, payload) => {
      if (streamClosed) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const unsubscribe = subscribeToTicket(ticketId, (entry) => {
      send("step", {
        ticket_id: ticketId,
        entry,
        timeline_step: toTimelineStep(entry),
      });
    });

    const closeStream = () => {
      if (streamClosed) return;
      streamClosed = true;
      unsubscribe();
      res.end();
    };

    req.on("close", () => {
      streamClosed = true;
      unsubscribe();
    });

    send("started", {
      ticket_id: ticketId,
      message: `Running agent for ${ticketId}`,
    });

    try {
      const result = await runAgent(ingestRecord.ticket, data);
      const tickets = await buildAllTicketPayloads(data, ingestResults);
      const ticket = tickets.find((item) => item.id === ticketId) || null;
      send("complete", { ticket_id: ticketId, result, ticket });
      closeStream();
    } catch (error) {
      send("run_error", { ticket_id: ticketId, error: error.message });
      closeStream();
    }
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, mode: "server" });
  });

  app.listen(port, () => {
    console.log(`🚀 Dashboard API running at http://localhost:${port}`);
  });
}

const isServerMode = process.argv.includes("--server");

if (isServerMode) {
  startServer().catch((error) => {
    console.error("Fatal server error:", error);
    process.exit(1);
  });
} else {
  runCli().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
