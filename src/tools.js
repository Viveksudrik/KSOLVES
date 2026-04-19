/**
 * src/tools.js — All 10 tool definitions (schemas) + handler functions
 *
 * Tools the agent can call via function calling:
 *  1. get_customer          — look up customer by email
 *  2. get_order             — look up order by ID or customer email
 *  3. check_refund_eligibility — policy check for refund
 *  4. issue_refund          — mock-issue a refund
 *  5. cancel_order          — cancel if still processing
 *  6. initiate_exchange     — exchange with stock check
 *  7. check_order_status    — return status + tracking
 *  8. search_knowledge_base — keyword search through policies
 *  9. escalate_to_human     — escalate with full context
 * 10. send_customer_reply   — final reply to the customer
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Return window by product category (days) ────────────────────────
const RETURN_WINDOWS = {
  electronics_accessories: 60,
  high_value_electronics: 15,
  electronics: 30,
  home_appliances: 30,
  home: 30,
  footwear: 30,
  sports: 30,
  sports_fitness: 30,
};

const DEFAULT_RETURN_WINDOW = 30;

// ── Tool definitions (OpenAI function-calling format, works via Gemini compat endpoint) ──

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "get_customer",
      description:
        "Look up a customer record by their email address. Returns customer details including tier, order history, and any special notes.",
      parameters: {
        type: "object",
        properties: {
          email: {
            type: "string",
            description: "The customer's email address.",
          },
        },
        required: ["email"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_order",
      description:
        "Look up an order by order_id. If order_id is not provided, falls back to the most recent order for the given customer_email.",
      parameters: {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description: "The order ID to look up.",
          },
          customer_email: {
            type: "string",
            description:
              "Customer email to find the latest order if order_id is not available.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_refund_eligibility",
      description:
        "Check whether an order is eligible for a refund based on return window, order status, product category, and customer tier. Call this BEFORE issue_refund.",
      parameters: {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description: "The order ID to check eligibility for.",
          },
          reason: {
            type: "string",
            description:
              "The reason for the refund request (e.g. 'defective', 'wrong item', 'changed mind').",
          },
        },
        required: ["order_id", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "issue_refund",
      description:
        "Issue a refund for an order. Only call this AFTER check_refund_eligibility confirms the order is eligible. Refunds over $200 must be escalated instead.",
      parameters: {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description: "The order ID to refund.",
          },
          amount: {
            type: "number",
            description: "The refund amount in dollars.",
          },
          reason: {
            type: "string",
            description: "The reason for issuing the refund.",
          },
        },
        required: ["order_id", "amount", "reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_order",
      description:
        'Cancel an order. Only works if the order status is "processing". Shipped or delivered orders cannot be cancelled.',
      parameters: {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description: "The order ID to cancel.",
          },
        },
        required: ["order_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "initiate_exchange",
      description:
        "Initiate an exchange for a wrong item, wrong size, or wrong colour. Checks stock availability (if in stock, arranges exchange; if not, offers refund).",
      parameters: {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description: "The order ID to exchange.",
          },
          issue: {
            type: "string",
            description:
              "Description of the issue (wrong size, wrong colour, wrong item).",
          },
          desired_variant: {
            type: "string",
            description:
              "The desired variant (e.g. 'Size 10', 'Blue'). Optional.",
          },
        },
        required: ["order_id", "issue"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_order_status",
      description:
        "Check the current status of an order, including tracking number and estimated delivery if available.",
      parameters: {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description: "The order ID to check status for.",
          },
        },
        required: ["order_id"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description:
        "Search ShopWave's knowledge base / policy documents for relevant information. Use this for return policies, warranty rules, refund rules, escalation guidelines.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The search query (e.g. 'return window electronics', 'warranty policy').",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_human",
      description:
        "Escalate a ticket to a human support agent. Use when: warranty claim, refund > $200, fraud signals, conflicting data, or confidence < 0.6.",
      parameters: {
        type: "object",
        properties: {
          ticket_id: {
            type: "string",
            description: "The ticket ID being escalated.",
          },
          reason: {
            type: "string",
            description: "Why the ticket is being escalated.",
          },
          summary: {
            type: "string",
            description: "A concise summary of the issue and what was attempted.",
          },
          attempted_steps: {
            type: "string",
            description: "What the agent verified or attempted before escalating.",
          },
          recommended_action: {
            type: "string",
            description: "The agent's recommended resolution path.",
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high", "urgent"],
            description: "Escalation priority level.",
          },
        },
        required: ["ticket_id", "reason", "summary", "priority"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_customer_reply",
      description:
        "Send a reply to the customer. This should be the LAST tool called — use it to deliver the final resolution or next-steps message.",
      parameters: {
        type: "object",
        properties: {
          ticket_id: {
            type: "string",
            description: "The ticket ID being responded to.",
          },
          customer_email: {
            type: "string",
            description: "The customer's email address.",
          },
          subject: {
            type: "string",
            description: "The email subject line.",
          },
          message: {
            type: "string",
            description: "The full reply message to the customer.",
          },
        },
        required: ["ticket_id", "customer_email", "subject", "message"],
        additionalProperties: false,
      },
    },
  },
];

// ── Helper functions ────────────────────────────────────────────────

function daysBetween(dateStr) {
  const ms = Date.parse(dateStr);
  if (!Number.isFinite(ms)) return null;
  const today = new Date("2024-03-15");
  return Math.floor((today.getTime() - ms) / (1000 * 60 * 60 * 24));
}

function getReturnWindow(category) {
  return RETURN_WINDOWS[category] || DEFAULT_RETURN_WINDOW;
}

// ── Tool handler factory ────────────────────────────────────────────

/**
 * Create all tool handler functions, closed over the loaded data.
 *
 * @param {{ customers, orders, products, knowledgeBase }} data
 * @returns {Object} — map of tool_name → async handler function
 */
