/**
 * src/ingest.js — Ticket ingestion layer
 *
 * Reads tickets from data/tickets.json, normalizes each ticket into
 * a consistent internal schema, validates required fields, and
 * prepares tickets for the agent pipeline.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

/**
 * Load all support data from flat JSON files.
 */
export async function loadSupportData() {
  const [customers, orders, products, tickets, knowledgeBase] =
    await Promise.all([
      readJson("customers.json"),
      readJson("orders.json"),
      readJson("products.json"),
      readJson("tickets.json"),
      fs.readFile(path.join(DATA_DIR, "knowledge_base.md"), "utf8"),
    ]);

  return { customers, orders, products, tickets, knowledgeBase };
}

async function readJson(filename) {
  const raw = await fs.readFile(path.join(DATA_DIR, filename), "utf8");
  return JSON.parse(raw);
}

/**
 * Normalize a raw ticket into the internal schema.
 * Handles field name variations across sources.
 */
export function normalizeTicket(raw) {
  const id = raw.id || raw.ticket_id || raw.ticketId || null;
  const customerEmail =
    raw.customer_email || raw.customerEmail || raw.email || null;
  const customerId = raw.customerId || raw.customer_id || null;
  const orderId =
    raw.orderId || raw.order_id || extractOrderId(raw.issue || raw.body || "") || null;
  const subject = raw.subject || raw.title || "";
  const body = raw.issue || raw.body || raw.message || raw.description || "";
  const source = raw.source || "email";
  const createdAt = raw.createdAt || raw.created_at || new Date().toISOString();
  const priority = Number(raw.priority) || 1;
  const expectedAction = raw.expected_action || raw.expectedAction || null;

  return {
    id,
    customer_email: customerEmail,
    customer_id: customerId,
    order_id: orderId,
    subject,
    body,
    source,
    created_at: createdAt,
    priority,
    expected_action: expectedAction,
  };
}

/**
 * Extract an order ID from free-text body.
 */
function extractOrderId(text) {
  const match = text.match(/\b(ORD[-_]?\d{3,})\b/i);
  return match ? match[1].toUpperCase().replace("_", "-") : null;
}

/**
 * Validate a normalized ticket. Returns { valid, errors }.
 */
export function validateTicket(ticket) {
  const errors = [];

  if (!ticket.id) {
    errors.push("Missing ticket ID.");
  }
  if (!ticket.body && !ticket.subject) {
    errors.push("Missing issue description and subject.");
  }
  if (!ticket.customer_email) {
    errors.push("Missing customer email.");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Ingest a single ticket: normalize → validate → return result.
 */
export function ingestTicket(rawTicket) {
  const ticket = normalizeTicket(rawTicket);
  const validation = validateTicket(ticket);
  return { ticket, validation, ingested: validation.valid };
}

/**
 * Ingest all tickets from the data file.
 *
 * @param {Array} rawTickets
 * @returns {{ tickets: Array, summary: { total, ingested, rejected } }}
 */
export function ingestAll(rawTickets) {
  const results = rawTickets.map(ingestTicket);

  const total = results.length;
  const ingested = results.filter((r) => r.ingested).length;
  const rejected = total - ingested;

  return {
    results,
    summary: { total, ingested, rejected },
  };
}
