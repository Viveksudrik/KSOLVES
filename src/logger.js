/**
 * src/logger.js — Per-ticket audit logger
 *
 * Creates one JSON log file per ticket in /logs/{ticket_id}.json.
 * Each file contains an array of timestamped log entries.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, "..", "logs");
const ticketSubscribers = new Map();

function notifySubscribers(ticketId, record) {
  const listeners = ticketSubscribers.get(ticketId);
  if (!listeners || listeners.size === 0) {
    return;
  }

  // Subscriber errors should not block logging to disk.
  for (const listener of listeners) {
    try {
      listener(record);
    } catch {
      // Intentionally ignored.
    }
  }
}

/**
 * Append a log entry to the per-ticket log file.
 * Creates the log file if it doesn't exist.
 *
 * @param {string} ticketId — The ticket ID (used as filename)
 * @param {object} entry — The log entry to append
 */
export async function logStep(ticketId, entry) {
  await fs.mkdir(LOG_DIR, { recursive: true });

  const filePath = path.join(LOG_DIR, `${ticketId}.json`);
  const record = {
    timestamp: new Date().toISOString(),
    ...entry,
  };

  let records = [];
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      records = parsed;
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  records.push(record);
  await fs.writeFile(filePath, JSON.stringify(records, null, 2), "utf8");
  notifySubscribers(ticketId, record);
}

/**
 * Read the full log for a ticket.
 *
 * @param {string} ticketId
 * @returns {Array} — Array of log entries
 */
export async function readTicketLog(ticketId) {
  const filePath = path.join(LOG_DIR, `${ticketId}.json`);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/**
 * Subscribe to in-memory ticket log steps as they are written.
 *
 * @param {string} ticketId
 * @param {(entry: object) => void} listener
 * @returns {() => void} unsubscribe function
 */
export function subscribeToTicket(ticketId, listener) {
  if (!ticketSubscribers.has(ticketId)) {
    ticketSubscribers.set(ticketId, new Set());
  }

  const listeners = ticketSubscribers.get(ticketId);
  listeners.add(listener);

  return () => {
    const current = ticketSubscribers.get(ticketId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      ticketSubscribers.delete(ticketId);
    }
  };
}
