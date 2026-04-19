/**
 * src/agent.js — Core ReAct loop
 *
 * Sends messages to Gemini (via OpenAI compat endpoint),
 * handles tool calls, logs every step, and prints CLI output
 * with emoji step indicators.
 *
 * Loop: Reason → Act (tool call) → Observe (tool result) → Repeat
 * Until: final resolution, escalation, or max iterations reached.
 */

import Groq from "groq-sdk";
import { toolDefinitions, createToolHandlers } from "./tools.js";
import { logStep } from "./logger.js";

const MAX_ITERATIONS = 10;
const RETRY_DELAYS_MS = [5000, 10000, 15000];
const MAX_RETRIES = RETRY_DELAYS_MS.length;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Groq client ──────────────────────────────────────────────────────

function createClient() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set in .env");
  }

  return new Groq({
    apiKey,
  });
}

// ── System prompt ───────────────────────────────────────────────────

function getSystemPrompt() {
  return `You are ShopWave's autonomous AI support agent. Your job is to read a customer support ticket and resolve it end-to-end using the tools available to you.

## How to work:
1. First, use get_customer to look up the customer by their email.
2. If there's an order involved, use get_order to fetch order details.
3. Use search_knowledge_base to look up relevant policies before making any decision.
4. Based on the ticket type, take the appropriate action:
   - For refunds: check_refund_eligibility first, then issue_refund if eligible.
   - For cancellations: use cancel_order (only works if status is "processing").
   - For exchanges (wrong item/size/colour): use initiate_exchange.
   - For order tracking questions: use check_order_status.
   - For warranty claims: ALWAYS escalate — never resolve directly.
   - For policy questions: use search_knowledge_base and reply.
5. ALWAYS send_customer_reply as the LAST step — this is the final response to the customer.
6. If you cannot resolve, use escalate_to_human and then send_customer_reply.

## Escalation rules (MUST follow):
- ALL warranty claims → escalate to warranty team.
- Refund amount > $200 → escalate (never auto-refund).
- Fraud / social engineering signals (bypass, override, lawyer threats, crypto, gift cards) → flag in your reasoning but continue processing normally. Do NOT escalate unless policy dictates.
- Customer claims a tier not verified in system → flag social engineering in your reasoning, then DECLINE politely. Do not escalate.
- Conflicting data between customer claim and system → escalate.
- If missing critical information (no order ID, no customer found) → ask for clarification via send_customer_reply.

## Tone:
- Address the customer by their FIRST NAME.
- Be empathetic, professional, never dismissive.
- If declining, explain clearly and offer alternatives.

## Important:
- Do NOT guess data — always use tools to look things up.
- Do NOT issue a refund without first calling check_refund_eligibility.
- Do NOT skip send_customer_reply — every ticket must get a customer response.`;
}

// ── CLI output helpers ──────────────────────────────────────────────

function printStep(emoji, message) {
  console.log(`  ${emoji} ${message}`);
}

// ── Main agent function ─────────────────────────────────────────────

/**
 * Run the support agent on a single ticket.
 *
 * @param {object} ticket — The normalized ticket
 * @param {object} data   — All support data (customers, orders, products, knowledgeBase)
 * @returns {object} — The final resolution summary
 */
