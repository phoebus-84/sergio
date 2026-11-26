# The browser connects through an Agent Gateway

## Status

Accepted, amended by [ADR-0048](0048-tools-written-once-served-to-any-harness) and [ADR-0057](0057-every-harness-and-any-acp-agent): the gateway runs a Pi process, a Claude Agent SDK session, or any agent that speaks ACP (`AVG_AGENT_BACKEND`).

## Decision

The web GUI connects to a trusted Agent Gateway rather than directly owning Pi subprocesses, JSONL streams, filesystem access, or credentials. The gateway associates persistent Pi RPC sessions with episodes, translates anchored comments into prompt, steer, or follow-up messages, bridges extension UI requests, survives browser refreshes and process restarts, and multiplexes production events to authenticated clients.
