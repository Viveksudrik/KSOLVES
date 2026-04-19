import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import JSZip from "jszip";

const EDGE_CASE_IDS = new Set(["TKT-005", "TKT-007", "TKT-013", "TKT-018", "TKT-001"]);

const categoryLabels = [
  { key: "refunds", label: "Refunds" },
  { key: "returns", label: "Returns" },
  { key: "cancellations", label: "Cancellations" },
  { key: "exchanges", label: "Exchanges" },
  { key: "policy_questions", label: "Policy Questions" },
  { key: "escalations", label: "Escalations" },
  { key: "fraud_edge_cases", label: "Fraud / Edge Cases" },
];

function CountUp({ value, suffix = "" }) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    let raf = null;
    const duration = 900;
    const start = performance.now();

    const tick = (time) => {
      const progress = Math.min((time - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(value * eased));
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      }
    };

    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [value]);

  return (
    <span>
      {display}
      {suffix}
    </span>
  );
}

function formatClock(timestamp) {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusBadge(ticket) {
  if (ticket.outcome === "ESCALATED") return { text: "Escalated", tone: "orange" };
  if (ticket.status === "pending" || ticket.status === "in_progress" || ticket.outcome === "RUNNING") {
    return { text: ticket.outcome === "RUNNING" ? "Running" : "Pending", tone: "blue" };
  }
  return { text: ticket.outcome === "DECLINED" ? "Declined" : "Resolved", tone: "green" };
}

function prettyOutcome(ticket) {
  if (ticket.outcome === "DECLINED") return "DECLINED";
  if (ticket.outcome === "ESCALATED") return "ESCALATED";
  if (ticket.outcome === "RUNNING") return "RUNNING";
  if (ticket.outcome === "RESOLVED") return "RESOLVED";
  return ticket.outcome || "PENDING";
}

function buildFallbackTimeline(ticket) {
  if (!ticket) return [];

  const steps = [];
  if (ticket.id === "TKT-005") {
    steps.push({
      icon: "⚡",
      title: "VIP exception path",
      detail: "Edge case expects approval via VIP customer notes for an expired return window.",
      timestamp: null,
    });
  }
  if (ticket.id === "TKT-007") {
    steps.push({
      icon: "✅",
      title: "60-day policy window",
      detail: "Edge case validates the electronics_accessories 60-day return policy.",
      timestamp: null,
    });
  }
  if (ticket.id === "TKT-013") {
    steps.push({
      icon: "⚠️",
      title: "Non-returnable policy",
      detail: "Edge case expects decline due to registered-online non-returnable constraint.",
      timestamp: null,
    });
  }
  if (ticket.id === "TKT-018" || ticket.fraud_signal) {
    steps.push({
      icon: "⚠️",
      title: "Fraud / social engineering signal",
      detail: "Language indicates policy manipulation pressure; this ticket is flagged as high-risk.",
      timestamp: null,
    });
  }
  if (ticket.id === "TKT-001") {
    steps.push({
      icon: "⚠️",
      title: "Escalation threshold",
      detail: "Edge case checks auto-escalation when refund amount exceeds $200.",
      timestamp: null,
    });
  }

  if (steps.length === 0) {
    steps.push({
      icon: "🧠",
      title: "Pending run",
      detail: "No execution log yet. Use Run Live to stream full agent reasoning.",
      timestamp: null,
    });
  }
  return steps;
}

function App() {
  const [tickets, setTickets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [visibleSteps, setVisibleSteps] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [runningTicketId, setRunningTicketId] = useState(null);
  const [sortAuditByOutcome, setSortAuditByOutcome] = useState(false);
  const sourceRef = useRef(null);

  const fetchTickets = async () => {
    setError("");
    try {
      const response = await axios.get("/api/tickets");
      const records = response.data?.tickets || [];
      setTickets(records);
      if (!selectedId && records.length > 0) {
        setSelectedId(records[0].id);
      }
    } catch (requestError) {
      setError(requestError.response?.data?.error || requestError.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTickets();
    return () => {
      if (sourceRef.current) sourceRef.current.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedTicket = useMemo(
    () => tickets.find((ticket) => ticket.id === selectedId) || null,
    [tickets, selectedId]
  );
  const timelineSteps = useMemo(() => {
    if (!selectedTicket) return [];
    if (selectedTicket.timeline?.length) return selectedTicket.timeline;
    return buildFallbackTimeline(selectedTicket);
  }, [selectedTicket]);

  useEffect(() => {
    if (!selectedTicket) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisibleSteps(0);
      return;
    }

    setVisibleSteps(0);
    const total = timelineSteps.length;
    if (total === 0) return;

    let shown = 0;
    const timer = setInterval(() => {
      shown += 1;
      setVisibleSteps(Math.min(shown, total));
      if (shown >= total) clearInterval(timer);
    }, 150);

    return () => clearInterval(timer);
  }, [selectedTicket, timelineSteps.length]);

  const metrics = useMemo(() => {
    const total = tickets.length;
    const processed = tickets.filter((ticket) => ticket.status !== "pending").length;
    const autonomous = tickets.filter((ticket) => ["RESOLVED", "DECLINED"].includes(ticket.outcome)).length;
    const escalated = tickets.filter((ticket) => ticket.outcome === "ESCALATED").length;

    const avgSteps =
      processed === 0
        ? 0
        : tickets
            .filter((ticket) => ticket.status !== "pending")
            .reduce((sum, ticket) => sum + (ticket.steps_count || 0), 0) / processed;

    const fraudCaught = tickets.filter(
      (ticket) =>
        ticket.fraud_signal &&
        (ticket.outcome === "ESCALATED" || ticket.outcome === "DECLINED" || ticket.outcome === "RESOLVED")
    ).length;

    const policyExceptions = tickets.filter((ticket) =>
      (ticket.log_entries || []).some((entry) => {
        if (entry.event !== "tool_result" || entry.tool !== "check_refund_eligibility") return false;
        const reason = String(entry.result?.reason || "").toLowerCase();
        return reason.includes("vip tier exception applied") || reason.includes("return window");
      })
    ).length;

    const categoryCounts = {
      refunds: 0,
      returns: 0,
      cancellations: 0,
      exchanges: 0,
      policy_questions: 0,
      escalations: escalated,
      fraud_edge_cases: tickets.filter((ticket) => ticket.fraud_signal || ticket.edge_case).length,
    };

    tickets.forEach((ticket) => {
      if (categoryCounts[ticket.category] !== undefined) {
        categoryCounts[ticket.category] += 1;
      }
    });

    return {
      total,
      processed,
      autonomous,
      escalated,
      autonomousPct: processed === 0 ? 0 : Math.round((autonomous / processed) * 100),
      escalatedPct: processed === 0 ? 0 : Math.round((escalated / processed) * 100),
      avgSteps: avgSteps.toFixed(1),
      fraudCaught,
      policyExceptions,
      categoryCounts,
    };
  }, [tickets]);

  const sortedTickets = useMemo(
    () =>
      [...tickets].sort((a, b) => {
        const aNumber = Number(a.id.replace(/\D+/g, ""));
        const bNumber = Number(b.id.replace(/\D+/g, ""));
        return aNumber - bNumber;
      }),
    [tickets]
  );

  const auditRows = useMemo(() => {
    const rows = [...tickets];
    if (sortAuditByOutcome) {
      rows.sort((a, b) => prettyOutcome(a).localeCompare(prettyOutcome(b)));
      return rows;
    }
    rows.sort((a, b) => Number(a.id.replace(/\D+/g, "")) - Number(b.id.replace(/\D+/g, "")));
    return rows;
  }, [sortAuditByOutcome, tickets]);

  const patchTicket = (ticketId, updater) => {
    setTickets((prev) => prev.map((ticket) => (ticket.id === ticketId ? updater(ticket) : ticket)));
  };

  const handleRunLive = (ticketId) => {
    if (sourceRef.current) sourceRef.current.close();
    setError("");
    setRunningTicketId(ticketId);
    setSelectedId(ticketId);

    patchTicket(ticketId, (ticket) => ({
      ...ticket,
      status: "in_progress",
      outcome: "RUNNING",
      log_entries: [],
      timeline: [],
      steps_count: 0,
    }));

    const source = new EventSource(`/api/run/${ticketId}`);
    sourceRef.current = source;

    source.addEventListener("step", (event) => {
      const payload = JSON.parse(event.data);
      patchTicket(ticketId, (ticket) => {
        const nextTimeline = [...(ticket.timeline || []), payload.timeline_step];
        const nextLogEntries = [...(ticket.log_entries || []), payload.entry];
        return {
          ...ticket,
          status: "in_progress",
          outcome: "RUNNING",
          timeline: nextTimeline,
          log_entries: nextLogEntries,
          steps_count: nextLogEntries.filter((entry) => entry.event === "tool_call").length,
        };
      });
    });

    source.addEventListener("complete", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.ticket) {
        setTickets((prev) => prev.map((ticket) => (ticket.id === ticketId ? payload.ticket : ticket)));
      }
      setRunningTicketId(null);
      source.close();
    });

    source.addEventListener("run_error", (event) => {
      const payload = JSON.parse(event.data);
      setError(payload.error || "Live run failed.");
      setRunningTicketId(null);
      source.close();
      fetchTickets();
    });

    source.onerror = () => {
      setRunningTicketId(null);
      source.close();
    };
  };

  const handleExportZip = async () => {
    const zip = new JSZip();
    tickets.forEach((ticket) => {
      zip.file(`${ticket.id}.json`, JSON.stringify(ticket.all_log_entries || [], null, 2));
    });

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "shopwave-logs.zip";
    link.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return <div className="app-loading">Loading ShopWave dashboard...</div>;
  }

  return (
    <div className="app-shell">
      <section className="hero-banner section-card">
        <h1>ShopWave Autonomous Support Agent</h1>
        <p>Resolving customer tickets end-to-end without human intervention</p>
        <div className="hero-counters">
          <div className="counter-card">
            <span>Total Tickets Processed</span>
            <strong>
              <CountUp value={metrics.processed} />/{metrics.total}
            </strong>
          </div>
          <div className="counter-card">
            <span>Autonomously Resolved</span>
            <strong>
              <CountUp value={metrics.autonomousPct} suffix="%" />
            </strong>
          </div>
          <div className="counter-card">
            <span>Escalated to Human</span>
            <strong>
              <CountUp value={metrics.escalatedPct} suffix="%" />
            </strong>
          </div>
        </div>
      </section>

      {error ? <div className="error-banner">{error}</div> : null}

      <section id="live-demo" className="section-card">
        <div className="section-header">
          <h2>Live Agent Demo</h2>
          {selectedTicket ? (
            <button
              className="run-live-btn"
              onClick={() => handleRunLive(selectedTicket.id)}
              disabled={runningTicketId !== null}
            >
              {runningTicketId === selectedTicket.id ? "Running..." : `Run ${selectedTicket.id} Live`}
            </button>
          ) : null}
        </div>

        <div className="live-grid">
          <aside className="tickets-panel">
            {sortedTickets.map((ticket) => {
              const badge = statusBadge(ticket);
              return (
                <button
                  key={ticket.id}
                  className={`ticket-card ${selectedId === ticket.id ? "active" : ""}`}
                  onClick={() => setSelectedId(ticket.id)}
                >
                  <div className="ticket-head">
                    <span>{ticket.id}</span>
                    <div className="ticket-badges">
                      {EDGE_CASE_IDS.has(ticket.id) ? <span className="edge-badge">⚡</span> : null}
                      <span className={`status-badge ${badge.tone}`}>{badge.text}</span>
                    </div>
                  </div>
                  <strong>{ticket.customer_name}</strong>
                  <p>{ticket.subject}</p>
                </button>
              );
            })}
          </aside>

          <div className="timeline-panel">
            {!selectedTicket ? (
              <p>Select a ticket to view agent reasoning.</p>
            ) : (
              <>
                <h3>{selectedTicket.id} • {selectedTicket.subject}</h3>
                <div className="timeline">
                  {timelineSteps.slice(0, visibleSteps).map((step, index) => (
                    <div key={`${step.timestamp || index}-${index}`} className="timeline-item">
                      <div className="timeline-icon">{step.icon}</div>
                      <div>
                        <div className="timeline-title">
                          <span>{step.title}</span>
                          <time>{formatClock(step.timestamp)}</time>
                        </div>
                        <p>{step.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div
                  className={`final-outcome ${
                    selectedTicket.outcome === "ESCALATED"
                      ? "outcome-escalated"
                      : selectedTicket.outcome === "DECLINED"
                        ? "outcome-declined"
                        : selectedTicket.outcome === "RESOLVED"
                          ? "outcome-resolved"
                          : "outcome-pending"
                  }`}
                >
                  <h4>{prettyOutcome(selectedTicket)}</h4>
                  <p className="reply-preview">
                    {selectedTicket.customer_reply || "No customer reply captured yet."}
                  </p>
                  <div className="outcome-meta">
                    <span>Total steps: {selectedTicket.steps_count || 0}</span>
                    <span>Time elapsed: {selectedTicket.duration_label || "—"}</span>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="section-card">
        <h2>Stats Grid</h2>
        <div className="stats-grid">
          <article>
            <h3>{metrics.autonomous}/20</h3>
            <p>Tickets Resolved Autonomously</p>
          </article>
          <article>
            <h3>{metrics.avgSteps}</h3>
            <p>Average Steps Per Ticket</p>
          </article>
          <article>
            <h3>{metrics.fraudCaught}</h3>
            <p>Fraud/Social Engineering Caught</p>
          </article>
          <article>
            <h3>{metrics.policyExceptions}</h3>
            <p>Policy Exceptions Applied</p>
          </article>
        </div>
      </section>

      <section className="section-card">
        <h2>Ticket Category Breakdown</h2>
        <div className="bars">
          {categoryLabels.map((category) => {
            const value = metrics.categoryCounts[category.key] || 0;
            const width = metrics.total === 0 ? 0 : Math.max((value / metrics.total) * 100, value > 0 ? 8 : 0);
            return (
              <div key={category.key} className="bar-row">
                <span>{category.label}: {value} tickets</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${width}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="section-card">
        <div className="section-header">
          <h2>Audit Log Viewer</h2>
          <div className="audit-actions">
            <button onClick={() => setSortAuditByOutcome((value) => !value)}>
              Sort by outcome: {sortAuditByOutcome ? "On" : "Off"}
            </button>
            <button onClick={handleExportZip}>Export ZIP</button>
          </div>
        </div>
        <div className="audit-table-wrap">
          <table className="audit-table">
            <thead>
              <tr>
                <th>Ticket ID</th>
                <th>Customer</th>
                <th>Issue</th>
                <th>Tools Called</th>
                <th>Outcome</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {auditRows.map((ticket) => (
                <tr
                  key={ticket.id}
                  onClick={() => {
                    setSelectedId(ticket.id);
                    document.getElementById("live-demo")?.scrollIntoView({ behavior: "smooth" });
                  }}
                >
                  <td>{ticket.id}</td>
                  <td>{ticket.customer_name}</td>
                  <td>{ticket.subject}</td>
                  <td>{ticket.steps_count || 0}</td>
                  <td>{prettyOutcome(ticket)}</td>
                  <td>{ticket.duration_label || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

export default App;
