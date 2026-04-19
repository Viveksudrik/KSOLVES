# Failure Modes and Handling

This document captures concrete failure scenarios observed or designed for this agent loop, plus how the current system handles them.

| Failure scenario | Trigger | Current handling in system | Outcome |
| --- | --- | --- | --- |
| Missing API credentials | `GROQ_API_KEY` is not set | `createClient()` throws immediately with a clear error (`GROQ_API_KEY is not set in .env`) | Fast fail before processing, no silent corruption |
| Rate-limit from model provider | Groq returns `429` | Agent retries with bounded backoff (`5s`, `10s`, `15s`) and logs retry context | Transient failures recover; persistent failures terminate as `error` |
| Tool schema validation failure | LLM emits invalid function arguments (seen in `TKT-008`, `TKT-019`) | API error is captured as `api_error`, written to ticket log, ticket status marked `error` | Failure is explicit and auditable; ticket is not falsely marked resolved |
| Missing customer/order data | Unknown email or invalid order ID | Tools (`get_customer`, `get_order`) return structured `found: false` responses; agent can ask for clarification or escalate | No crashes; safe fallback path |
| Policy-unsafe refund request | Refund amount exceeds `$200` | `check_refund_eligibility` flags ineligible reason; escalation tool is used for human handoff | Autonomous path blocked, policy is preserved |
| Infinite-loop risk in reasoning | Model keeps iterating without completion | Hard cap at `MAX_ITERATIONS = 10`; final state set to `max_iterations` | Run is bounded and terminates deterministically |

## Notes

- All critical transitions (`iteration_start`, `tool_call`, `tool_result`, `api_error`, `agent_completed`) are written to per-ticket JSON logs.
- This makes postmortem debugging straightforward even for failed or partially completed runs.
