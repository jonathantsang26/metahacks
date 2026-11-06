# Submission text: Builder.io Agent-Native Hackathon

Draft answers for the submission form. Deadline: Monday Nov 9 2026, 11:59 PM PT. Plain words on purpose.
Do not put tax forms, ID documents or payment details in the form or the recording.

## Project name

Sentinel Ember

## Tagline

Plan the next hour of drone coverage on a wildfire, by hand or by asking an agent, on the same plan.

## Project description

Sentinel Ember helps a fire crew plan the next hour of drone coverage and write the briefing for it. Every
step can be done by hand or by the agent, on the same plan.

The app replays the January 2025 Eaton Fire on a 3D map of the real hills, from public records. Ask
for a plan and the agent places up to six drones along the edge where a saved Muse Spark forecast expects the
fire to be in an hour. Drag a drone yourself, lock it, or select it and ask the agent to move it. The app
scores each plan: how much of that edge the drones can see and how many homes are near it. The agent writes
a crew briefing where every number must come from the data. Then approve, go to the next hour, and check
the plan against the real burn.

## What's agent-native about it

The person and the agent use the same actions and the same data. Anything you can click, the agent can do,
and the other way round. Each change is saved with who made it, so both see the same plan.

- **Making a plan** (`create-drone-plan`): the Auto-plan button and the agent call the same action. Drones you
  locked are kept.
- **Moving a drone** (`update-drone-assignment`): dragging a drone on the map and asking the agent to move it
  are the same action, so the score updates the same way either way.
- **Seeing what you see** (`view-screen`): the agent reads what's on your screen and which drone you
  selected, so "move the selected drone" just works.
- **Writing the briefing** (`save-briefing`, `edit-briefing-paragraph`): the agent writes it with a source
  for each paragraph. The app re-runs each source and drops a paragraph whose numbers don't match. You can
  edit any line, and it's marked as yours.
- **Approving** (`approve-plan`): the Approve button or a request to the agent locks the plan and moves the
  replay to the next hour.

## How it saves manual work

Today a planner would read the fire map, the forecast and the home locations, place each drone by hand,
work out what each one can see, and then write a briefing and check every number. In Sentinel Ember one
request gives a full plan with a score, the score updates as you change it, and the briefing's numbers are
checked against the data before anyone reads them. The person stays in charge: they can change, lock or
approve anything. We have not measured time saved with real crews.

## What's real and what isn't

The plan is for a replay of a past fire (Eaton, Jan 2025). No drones fly. The forecast was made earlier by
Muse Spark and saved; in our tests it did not beat simple rules. The score is simple geometry on that
forecast. The agent, the plan, the score and the briefing check run live.

## Prior work and what's new (disclosure)

- **Before Oct 27 2026:** Ben's open-source fire-detection app, Sentinel
  (https://github.com/benjaminxie1/sentinel-app). We used only its stock YOLOv8n model file as a starting
  point.
- **Oct 30 to Nov 4 2026, for the Meta hackathon:** we built Sentinel Ember's web app, data pipeline, fire
  detector, Muse Spark forecaster, swarm and analyst, and a MuJoCo drone simulation. That was a different
  hackathon, so we count it as prior work here. The fire data and cached forecasts come from it.
- **New for this hackathon (from Nov 6 2026):** a new app built on Agent-Native (Chat template, core 0.225.1)
  where the person and the agent plan drone coverage together: the plan, score, briefing, approve and
  hindsight actions, the tables that store plans and briefings, the plan and briefing panels, draggable
  drones on the map, and a step-by-step guide.
- **Libraries and data:** React, React Router, deck.gl, onnxruntime-web, Drizzle, PGlite, zod, zustand,
  Tailwind; Meta's Muse Spark and SAM 3.1; the agent runs on Claude via the Anthropic API (pending); public
  data from NIFC, CAL FIRE, NOAA HRRR, USGS, NASA JPL and others. Layout inspired by Dilum Sanjaya's
  "FireTrace" concept.
- Full list: `agent/CHANGES.md` in the repo.

## Team

| Name | Role |
| --- | --- |
| Jonathan [last name] | [role] |
| Ben [last name] | [role] |
| Dhilen [last name] | [role] |

CS students at UC Berkeley. Every team member must meet the eligibility rules, authorize the submission and
agree to the Official Rules and any prize split before we submit.

Contact: [team contact]

## Links

- Clips recording (public, no login): [Clips URL]
- Repo: [repo URL] (https://github.com/jonathantsang26/metahacks, if we submit that repo)
- Live site: [live site URL]
