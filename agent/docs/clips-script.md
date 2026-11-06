# Clips recording script: Sentinel Ember on Agent-Native

One take of the whole loop on the Eaton Fire replay: plan the next hour of drone coverage, change it by hand
and by asking the agent, write the cited briefing, approve, and check the plan in hindsight.

## How long

**Target: about 4 min 50 s (no more than 5:30).**

The official rules (https://www.builder.io/hackathon/rules) set **no length limit**. They only say: "Record a
public Clips demonstration showing the actual application in use" and "The recording must be viewable without
a login or access request."

Why about 4 to 5 minutes:

- Ben asked for a longer, clearer recording than the 3-minute Meta video: show where to click, what to press,
  and useful numbers.
- The full loop has seven steps. At under 5 minutes each step gets 30 to 45 seconds, long enough to show the click, wait
  for the result and read one number off the screen.
- Judges watch many entries. Past 5 minutes we would start repeating ourselves.

If we want more, record a second, longer walkthrough (8 to 10 min, both fires, the Drones tab and the Risk
tab) for the repo README and the live site. It is optional and not the entry.

## Before recording (checklist)

- [ ] **Browser:** desktop Chrome, window 1440 x 900 (or 1920 x 1080 screen at 100% zoom). Hide the
      bookmarks bar, close other tabs, turn off notifications. WebGL2 must work.
- [ ] **URL:** `[live site]/incident?fire=eaton&t=2025-01-08T16:00:00Z&tab=incident`
      (16:00 UTC = 8:00 AM PST, Jan 8 2025: the forecast is a Muse Spark one and some drones can fly. At 10 AM the wind grounds every drone.)
- [ ] **Clear old plans** for Eaton at that hour, so the plan starts empty and the drones are D1 to D6.
      Easiest: run on a fresh database
      (`DATABASE_URL=pglite:./data/pglite-recording AUTH_DISABLED=true pnpm dev`). On the live site:
      [how to clear plans: confirm with plan-domain].
- [ ] **Keys set:** `ANTHROPIC_API_KEY` (the chat defaults to Claude Sonnet 5.5).
      `MODEL_API_KEY` (Meta) is not needed for this loop, because the forecasts are cached.
- [ ] **Guide visible:** the "Start here" guide shows on first load. Use a fresh browser profile or clear
      site data so it appears.
- [ ] **Agent sidebar** open on a new, empty chat.
- [ ] **Layers on:** Spread Forecast (+1 h), perimeters, homes (structures), drone plan.
- [ ] **Dry run once.** The numbers below come from the 2026-11-06 dry run (fresh database, live agent).
      The agent places drones a little differently each run, so the percentages move by a few points.
      Read the screen on the take; do not read these out if the screen says something else.
- [ ] **Pick the drone to lock.** The script locks **D1**.
- [ ] **Nothing private on screen:** no email in the account menu, no API keys, no tax, ID or payment details.
- [ ] **Clips:** mic checked, recording set to **public** and viewable without a login.

## Prompts to paste (exact text)

Keep these in a text file next to the browser and paste them. Typing on camera is slow.

| # | When | Prompt |
| --- | --- | --- |
| P1 | Beat 4 (or press **Auto-plan**) | `Plan the next hour of drone coverage for this fire. Use six drones, watch the forecast front, and put the homes nearest the front first.` |
| P2 | Beat 6 | `Move the drone I selected onto the biggest flyable gap in the front near homes, keep D1 where it is, and tell me what that does to the score.` |
| P3 | Beat 7 | `Write the crew briefing for this plan. Cite a source for every number.` |
| P4 | Beat 11 (optional) | `Plan the next hour the same way, and keep D1 where it is.` |

## The script

Times are cumulative. Narration is short and plain on purpose; read it slowly.

| # | Time | On screen | Click / type | Narrator says | Useful data on screen |
| --- | --- | --- | --- | --- | --- |
| 1 | 0:00 to 0:15 | Eaton Fire on the 3D map, 8:00 AM PST, Jan 8 2025 | Nothing. Let the map sit. | "In the Palisades Fire, the first public fire map came 26 hours after the fire started. Our team had to evacuate in that fire. Sentinel Ember helps a crew plan where drones should watch next, by hand or by asking an agent." | Fire spread and burn scar on real terrain |
| 2 | 0:15 to 0:35 | Same view; point at the header line "Replay of the Jan 8, 2025 Eaton Fire" and the orange forecast line | Point at the header line, then at the forecast line | "This is a replay of the Eaton Fire, January 8th 2025, at 8 in the morning. The fire map comes from public records. The one-hour forecast was made earlier by Meta's Muse Spark." | Header: "Replay of the Jan 8, 2025 Eaton Fire" |
| 3 | 0:35 to 0:55 | Guide strip at the top of the map (it opens on step 2 of 6, "Ask the agent to plan"); orange forecast line on the map | Click **Steps ▾** on the guide strip to show all six steps. Scroll-zoom once toward the forecast line. | "The guide walks you through it. The orange line is where the forecast expects the fire's front in one hour. These are the homes near it." | Homes near the front: 3,795; forecast valid 9:00 AM PST |
| 4 | 0:55 to 1:25 | Agent sidebar | Click into the chat box, paste **P1**, press Enter. (Or click **Auto-plan** in the Plan panel, which sends the same request.) | "First, I'll ask the agent for a plan." *(wait, about 40 s)* "It placed six drones along the edge and says why for each one. It also wrote a first briefing." | Drones D1 to D6 appear with watch circles. Plan panel: **33%** of the forecast front watched (4.4 of 14 km), **2,114 of 3,795** homes, **0** grounded by wind |
| 5 | 1:25 to 1:55 | Map with drones; Plan panel | Grab the black dot of **D3** (a drag that starts off the dot pans the map) and drag it north onto the red, unwatched stretch of the front by Echo Mountain. Then hover the **D1** row in the drone list and click its lock icon. | "Now by hand. I drag D3 onto this unwatched stretch of the front. It turns grey: the wind up there is too strong to fly, so it sees nothing, and the score drops right away. I'll lock D1, so nobody moves it, me or the agent." | Coverage **33% to 25%**; homes watched **2,114 to 1,813**; **1** grounded; D3 grey, "grounded, gust 26.5 m/s", tagged "you"; D1 shows a lock |
| 6 | 1:55 to 2:30 | D3 selected (highlighted); agent sidebar | D3 is already selected after the drag (its row is highlighted). If it is not, click it once; clicking a selected drone again deselects it. Paste **P2**, press Enter. | "Same plan, now with the agent. I've selected D3. I don't name it. The agent sees what I selected, and moves it with the same action I used when I dragged. D1 stays locked." | Agent reply names D3 and moves it to the biggest flyable gap (about 1 km of fast front, 510 homes nearby); coverage **25% back to 32%**; homes **1,813 to 2,122**; **0** grounded; D1 unchanged; D3 tagged "agent" |
| 7 | 2:30 to 3:05 | Briefing panel filling in | Paste **P3**, press Enter. Wait for the briefing. | "Next, the briefing for the crew. Every number has to come from the data. The app re-checks each one before keeping it." | **3** paragraphs kept, all VERIFIED, 0 dropped; source chips **dronePlan**, **forecast**, **flyable cells** |
| 8 | 3:05 to 3:30 | Agent sidebar; then the briefing panel | Ask the agent **"How many of these homes will burn in the next hour?"** and let it answer. Then hover the source chip under the first paragraph. | "It won't make up a number the data can't support: our data says where the fire went, not which homes burn. And every number in the briefing traces back to a source, like this one." | Agent: "I can't tell you that. Nothing in this app forecasts how many homes will burn." Kept number **2122 of 3795 homes**, source tooltip "Drone plan score for 8 AM" |
| 9 | 3:30 to 3:50 | Plan panel, Approve button | Click **Approve**. | "When it looks right, I approve. The plan locks, and the replay moves to the next hour." | Plan status: approved; timeline jumps to 9:00 AM PST; the guide goes back to step 2 for the new hour |
| 10 | 3:50 to 4:20 | Hindsight card | The Hindsight card opens by itself under the Plan card. Point at it. | "Because this is a past fire, we can check the plan against where the fire really burned. The drones would have seen 29 percent of the ground that burned in that hour. The same six drones, evenly spaced, would have seen 19 percent." | This plan **29%**, baseline "evenly spaced drones" **19%**, of the **157 ha** that burned 8 to 9 AM |
| 11 | 4:20 to 4:35 | (Optional, cut if over time) next hour | Paste **P4**, press Enter (about 1 min). | "The loop goes on, hour by hour. At 9 AM the wind grounds almost everything. The agent keeps D1 where the crew left it, says it's grounded, and places only one more drone instead of padding the plan." | New plan for 9:00 AM: **0%** of a 24 km front, **137 of 4,799** homes, D1 grounded at 28.8 m/s, 2 of 6 drones placed |
| 12 | 4:35 to 4:50 | Whole screen: map, Plan panel, agent sidebar | Nothing. | "What's live: the agent, the plan, the score and the briefing check. What's cached: the fire forecast. What's simulated: the drones; none of them fly. Everything I clicked, the agent can do, and everything the agent did, I can see and change." | Status labels visible |

## Notes for the take

- **Say "the app,"** not any other word for it.
- **Do not round up.** Read the numbers exactly as the screen shows them.
- If the agent is slow, keep talking about what's on screen; cut dead time in Clips afterwards rather than
  re-recording.
- If a step fails on camera, stop and redo the take. Do not narrate over a fake result.
- **Numbers** were filled from the 2026-11-06 dry run (fresh database, Claude Sonnet 5.5, 600 m radius cap).
  The agent's placements vary a little per run; read the screen on the take.
- **Hindsight baseline** is what `hindsight-check` reports: the same number of evenly spaced drones.
- **If Enter does not send** a pasted prompt (it happened once on the first message of a fresh chat, with a
  React "Maximum update depth exceeded" error in the console), click the send arrow or reload; the draft is kept.
