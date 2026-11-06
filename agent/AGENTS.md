# Sentinel Ember — Agent Guide

Chat is the minimal chat-first agent-native app. `/` redirects to shared sign-in, then `/home`, the editable Get started page. Chat lives at `/chat`; new chats start there. Actions carry capabilities; screens exist only for durable workflows.

## Skills

Search with `rg --hidden --follow`; read the exact linked guide before deeper work. `.agents/skills/build-an-app/SKILL.md` — start here for vague requests to create a domain app. `.agents/skills/adding-a-feature/SKILL.md` — cross-area feature checklist. Data/integrations: `.agents/skills/actions/SKILL.md`, `.agents/skills/storing-data/SKILL.md`, `.agents/skills/security/SKILL.md`, `.agents/skills/secrets/SKILL.md`, `.agents/skills/sharing/SKILL.md`. UI: `.agents/skills/frontend-design/SKILL.md`, `.agents/skills/shadcn-ui/SKILL.md`, `.agents/skills/client-side-routing/SKILL.md`. Agent context/workflows: `.agents/skills/context-awareness/SKILL.md`, `.agents/skills/real-time-sync/SKILL.md`, `.agents/skills/reliable-mutations/SKILL.md`, `.agents/skills/performance/SKILL.md`, `.agents/skills/delegate-to-agent/SKILL.md`. Framework: `.agents/skills/agent-native-docs/SKILL.md`, `.agents/skills/agent-native-toolkit/SKILL.md`, `.agents/skills/customizing-agent-native/SKILL.md`.

Use local docs only (no web research): `pnpm action docs-search --query "<topic>"`, `pnpm action docs-search --slug "<slug>"`, `pnpm action docs-search --list`, `pnpm action source-search --query "<pattern>"`, `pnpm action source-search --path <path>`, or `pnpm action source-search --list`. For external-agent integrations, read `pnpm action docs-search --slug "external-agents"`.

## Core rules

- UI feedback: target 100 ms, never exceed 400 ms; acknowledge before network work.
- Normal app data must flow through actions. Keep actions deterministic and focused; use agent chat/AgentSidebar for AI work and follow-ups in the same thread. Keep structured state in SQL and large files in configured storage; persist references only.
- For external integrations, inspect the workspace/provider connection catalog first; reuse its scoped resolver. Never hardcode credentials, webhook URLs, or private/customer data.
- Never fabricate. Report failures and recover; verify writes by reading the row or screen. Navigation is in `<current-screen>`; use `view-screen` for fresh visible-record details.

For custom branding, keep `server/plugins/agent-native-email-branding.ts` aligned: `app.name` appears in transactional email and optional `app.logoUrl` must be an absolute HTTPS URL.

## Drone planning (the product loop)

Sentinel Ember replays the January 2025 Eaton and Palisades fires on a 3D map (`/incident`). The agent plans one hour of SIMULATED drone coverage (D1-D6) on the replayed fire and writes a cited crew briefing; the person edits the same plan through the same actions. Read `.agents/skills/drone-planning/SKILL.md` before planning.
- Read: `view-screen`, `get-forecast-front {fire,t}` (note `method`), `flyable-cells {fire,t}`, `get-drone-plan`, `score-plan {planId}`, and the fire data actions (`place-lookup`, `arrival-at`, `street-fire-timeline`, `fire-state-at`, `weather-at`, `fire-events`, `structures-near`, `ignition-summary`, `exposure-stats`), which return `{result, cites}`.
- Write: `create-drone-plan` (whole plan, atomic, keeps locked drones), `update-drone-assignment` (one drone), `save-briefing`, `edit-briefing-paragraph`, `approve-plan` (only when the person asks; locks and moves the map to t+1h).
- Move the screen with `set-time`, `set-fire`, `set-tab`, `set-layers`, `fly-to` (they write the one-shot `map-command` app-state key).
- Place watch points only in flyable cells (gust <= 12 m/s at 120 m). Never move a locked drone. Iterate on `score.gaps` at most 3 times.
- Every briefing number must come from a cited action. The server drops paragraphs with uncited numbers, addresses or talk of what started the fire; fix and resave.
- After approval, `hindsight-check` compares the plan with an even-spacing baseline on MODELED arrival data.
- Labels: forecast CACHED, arrival and wind MODELED, drones SIMULATED; a replay, no drone flew. At Eaton 2025-01-08T18Z the wind grounds all six drones; say so.
- Verify writes by reading the returned plan/score; report the plan id, coverage, grounded count, and paragraphs kept and dropped.

## Application state

- `navigation` describes the view and selected ids. Chat is `chat` at `/chat` and `/chat/<threadId>`; the Get started page is `home` at `/home`; `/` opens shared sign-in/signup.
- Use `navigate` when supported and `view-screen` for a fresh read of visible details; basic navigation is already in `<current-screen>`.

## Building a domain app

Choose the primary workflow and route before editing. Add a domain route under `app/routes/` and set `app.homePath` in `server/plugins/agent-native-email-branding.ts` with `defineAppConfig`. The default Get started page lives at `/home`, and Chat stays at `/chat`; edit `app/routes/home.tsx` when replacing that page with a domain-specific home. Add a static link in `app/components/layout/Sidebar.tsx` before `ChatThreadsSection`; `Header.tsx` uses `APP_TITLE` elsewhere. Shared sidebar and AgentInspector remain.

Use `adding-a-feature` for functional parity and `frontend-design` for a user-facing screen. Keep feature guidance here; do not rewrite `README.md` or `DESIGN.md`. After all edits, run one typecheck, one doctor check, and one browser smoke of the primary workflow, including overlap rejection, cancellation freeing the slot, and authenticated landing. Skip production build and extra test suites.

Before building common workspace or agent UI, read `agent-native-toolkit`; for supported customization, read `customizing-agent-native`.

- Guarded verification: run `pnpm agent-native:doctor`; fix findings before done.
