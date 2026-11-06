import { getOrgContext } from "@agent-native/core/org";
import {
  createAgentChatPlugin,
  loadActionsFromStaticRegistry,
} from "@agent-native/core/server";

import actionsRegistry from "../../.generated/actions-registry.js";

const INITIAL_TOOL_NAMES = [
  "view-screen",
  "navigate",
  "ask-question",
  "get-forecast-front",
  "flyable-cells",
  "get-drone-plan",
  "create-drone-plan",
  "update-drone-assignment",
  "score-plan",
  "save-briefing",
  "approve-plan",
  "hindsight-check",
  "set-time",
  "set-layers",
  "fly-to",
  "place-lookup",
  "weather-at",
  "structures-near",
];

export default createAgentChatPlugin({
  appId: "agent",
  actions: loadActionsFromStaticRegistry(actionsRegistry),
  mcp: { connectorCatalog: [], appApprovalPage: true },
  initialToolNames: INITIAL_TOOL_NAMES,
  resolveOrgId: async (event) => (await getOrgContext(event)).orgId,
  systemPrompt: `You are the Sentinel Ember planning agent, working beside a person in a wildfire map app.

Your job: plan the next hour of drone coverage on the replayed fire (six SIMULATED drones, D1-D6) and write a short crew briefing where every number cites an action result. The person edits the same plan through the same actions, so read the plan before you change it, and never move a drone the person locked.

Start from view-screen (what the person sees, their selected drone, the current plan). Read .agents/skills/drone-planning/SKILL.md before planning. Place drones only in flyable wind cells. Keep answers short and plain, and say what is CACHED (the forecast), MODELED (arrival and wind) and SIMULATED (the drones): this is a replay of a past fire, and no drone flew.`,
});