export function createToolHandlers(data) {
  const { customers, orders, products, knowledgeBase } = data;

  // Build lookup maps
  const productMap = new Map(products.map((p) => [String(p.id), p]));

  function findCustomerByEmail(email) {
    return customers.find(
      (c) => String(c.email).toLowerCase() === String(email).toLowerCase()
    );
  }

  function findOrderById(orderId) {
    return orders.find((o) => String(o.id) === String(orderId));
  }

  function findLatestOrderByEmail(email) {
    const customer = findCustomerByEmail(email);
    if (!customer) return null;
    const customerOrders = orders
      .filter((o) => String(o.customerId) === String(customer.id))
      .sort((a, b) => new Date(b.placedAt) - new Date(a.placedAt));
    return customerOrders[0] || null;
  }

  function getOrderAmount(order) {
    if (order.amount != null) return Number(order.amount);
    if (Array.isArray(order.productIds)) {
      let sum = 0;
      for (const pid of order.productIds) {
        const product = productMap.get(String(pid));
        if (product?.price) sum += Number(product.price);
      }
      return sum > 0 ? Number(sum.toFixed(2)) : null;
    }
    return null;
  }

  return {
    // ── 1. get_customer ──
    get_customer: async ({ email }) => {
      const customer = findCustomerByEmail(email);
      if (!customer) {
        return { found: false, message: `No customer found with email: ${email}` };
      }
      return { found: true, customer };
    },

    // ── 2. get_order ──
    get_order: async ({ order_id, customer_email }) => {
      let order = null;
      if (order_id) {
        order = findOrderById(order_id);
      }
      if (!order && customer_email) {
        order = findLatestOrderByEmail(customer_email);
      }
      if (!order) {
        return {
          found: false,
          message: order_id
            ? `No order found with ID: ${order_id}`
            : `No orders found for email: ${customer_email}`,
        };
      }
      return { found: true, order };
    },

    // ── 3. check_refund_eligibility ──
    check_refund_eligibility: async ({ order_id, reason }) => {
      const order = findOrderById(order_id);
      if (!order) {
        return { eligible: false, reason: `Order ${order_id} not found.` };
      }

      const status = String(order.status).toLowerCase();
      const normalizedReason = String(reason || "").toLowerCase();
      const amount = getOrderAmount(order);
      const linkedProducts = (order.productIds || [])
        .map((pid) => productMap.get(String(pid)))
        .filter(Boolean);
      const category = linkedProducts[0]?.category || "general";
      const returnWindowDays = getReturnWindow(category);
      const daysSinceDelivery = order.delivery_date
        ? daysBetween(order.delivery_date)
        : daysBetween(order.placedAt);

      // Check registered online (non-returnable)
      const orderRegistered =
        order.notes && /registered online/i.test(order.notes);

      // Customer tier for exceptions
      const customer = customers.find(
        (c) => String(c.id) === String(order.customerId)
      );
      const tier = String(customer?.tier || "standard").toLowerCase();

      // Build reasons for ineligibility
      const reasons = [];

      if (status === "refunded") {
        reasons.push("Order has already been refunded.");
      }

      if (status !== "delivered" && status !== "refunded") {
        reasons.push(
          `Order status is "${status}" — must be "delivered" to refund.`
        );
      }

      const returnWindowExpired =
        daysSinceDelivery !== null && daysSinceDelivery > returnWindowDays;
      const bypassesWindow =
        normalizedReason === "defective" ||
        normalizedReason === "damaged" ||
        normalizedReason === "wrong item";
      const hasVipExceptionNote =
        !!customer?.notes &&
        /extended return window|standing exception/i.test(customer.notes);
      const vipExceptionApplied =
        returnWindowExpired &&
        !bypassesWindow &&
        tier === "vip" &&
        hasVipExceptionNote;

      if (returnWindowExpired && !bypassesWindow && !vipExceptionApplied) {
        reasons.push(
          `Return window expired: ${daysSinceDelivery} days since delivery (limit: ${returnWindowDays} days for ${category}).`
        );
      }

      if (orderRegistered && normalizedReason !== "defective") {
        reasons.push("Item was registered online — non-returnable per policy.");
      }

      if (amount > 200) {
        reasons.push(
          `Refund amount ($${amount}) exceeds $200 — requires human escalation.`
        );
      }

      const eligible = reasons.length === 0;
      const eligibleByCategoryWindow =
        eligible && !vipExceptionApplied && !bypassesWindow;

      let outcomeReason;
      if (eligible && vipExceptionApplied) {
        outcomeReason =
          "Return window expired — VIP tier exception applied per customer notes";
      } else if (eligibleByCategoryWindow && daysSinceDelivery !== null) {
        outcomeReason = `Within ${returnWindowDays}-day ${category} return window (${daysSinceDelivery} days since delivery)`;
      } else if (returnWindowExpired && !bypassesWindow && !vipExceptionApplied) {
        outcomeReason = `Return window expired (${daysSinceDelivery} days since delivery, limit ${returnWindowDays} days)`;
      } else if (eligible) {
        outcomeReason = "Order is eligible for refund.";
      } else {
        outcomeReason = reasons.join(" ");
      }

      return {
        eligible,
        order_id,
        days_since_delivery: daysSinceDelivery,
        return_window_days: returnWindowDays,
        category,
        customer_tier: tier,
        amount,
        reason: outcomeReason,
        reasons,
      };
    },

    // ── 4. issue_refund ──
    issue_refund: async ({ order_id, amount, reason }) => {
      const order = findOrderById(order_id);
      if (!order) {
        return {
          success: false,
          message: `Order ${order_id} not found.`,
        };
      }

      if (amount > 200) {
        return {
          success: false,
          message: `Refund amount $${amount} exceeds $200 limit. Must escalate to human.`,
        };
      }

      // Mock: mark order as refunded
      order.status = "refunded";
      order.refund_status = "refunded";

      const refundId = `REF-${Date.now()}`;
      return {
        success: true,
        refund_id: refundId,
        amount,
        message: `Refund of $${amount} issued for order ${order_id}. Refund ID: ${refundId}. Reason: ${reason}. Processing time: 5–7 business days.`,
      };
    },

    // ── 5. cancel_order ──
    cancel_order: async ({ order_id }) => {
      const order = findOrderById(order_id);
      if (!order) {
        return {
          success: false,
          message: `Order ${order_id} not found.`,
        };
      }

      if (String(order.status).toLowerCase() !== "processing") {
        return {
          success: false,
          message: `Cannot cancel order ${order_id} — status is "${order.status}". Only orders in "processing" status can be cancelled.`,
        };
      }

      // Mock: mark as cancelled
      order.status = "cancelled";
      return {
        success: true,
        message: `Order ${order_id} has been cancelled. Confirmation email will be sent within 1 hour.`,
      };
    },

    // ── 6. initiate_exchange ──
    initiate_exchange: async ({ order_id, issue, desired_variant }) => {
      const order = findOrderById(order_id);
      if (!order) {
        return {
          success: false,
          message: `Order ${order_id} not found.`,
        };
      }

      // Mock: 70% chance item is in stock
      const inStock = Math.random() < 0.7;
      const exchangeId = `EXC-${Date.now()}`;

      if (inStock) {
        return {
          success: true,
          exchange_id: exchangeId,
          in_stock: true,
          message: `Exchange initiated for order ${order_id}. Issue: ${issue}.${
            desired_variant ? ` Desired variant: ${desired_variant}.` : ""
          } The correct item is in stock and will be shipped. A return label for the original item will be emailed.`,
        };
      }

      // Out of stock — offer refund instead
      const amount = getOrderAmount(order);
      return {
        success: true,
        exchange_id: exchangeId,
        in_stock: false,
        message: `The desired item is currently out of stock. A full refund of $${amount} is offered instead. Issue: ${issue}.`,
      };
    },

    // ── 7. check_order_status ──
    check_order_status: async ({ order_id }) => {
      const order = findOrderById(order_id);
      if (!order) {
        return {
          status: "not_found",
          message: `Order ${order_id} not found.`,
        };
      }

      const result = {
        status: order.status,
        order_id: order.id,
        message: `Order ${order_id} is currently "${order.status}".`,
      };

      // Extract tracking info from notes if available
      const trackingMatch = order.notes?.match(/Tracking:\s*(TRK-\w+)/i);
      if (trackingMatch) {
        result.tracking_number = trackingMatch[1];
      }

      // Extract estimated delivery from notes
      const deliveryMatch = order.notes?.match(
        /Expected delivery\s+(\d{4}-\d{2}-\d{2})/i
      );
      if (deliveryMatch) {
        result.estimated_delivery = deliveryMatch[1];
      }

      if (order.delivery_date) {
        result.delivered_at = order.delivery_date;
      }

      return result;
    },

    // ── 8. search_knowledge_base ──
    search_knowledge_base: async ({ query }) => {
      const q = query.toLowerCase();
      const lines = knowledgeBase.split("\n");
      const matches = [];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          // Include the matching line plus 2 lines of context
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length - 1, i + 2);
          const snippet = lines.slice(start, end + 1).join("\n");
          matches.push(snippet);
        }
      }

      if (matches.length === 0) {
        // Fallback: try individual words
        const words = q.split(/\s+/).filter((w) => w.length > 3);
        for (const word of words) {
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(word)) {
              const start = Math.max(0, i - 1);
              const end = Math.min(lines.length - 1, i + 2);
              matches.push(lines.slice(start, end + 1).join("\n"));
            }
          }
        }
      }

      // Deduplicate and limit
      const unique = [...new Set(matches)].slice(0, 10);
      return {
        result: unique.length > 0
          ? unique.join("\n---\n")
          : "No relevant policy found for this query.",
      };
    },

    // ── 9. escalate_to_human ──
    escalate_to_human: async ({
      ticket_id,
      reason,
      summary,
      attempted_steps,
      recommended_action,
      priority,
    }) => {
      const caseId = `ESC-${Date.now()}`;
      return {
        escalated: true,
        case_id: caseId,
        message: `Ticket ${ticket_id} escalated to human support (priority: ${priority}). Case ID: ${caseId}. Reason: ${reason}.`,
        summary,
        attempted_steps: attempted_steps || "N/A",
        recommended_action: recommended_action || "N/A",
      };
    },

    // ── 10. send_customer_reply ──
    send_customer_reply: async ({
      ticket_id,
      customer_email,
      subject,
      message,
    }) => {
      const messageId = `MSG-${Date.now()}`;
      return {
        sent: true,
        message_id: messageId,
        message: `Reply sent to ${customer_email} for ticket ${ticket_id}. Subject: "${subject}". Message ID: ${messageId}.`,
      };
    },
  };
}