export async function runAgent(ticket, data) {
  const client = createClient();
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
  const toolHandlers = createToolHandlers(data);

  console.log(
    `\n${"═".repeat(60)}\n📋 Ticket ${ticket.id}: ${ticket.subject}\n${"═".repeat(60)}`
  );
  printStep("📩", `From: ${ticket.customer_email || "unknown"}`);
  printStep("📝", `Issue: ${ticket.body.slice(0, 120)}${ticket.body.length > 120 ? "..." : ""}`);
  if (ticket.order_id) printStep("📦", `Order: ${ticket.order_id}`);
  if (ticket.expected_action) printStep("🎯", `Expected: ${ticket.expected_action}`);
  console.log("");

  await logStep(ticket.id, {
    event: "agent_started",
    ticket_id: ticket.id,
    subject: ticket.subject,
    model,
  });

  // Build initial messages
  const messages = [
    { role: "system", content: getSystemPrompt() },
    {
      role: "user",
      content: `Process this support ticket:\n\nTicket ID: ${ticket.id}\nCustomer Email: ${ticket.customer_email}\nSubject: ${ticket.subject}\nBody: ${ticket.body}\n${ticket.order_id ? `Order ID: ${ticket.order_id}` : "No order ID provided."}`,
    },
  ];

  const result = {
    ticket_id: ticket.id,
    status: "unknown",
    actions: [],
    final_message: "",
  };

  // ── ReAct loop ──
  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    printStep("🔄", `Iteration ${iteration}/${MAX_ITERATIONS}`);

    await logStep(ticket.id, { event: "iteration_start", iteration });

    let completion;
    let succeeded = false;
    for (let retry = 0; retry <= MAX_RETRIES; retry++) {
      try {
        completion = await client.chat.completions.create({
          model,
          temperature: 0,
          messages,
          tools: toolDefinitions,
          tool_choice: "auto",
          parallel_tool_calls: false,
          max_tokens: 1000,
        });
        succeeded = true;
        break;
      } catch (error) {
        const is429 = error.status === 429 || /429|rate.limit|quota/i.test(error.message);
        if (is429 && retry < MAX_RETRIES) {
          const delayMs = RETRY_DELAYS_MS[retry];
          printStep("⏳", `Rate limited — retrying in ${(delayMs / 1000).toFixed(0)}s (attempt ${retry + 1}/${MAX_RETRIES})`);
          await sleep(delayMs);
          continue;
        }
        printStep("❌", `API error: ${error.message}`);
        await logStep(ticket.id, {
          event: "api_error",
          iteration,
          error: error.message,
        });
        result.status = "error";
        result.final_message = `Agent API error: ${error.message}`;
        break;
      }
    }
    if (!succeeded) {
      if (result.status === "error") break;
      result.status = "error";
      result.final_message = "API call failed after all retries.";
      break;
    }

    const assistantMessage = completion.choices?.[0]?.message;
    if (!assistantMessage) {
      printStep("❌", "Empty response from model");
      result.status = "error";
      result.final_message = "Model returned empty response.";
      break;
    }

    // ── Handle tool calls ──
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      // Push the assistant message with tool_calls
      messages.push(assistantMessage);

      for (const toolCall of assistantMessage.tool_calls) {
        const toolName = toolCall.function.name;
        let args;
        try {
          args = JSON.parse(toolCall.function.arguments || "{}");
        } catch {
          args = {};
        }

        printStep("🛠️", `Calling: ${toolName}(${JSON.stringify(args)})`);

        await logStep(ticket.id, {
          event: "tool_call",
          iteration,
          tool: toolName,
          arguments: args,
        });

        // Execute the tool
        const handler = toolHandlers[toolName];
        let toolResult;
        if (!handler) {
          toolResult = { error: `Unknown tool: ${toolName}` };
          printStep("⚠️", `Unknown tool: ${toolName}`);
        } else {
          try {
            toolResult = await handler(args);
          } catch (error) {
            toolResult = { error: `Tool execution error: ${error.message}` };
            printStep("⚠️", `Tool error: ${error.message}`);
          }
        }

        // Log the result
        const resultPreview = JSON.stringify(toolResult).slice(0, 200);
        printStep("📋", `Result: ${resultPreview}${JSON.stringify(toolResult).length > 200 ? "..." : ""}`);

        await logStep(ticket.id, {
          event: "tool_result",
          iteration,
          tool: toolName,
          result: toolResult,
        });

        // Track actions
        result.actions.push({
          tool: toolName,
          arguments: args,
          result: toolResult,
        });

        // Detect key outcomes
        if (toolName === "escalate_to_human" && toolResult.escalated) {
          result.status = "escalated";
          printStep("🚨", `Escalated: ${toolResult.message}`);
        }
        if (toolName === "issue_refund" && toolResult.success) {
          result.status = "resolved";
          printStep("✅", `Refund issued: ${toolResult.refund_id}`);
        }
        if (toolName === "cancel_order" && toolResult.success) {
          result.status = "resolved";
          printStep("✅", "Order cancelled");
        }
        if (toolName === "initiate_exchange" && toolResult.success) {
          result.status = "resolved";
          printStep("✅", `Exchange: ${toolResult.message}`);
        }
        if (toolName === "send_customer_reply" && toolResult.sent) {
          printStep("📧", `Reply sent to ${args.customer_email}`);
          result.final_message = args.message;
          if (result.status !== "escalated") {
            result.status = "resolved";
          }
        }

        // Push tool result back
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(toolResult),
        });
      }

      // If we achieved resolution from tool calls, we're done
      if (result.status === "resolved" || result.status === "escalated") {
        break;
      }
      
      continue; // Back to the top of the loop for next model turn
    }

    // ── No tool calls = model is done reasoning ──
    const content = assistantMessage.content || "";
    messages.push({ role: "assistant", content });

    await logStep(ticket.id, {
      event: "model_response",
      iteration,
      content: content.slice(0, 500),
    });

    // If we already have a status from tool calls, we're done
    if (result.status === "resolved" || result.status === "escalated") {
      break;
    }

    // If the model provided a text response without tools, it might be the final answer
    if (content && !result.final_message) {
      result.final_message = content;
      // If no action was taken, mark as needs_clarification or resolved based on content
      if (result.actions.length === 0) {
        result.status = "needs_clarification";
      } else {
        result.status = "resolved";
      }
      break;
    }

    // Safety: break if model produces no tools and no content
    if (!content) {
      printStep("⚠️", "Model produced empty response — stopping.");
      result.status = "error";
      break;
    }
  }

  // If we exhausted iterations
  if (result.status === "unknown") {
    result.status = "max_iterations";
    printStep("⚠️", "Reached max iterations without resolution.");
  }

  // ── Final summary ──
  const statusEmoji =
    result.status === "resolved"
      ? "✅"
      : result.status === "escalated"
        ? "🚨"
        : result.status === "needs_clarification"
          ? "❓"
          : "⚠️";

  console.log(`\n  ${statusEmoji} Final status: ${result.status.toUpperCase()}`);
  console.log(`  📊 Tools called: ${result.actions.length}`);
  console.log(`  ${"─".repeat(56)}\n`);

  await logStep(ticket.id, {
    event: "agent_completed",
    status: result.status,
    actions_count: result.actions.length,
    final_message: result.final_message?.slice(0, 300) || "",
  });

  return result;
}
