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
- [ ] **Keys set:** the agent's model key ([`ANTHROPIC_API_KEY`, pending the team's choice of model]).
      `MODEL_API_KEY` (Meta) is not needed for this loop, because the forecasts are cached.
- [ ] **Guide visible:** the "Start here" guide shows on first load. Use a fresh browser profile or clear
      site data so it appears.
- [ ] **Agent sidebar** open on a new, empty chat.
- [ ] **Layers on:** Spread Forecast (+1 h), perimeters, homes (structures), drone plan.
- [ ] **Dry run once.** Write down the real numbers and fill every `[placeholder]` below, so the narration
      matches the screen. Note which drone sits nearest the homes; the script calls it **D3**.
- [ ] **Pick the drone to lock.** The script locks **D1**.
- [ ] **Nothing private on screen:** no email in the account menu, no API keys, no tax, ID or payment details.
- [ ] **Clips:** mic checked, recording set to **public** and viewable without a login.

## Prompts to paste (exact text)

Keep these in a text file next to the browser and paste them. Typing on camera is slow.

| # | When | Prompt |
| --- | --- | --- |
| P1 | Beat 4 (or press **Auto-plan**) | `Plan the next hour of drone coverage for this fire. Use six drones, watch the forecast front, and put the homes nearest the front first.` |
| P2 | Beat 6 | `Move the drone I selected about 500 m closer to the homes on [street name from the dry run], keep D1 where it is, and tell me what that does to the score.` |
| P3 | Beat 7 | `Write the crew briefing for this plan. Cite a source for every number.` |
| P4 | Beat 10 (optional) | `Plan the next hour the same way, and keep D1 where it is.` |

## The script

Times are cumulative. Narration is short and plain on purpose; read it slowly.

| # | Time | On screen | Click / type | Narrator says | Useful data on screen |
| --- | --- | --- | --- | --- | --- |
| 1 | 0:00 to 0:15 | Eaton Fire on the 3D map, 3:30 PM PST, Jan 8 2025 | Nothing. Let the map sit. | "In the Palisades Fire, the first public fire map came 26 hours after the fire started. Our team had to evacuate in that fire. Sentinel Ember helps a crew plan where drones should watch next, by hand or by asking an agent." | Fire spread and burn scar on real terrain |
| 2 | 0:15 to 0:35 | Same view; point the cursor at the status labels | Hover the **CACHED** label on the forecast layer | "This is a replay of the Eaton Fire, January 8th 2025, at 3:30 in the afternoon. No drones fly here. The fire map comes from public records. The one-hour forecast was made earlier by Meta's Muse Spark and saved." | Labels: CACHED forecast, MODELED arrival times |
| 3 | 0:35 to 0:55 | "Start here" guide, step 1 highlighted; orange forecast line on the map | Click guide step 1 (**See the forecast**). Scroll-zoom once toward the forecast line. | "The guide walks you through it. The orange line is where the forecast expects the fire's front in one hour. These are the homes near it." | Homes near the front: [N homes]; forecast for [4:30 PM] |
| 4 | 0:55 to 1:25 | Agent sidebar | Click into the chat box, paste **P1**, press Enter. (Or click **Auto-plan** in the Plan panel, which sends the same request.) | "First, I'll ask the agent for a plan." *(wait)* "It placed six drones along the edge and says why for each one." | Drones D1 to D6 appear with watch circles. Plan panel: front coverage [X%], [Y] of [N] homes watched, [Z] drones grounded by wind |
| 5 | 1:25 to 1:55 | Map with drones; Plan panel | Drag **D3** onto a red (unwatched) stretch of the front. Then click the lock icon next to **D1** in the drone list. | "Now by hand. I drag D3 off the part of the front it already shares with D2, onto an unwatched stretch. The score updates right away. I'll lock D1, so nobody moves it, me or the agent." | Coverage changes [X%] to [X2%]; homes watched [Y] to [Y2]; D3 tagged "moved by person"; D1 locked |
| 6 | 1:55 to 2:30 | D3 selected (highlighted); agent sidebar | Click **D3** on the map to select it. Paste **P2**, press Enter. | "Same plan, now with the agent. I've selected D3. I don't name it. The agent sees what I selected, and moves it with the same action I used when I dragged. D1 stays locked." | Agent reply names D3; D3 moves on the map; new coverage [X3%]; D1 unchanged; D3 tagged "moved by agent" |
| 7 | 2:30 to 3:05 | Briefing panel filling in | Paste **P3**, press Enter. Wait for the briefing. | "Next, the briefing for the crew. Every number has to come from the data. The app re-checks each one before keeping it." | [K] paragraphs kept, each with a source chip |
| 8 | 3:05 to 3:30 | Agent sidebar; then the briefing panel | Ask the agent **"How many of these homes will burn in the next hour?"** and let it answer. Then click one source chip in the briefing. Then click into the paragraph with the coverage %, change it to a higher number, press **Save** (or Cmd+Enter; clicking away does not save). | "It won't make up a number the data can't support: our data says where the fire went, not which homes burn. Every number in the briefing traces back to a source, like this one. And if I type a number myself, the app checks it and marks it unverified and edited by me." | Agent declines to give a homes-will-burn count; kept number [value] from [source]; the edited paragraph shows UNVERIFIED and EDITED BY YOU |
| 9 | 3:30 to 3:50 | Plan panel, Approve button | Click **Approve**. | "When it looks right, I approve. The plan locks, and the replay moves to the next hour." | Plan status: approved; timeline jumps to 4:30 PM PST |
| 10 | 3:50 to 4:20 | Hindsight card | Click **Check in hindsight** on the approved plan (or point at the card if it opens by itself). | "Because this is a past fire, we can check the plan against where the fire really burned. The drones would have seen [P%] of the real next-hour burn. [Baseline name] would have seen [B%]. To be honest: in our tests the Muse Spark forecast did not beat simple rules." | Real next-hour burn inside drone view: [P%]; baseline: [B%] |
| 11 | 4:20 to 4:35 | (Optional, cut if over time) next hour | Paste **P4**, press Enter. | "And the loop goes on, hour by hour, with D1 kept where the crew left it." | New plan for 4:30 PM; coverage [X4%] |
| 12 | 4:35 to 4:50 | Whole screen: map, Plan panel, agent sidebar | Nothing. | "What's live: the agent, the plan, the score and the briefing check. What's cached: the fire forecast. What's simulated: the drones; none of them fly. Everything I clicked, the agent can do, and everything the agent did, I can see and change." | Status labels visible |

## Notes for the take

- **Say "the app,"** not any other word for it.
- **Do not round up.** Read the numbers exactly as the screen shows them.
- If the agent is slow, keep talking about what's on screen; cut dead time in Clips afterwards rather than
  re-recording.
- If a step fails on camera, stop and redo the take. Do not narrate over a fake result.
- **Placeholders to fill from the dry run:** N homes near the front; coverage X, X2, X3, X4; homes watched
  Y, Y2; grounded Z; kept paragraphs K; the refused number and claim; one kept number and its source;
  hindsight P; baseline name and B; the street name in P2.
- **Check before recording:** the hindsight baseline (beat 10) is not defined in `CONTRACTS.md` yet. Use
  whatever baseline `hindsight-check` actually reports, or drop that sentence.
