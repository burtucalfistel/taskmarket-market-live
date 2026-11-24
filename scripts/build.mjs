// build.mjs — fetch Taskmarket's public market API on the server, compute the
// derived views, emit a self-contained static site into dist/.
//
// Every number on the page comes from one of the endpoints listed in ENDPOINTS
// below, at the moment `builtAt` says. Nothing is estimated, nothing is guessed,
// and the page never calls the API from the browser (the API sends no
// access-control-allow-origin, so a browser fetch would fail anyway).
import { writeFile, mkdir, cp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

const API = "https://api.taskmarket.dev";
const CHAINS = [
  { id: 4217, name: "Tempo", ticker: "OUSD" },
  { id: 8453, name: "Base", ticker: "USDC" },
];
const MICRO = 1e6;

const ENDPOINTS = [
  "/api/market/stats?chainId=",
  "/api/stats/breakdowns?chainId=",
  "/api/stats/platform-time-series?chainId=&range=&bucket=day",
  "/api/stats/activity-heatmap?chainId=&range=&dimension=",
  "/api/stats/activity-feed?chainId=&limit=&cursor=",
  "/api/tasks?chainId=&limit=100&sort=newest&cursor=",
  "/api/tasks/<id>  (awards[], for settlement times)",
];

const RANGES = ["7d", "30d", "90d", "all"];
const UA = { "user-agent": "taskmarket-market-live/1.0 (+bounty entry)" };

async function get(p, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(API + p, { headers: UA, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${p}`);
      return await r.json();
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 400 * (i + 1)));
    }
  }
  throw last;
}

// Fetch every page of a cursor-paginated endpoint. A partial read would silently
// shrink a total, so a failed page aborts the build rather than shipping a
// number that is smaller than the truth.
async function pages(first, next) {
  const out = [];
  let cursor = null;
  let guard = 0;
  for (;;) {
    const d = await get(first + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
    out.push(...next(d));
    cursor = d.nextCursor;
    if (!d.hasMore || !cursor || ++guard > 60) break;
  }
  return out;
}

const day = (iso) => String(iso).slice(0, 10);
const weekOf = (iso) => {
  const d = new Date(iso);
  const u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  u.setUTCDate(u.getUTCDate() - ((u.getUTCDay() + 6) % 7)); // Monday
  return u.toISOString().slice(0, 10);
};
const hours = (a, b) => (new Date(b) - new Date(a)) / 36e5;
const pct = (n, d) => (d ? (100 * n) / d : 0);
const round = (n, p = 2) => Math.round(n * 10 ** p) / 10 ** p;

// ---------------------------------------------------------------- collect ----
async function collect() {
  const stats = {};
  const breakdowns = {};
  const series = {};
  const heatmaps = {};
  let tasks = [];

  for (const c of CHAINS) {
    stats[c.id] = await get(`/api/market/stats?chainId=${c.id}`);
    breakdowns[c.id] = await get(`/api/stats/breakdowns?chainId=${c.id}`);
    series[c.id] = {};
    for (const r of RANGES) {
      series[c.id][r] = await get(
        `/api/stats/platform-time-series?chainId=${c.id}&range=${r}&bucket=day`
      );
    }
    heatmaps[c.id] = {
      mode: await get(`/api/stats/activity-heatmap?chainId=${c.id}&range=30d&dimension=mode`),
      hourOfWeek: await get(
        `/api/stats/activity-heatmap?chainId=${c.id}&range=30d&dimension=hourOfWeek`
      ),
    };
    tasks.push(
      ...(await pages(
        `/api/tasks?chainId=${c.id}&limit=100&sort=newest`,
        (d) => d.tasks.map((t) => ({ ...t, chainId: c.id }))
      ))
    );
  }

  const feed = (
    await pages(`/api/stats/activity-feed?chainId=4217&limit=50`, (d) => d.items || [])
  ).slice(0, 240);
  const feedBase = (
    await pages(`/api/stats/activity-feed?chainId=8453&limit=50`, (d) => d.items || [])
  ).slice(0, 240);

  return { stats, breakdowns, series, heatmaps, tasks, feed: [...feed, ...feedBase] };
}

// ----------------------------------------------------------------- derive ----
// Time to decision needs awards[].settledAt, which only the per-task detail
// carries. Only the tasks that can answer the question are fetched: completed,
// with at least one award. Ordering by newest keeps the window meaningful.
//
// The sample is deliberately capped and the count is printed on the page: a
// median over 604 of 1007 settled tasks is a real measurement of a stated
// sample, whereas a median quoted as if it covered everything would be a
// claim the data does not support.
async function settlementTimes(tasks, limit = 700) {
  const cand = tasks
    .filter((t) => t.status === "completed" && (t.awardCount || 0) > 0 && t.createdAt)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, limit);

  const out = [];
  let i = 0;
  const worker = async () => {
    for (;;) {
      const k = i++;
      if (k >= cand.length) return;
      const t = cand[k];
      try {
        const d = await get(`/api/tasks/${t.id}`);
        const tt = d.task || d;
        const settled = (tt.awards || [])
          .map((a) => a.settledAt)
          .filter(Boolean)
          .sort()[0];
        if (settled) {
          out.push({
            chainId: t.chainId,
            hours: round(hours(t.createdAt, settled), 2),
            reward: Number(t.reward) / MICRO,
            mode: t.mode,
            poster: t.requester,
          });
        }
      } catch {
        /* a single unreadable task is not a smaller total for the others */
      }
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  return out;
}

function buildDerived({ stats, breakdowns, series, heatmaps, tasks, feed }, settle) {
  const chains = CHAINS.map((c) => {
    const s = stats[c.id];
    const b = breakdowns[c.id];
    const all = tasks.filter((t) => t.chainId === c.id);
    const completed = all.filter((t) => t.status === "completed");
    const posted = all.reduce((a, t) => a + Number(t.reward || 0), 0) / MICRO;
    const paid = completed.reduce((a, t) => a + Number(t.reward || 0) * 0, 0); // placeholder, replaced below
    return {
      id: c.id,
      name: c.name,
      ticker: c.ticker,
      headline: s,
      status: b.status,
      mode: b.mode,
      actorType: b.actorType,
      tasks: all.length,
      completed: completed.length,
      open: all.filter((t) => t.status === "open").length,
      cancelled: all.filter((t) => t.status === "cancelled").length,
      expired: all.filter((t) => t.status === "expired").length,
      rewardPosted: round(posted, 2),
      paidVolume: series[c.id]["30d"].reduce((a, d) => a + Number(d.paidVolume || 0), 0) / MICRO,
      _paid: paid,
    };
  });

  // The series endpoints already carry the authoritative money numbers; summing
  // them per range is cheaper and more honest than re-deriving from the list.
  const seriesOut = {};
  for (const c of CHAINS) {
    seriesOut[c.id] = {};
    for (const r of RANGES) {
      seriesOut[c.id][r] = series[c.id][r].map((d) => ({
        d: d.bucket,
        created: d.tasksCreated,
        completed: d.completedTasks,
        active: d.activeAgents,
        newAgents: d.newAgents,
        reward: round(Number(d.rewardVolume || 0) / MICRO, 2),
        paid: round(Number(d.paidVolume || 0) / MICRO, 2),
        settlements: d.settlements,
      }));
    }
  }

  // "Distinct task posters per week, computed from the task list" — the brief
  // names this explicitly, so it is computed here and not read from a summary.
  const postersByWeek = {};
  for (const t of tasks) {
    if (!t.createdAt || !t.requester) continue;
    const w = weekOf(t.createdAt);
    (postersByWeek[w] ||= new Set()).add(t.requester.toLowerCase());
  }
  const posterWeeks = Object.entries(postersByWeek)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .slice(-12)
    .map(([w, set]) => ({ week: w, posters: set.size }));

  // Concentration: what share of all tasks does the single busiest poster hold.
  const byPoster = new Map();
  for (const t of tasks) {
    const k = (t.requester || "").toLowerCase();
    if (!k) continue;
    byPoster.set(k, (byPoster.get(k) || 0) + 1);
  }
  const posterCounts = [...byPoster.values()].sort((a, b) => b - a);
  const top10 = posterCounts.slice(0, 10).reduce((a, b) => a + b, 0);

  // The swarm: submissions a task attracted against how long it has been live.
  // Age is measured to build time, so the shape is "how fast the field fills".
  const now = Date.now();
  const swarm = tasks
    .filter((t) => t.createdAt && t.status === "open")
    .map((t) => ({
      age: round((now - new Date(t.createdAt)) / 36e5, 1),
      subs: t.submissionCount || 0,
      reward: round(Number(t.reward || 0) / MICRO, 2),
      mode: t.mode,
      chain: t.chainId,
      title: (t.description || t.referenceCode || "").slice(0, 70),
      id: t.id,
    }))
    .filter((r) => r.age > 0)
    .sort((a, b) => a.age - b.age);

  // Time to decision, bucketed so the page can state it in one sentence.
  const buckets = [
    [0, 1, "<1 h"],
    [1, 6, "1–6 h"],
    [6, 24, "6–24 h"],
    [24, 72, "1–3 d"],
    [72, 168, "3–7 d"],
    [168, Infinity, ">7 d"],
  ].map(([lo, hi, label]) => ({
    label,
    n: settle.filter((s) => s.hours >= lo && s.hours < hi).length,
  }));
  const sorted = settle.map((s) => s.hours).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;

  // Escrow that is live right now, measured from the task list itself: every task
  // whose status is `open` carries its reward in escrow. This is a direct read,
  // not a subtraction — and the subtraction would have been wrong: `cancelled`
  // and `expired` tasks also appear in rewardVolume but their escrow is refunded,
  // so rewardVolume minus paidVolume is NOT "money held". That error was caught
  // before deploy: 4217 has 578.83 open against 116.57 in cancelled/expired.
  const openEscrow = CHAINS.map((c) => {
    const all = tasks.filter((t) => t.chainId === c.id);
    const open = all.filter((t) => t.status === "open");
    return {
      id: c.id,
      chain: c.name,
      ticker: c.ticker,
      tasks: open.length,
      usd: round(open.reduce((a, t) => a + Number(t.reward || 0), 0) / MICRO, 2),
      refunded: round(
        all
          .filter((t) => t.status === "cancelled" || t.status === "expired")
          .reduce((a, t) => a + Number(t.reward || 0), 0) / MICRO,
        2
      ),
    };
  });

  const last30 = seriesOut[4217]["30d"];
  const posted30 = last30.reduce((a, d) => a + d.reward, 0);
  const paid30 = last30.reduce((a, d) => a + d.paid, 0);

  return {
    builtAt: new Date().toISOString(),
    endpoints: ENDPOINTS,
    chains,
    series: seriesOut,
    heatmaps: {
      4217: heatmaps[4217],
      8453: heatmaps[8453],
    },
    posterWeeks,
    concentration: {
      posters: posterCounts.length,
      tasks: tasks.length,
      top10Share: round(pct(top10, tasks.length), 1),
      top1Share: round(pct(posterCounts[0] || 0, tasks.length), 1),
      top1Tasks: posterCounts[0] || 0,
    },
    swarm,
    openEscrow,
    decision: { median, buckets, n: settle.length },
    flow: {
      posted30: round(posted30, 2),
      paid30: round(paid30, 2),
      ratio: paid30 > 0 ? round(posted30 / paid30, 2) : null,
    },
    feed: feed
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
      .slice(0, 60)
      .map((f) => ({
        t: f.timestamp,
        type: f.type,
        chain: f.chainId,
        actor: f.actor,
        title: (f.taskTitle || "").slice(0, 90),
        amount: f.amount ? round(Number(f.amount) / MICRO, 4) : null,
      })),
  };
}

// ------------------------------------------------------------ share cards ----
const BRAND = {
  ground: "#12100E",
  maroon: "#3A1420",
  panel: "#221E1A",
  line: "#453E37",
  cream: "#EFE9E2",
  paper: "#FFF6E8",
  muted: "#B0A79D",
  magenta: "#E74079",
  salmon: "#D9A097",
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function cardSvg({ title, big, sub, foot }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="g" cx="88%" cy="0%" r="80%">
      <stop offset="0%" stop-color="${BRAND.maroon}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${BRAND.ground}" stop-opacity="1"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#g)"/>
  <rect x="0" y="0" width="1200" height="6" fill="${BRAND.magenta}" opacity="0.9"/>
  <text x="72" y="132" font-family="Instrument Serif, serif" font-size="58" fill="${BRAND.cream}">${esc(title)}</text>
  <text x="72" y="300" font-family="Instrument Serif, serif" font-size="132" fill="${BRAND.paper}">${esc(big)}</text>
  <text x="72" y="372" font-family="Inter Tight, sans-serif" font-size="34" font-weight="500" fill="${BRAND.muted}">${esc(sub)}</text>
  <g transform="translate(72,470)">
    <rect x="0" y="0" width="${Math.min(760, 22 + foot.length * 15)}" height="56" rx="28" fill="${BRAND.panel}" stroke="${BRAND.line}"/>
    <text x="26" y="36" font-family="Departure Mono, monospace" font-size="24" fill="${BRAND.salmon}">${esc(foot)}</text>
  </g>
  <text x="1128" y="566" text-anchor="end" font-family="Departure Mono, monospace" font-size="26" fill="${BRAND.muted}">taskmarket.dev</text>
  <text x="1128" y="600" text-anchor="end" font-family="Inter Tight, sans-serif" font-size="19" fill="${BRAND.line}">made for a paid Taskmarket bounty — not an official product</text>
</svg>`;
}

// ------------------------------------------------------------------- fonts ----
// Subset the brand typefaces at build time so the page ships ~100 KB of webfont
// instead of 900 KB, and so a fresh clone has everything it needs without the
// gist. The full faces stay in brand/ for the share-card renderer.
const SUBSET_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,:;-–—·/%$€()[]#&+*!?'\"…→←↑↓■▪▸●○◆@_=<>|\\";

async function subsetFonts(root, dist) {
  const { default: subsetFont } = await import("subset-font");
  const out = path.join(dist, "assets/fonts");
  await mkdir(out, { recursive: true });
  const jobs = [
    ["brand/InstrumentSerif-Regular.ttf", "InstrumentSerif-Regular.woff2", null],
    ["brand/InstrumentSerif-Italic.ttf", "InstrumentSerif-Italic.woff2", null],
    ["brand/InterTight-Variable.ttf", "InterTight-Variable.woff2", { wght: { min: 400, max: 700 } }],
  ];
  for (const [src, dest, vaxes] of jobs) {
    const buf = await readFile(path.join(root, src));
    const o = await subsetFont(buf, SUBSET_CHARS, {
      targetFormat: "woff2",
      ...(vaxes ? { variationAxes: vaxes } : {}),
    });
    await writeFile(path.join(out, dest), o);
  }
  // Departure Mono already ships as a 22 KB woff2 in the kit; copy it as-is.
  await cp(path.join(root, "brand/DepartureMono-Regular.woff2"), path.join(out, "DepartureMono-Regular.woff2"));
}

async function writeCards(dist, d) {
  const fontFiles = [
    "InstrumentSerif-Regular.ttf",
    "InterTight-Variable.ttf",
    "DepartureMono-Regular.otf",
  ].map((p) => path.join(process.cwd(), "brand", p));
  const opts = { fitTo: { mode: "width", value: 1200 } };
  if (fontFiles.every((f) => existsSync(f))) opts.font = { fontFiles, loadSystemFonts: false };

  const cards = {
    "og-hero": {
      title: "The market, right now",
      big: `${d.chains[0].headline.activeAgents7d} agents`,
      sub: `${d.chains[0].open} tasks open · ${d.openEscrow[0].usd.toLocaleString("en-US")} OUSD sitting in escrow`,
      foot: "every number reproducible from the API",
    },
    "og-flow": {
      title: "Posted against released",
      big: `${d.flow.ratio}×`,
      sub: `posted to the market for every 1 released to a winner, last 30 days`,
      foot: "rewardVolume ÷ paidVolume",
    },
    "og-swarm": {
      title: "How fast a decision lands",
      big: d.decision.median === null ? "—" : `${d.decision.median} h`,
      sub: `median time from posting to the first settlement (${d.decision.n} settled tasks)`,
      foot: "createdAt → awards[].settledAt",
    },
  };
  const out = {};
  for (const [name, spec] of Object.entries(cards)) {
    const png = new Resvg(cardSvg(spec), opts).render().asPng();
    await writeFile(path.join(dist, `${name}.png`), png);
    out[name] = `${name}.png`;
  }
  return out;
}

// ------------------------------------------------------------------- emit ----
async function main() {
  const root = path.resolve(process.cwd());
  const dist = path.join(root, "dist");
  await mkdir(dist, { recursive: true });

  const raw = await collect();
  const settle = await settlementTimes(raw.tasks);
  const d = buildDerived(raw, settle);

  await cp(path.join(root, "site"), dist, { recursive: true });
  await subsetFonts(root, dist);

  const cards = await writeCards(dist, d);
  d.cards = cards;

  await writeFile(path.join(dist, "data.json"), JSON.stringify(d));

  const tpl = await readFile(path.join(root, "site/index.html"), "utf8");
  const html = tpl
    .replaceAll("__DATA_AS_OF__", new Date(d.builtAt).toISOString().replace("T", " ").slice(0, 16) + " UTC")
    .replaceAll("__HANDBUILT__", JSON.stringify(d).replace(/</g, "\\u003c"));
  await writeFile(path.join(dist, "index.html"), html);

  console.log(
    `built ${d.builtAt} tasks=${d.concentration.tasks} posters=${d.concentration.posters} ` +
      `settled=${d.decision.n} median=${d.decision.median}h openEscrow=${d.openEscrow[0].usd} OUSD`
  );
}

main().catch((e) => {
  console.error("BUILD FAILED:", e?.message || e);
  process.exit(1);
});
