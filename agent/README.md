# Sentinel Ember on Agent-Native

Plan where wildfire drones watch next, by hand or by asking an agent, on the same plan.

The app replays the January 2025 Eaton Fire on a 3D map of the real terrain. Ask the agent to plan the next
hour and it places up to six drones along the edge where the fire is forecast to be in an hour, avoiding
places where the wind is too strong to fly. The app scores the plan: how much of that edge the drones can see
and how many homes are near it. You can drag, lock or remove any drone yourself, or select one and ask the
agent to move it. The agent writes a crew briefing, and the app re-checks every number in it against the data
it cites before keeping it. Approve, move to the next hour, and compare the plan with what really burned.

It is a replay of a past fire. No drone flies.

## How it uses Agent-Native

- **Shared actions.** Every step is one `defineAction` in [`actions/`](actions): `create-drone-plan`,
  `update-drone-assignment`, `score-plan`, `save-briefing`, `approve-plan`, `hindsight-check`, plus the fire
  data actions (`get-forecast-front`, `flyable-cells`, `weather-at`, `structures-near`, ...). Dragging a drone
  on the map and asking the agent to move it both run `update-drone-assignment`. The Approve button and
  "approve this plan" both run `approve-plan`.
- **Shared data.** Plans, drones and briefings live in Postgres tables ([`server/db/schema.ts`](server/db/schema.ts)),
  with who made each change. What the agent does shows up on the map, and the other way round.
- **Shared application state.** The UI writes `navigation` (fire, time, selected drone) and `selection`;
  the agent reads them with `view-screen`, so "move the drone I selected" just works. Agent actions move the
  map through a one-shot `map-command` state key.
- **Skills and instructions.** [`.agents/skills/drone-planning`](.agents/skills/drone-planning/SKILL.md) and
  [`AGENTS.md`](AGENTS.md) teach the agent the planning loop.
- **The agent decides, plain code checks.** Scoring ([`server/plan/score.ts`](server/plan/score.ts)) and the
  briefing check ([`server/plan/cites.ts`](server/plan/cites.ts)) are ordinary code, so the agent can't inflate
  its own numbers.

## Run it

```bash
cd agent
pnpm install
cp .env.example .env    # set ANTHROPIC_API_KEY, or add a key in the app under Connect AI
pnpm dev                # copies fire data from ../web/public first
```

Open `/incident?fire=eaton&t=2025-01-08T16:00:00Z` (8 AM PST on Jan 8, 2025, the hour used in the recording).
For a clean plan, use a fresh local database: `DATABASE_URL=pglite:./data/pglite-fresh pnpm dev`.

Tests and types: `pnpm test`, `pnpm typecheck`. Any action also runs from the command line, for example
`pnpm action score-plan '{"planId":"..."}'`.

## What's new and what came before

Built Nov 6 to 9, 2026 for the Builder.io Agent-Native Hackathon, on top of our Meta hackathon project
(the map, fire data and forecasts in [`../web`](../web)). The full disclosure is in [CHANGES.md](CHANGES.md).
Started from the Agent-Native Chat template (`@agent-native/core` 0.225.1).
