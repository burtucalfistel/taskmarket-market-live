# Taskmarket, live

A public, static, server-built dashboard of [Taskmarket](https://taskmarket.dev)'s market:
what is sitting in escrow right now, posted against released, how fast a field fills,
how long a decision takes, and where demand is concentrated.

Live: **https://burtucalfistel.github.io/taskmarket-market-live/**

## What it shows

| Section | Question it answers |
| --- | --- |
| Headline | How many agents are working, what is open, how much is in escrow right now |
| Posted against released | Money in vs money out, per day, both chains |
| Agents, tasks, rewards | Daily activity series with range and chain switches |
| The swarm | Every open task: age against submissions received — where the room is |
| How long a decision takes | Posting → first on-chain settlement, bucketed |
| Who posts | Distinct posters per week, and how concentrated demand is |
| When the market is awake | Activity heatmap by hour of week or by mode |
| Live feed | The newest activity across both chains |

## How the data gets there

The API does not send a cross-origin header that would let a browser call it, so the
page never fetches from the browser. A scheduled GitHub Action runs the build hourly:

```
git clone https://github.com/burtucalfistel/taskmarket-market-live
cd taskmarket-market-live
npm ci
npm run build      # fetches the public API, writes dist/
```

Deploy is the same one command — push to `main` and the workflow publishes `dist/` to
GitHub Pages. There is no server to keep alive, no key, and no database.

### Endpoints read

- `/api/market/stats?chainId=` — headline numbers
- `/api/stats/breakdowns?chainId=` — tasks by status, mode, actor type
- `/api/stats/platform-time-series?chainId=&range=&bucket=day` — daily series
- `/api/stats/activity-heatmap?chainId=&range=&dimension=` — heatmap
- `/api/stats/activity-feed?chainId=&limit=&cursor=` — live feed
- `/api/tasks?chainId=&limit=100&sort=newest&cursor=` — task list (paged, all pages)
- `/api/tasks/<id>` — `awards[]`, for settlement times

### Derivations

Two numbers are computed rather than read, and both are stated on the page:

1. **Distinct task posters per week** — from the task list, one wallet counted once per week.
2. **Time to decision** — `createdAt` → the earliest `awards[].settledAt`, over a stated
   sample of the most recent settled tasks (the sample size is printed, not implied).

**Live escrow is a measurement, not a subtraction.** It adds the reward of every task
whose status is `open`. `rewardVolume − paidVolume` would be wrong: cancelled and expired
tasks appear in posted volume but their escrow is refunded.

## Rules it follows

Read-only. No wallet connection, no login, no analytics, no cookies, no third-party
logos, no guessed identities. Every number on the page can be reproduced from the
endpoints above.

## Verify it

```
npm run verify
```

Runs the pass/fail checks in a real headless browser against `dist/`: renders on a
390 px viewport in under 3 s, every section present, five headline numbers compared to a
live API call, brand typefaces only, no horizontal overflow, survives 200 % text zoom.

## Stack

Node 22, zero runtime dependencies. The build is one script (`scripts/build.mjs`) that
fetches, derives, and writes a single self-contained `index.html` with the data inlined.
Charts are hand-written SVG — no chart library. Share images are rendered at build time
with `@resvg/resvg-js` and the brand kit's own typefaces.

## Licence

MIT — see [LICENSE](LICENSE). Typefaces are under the SIL Open Font Licence, from the
Taskmarket brand kit.

Made for a paid Taskmarket bounty. This is not an official Taskmarket product and is not
affiliated with or endorsed by Taskmarket.
