// ============================================================
// LacrosseHub scraper (all-in-one)
//
// Opens the public PLL stats pages in a headless browser, captures
// the JSON they load, maps it into LacrosseHub's shape, and writes
// ../data.json (which sits next to index.html).
//
//   npm install      # one time (also downloads Chromium)
//   npm run scrape   # fetch + write ../data.json
//
// Raw captures are saved to _debug/ so the real field names can be
// inspected and the mapping in the F{} block finished if needed.
// ============================================================

import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";

// ----------------------------- CONFIG -----------------------------
const SEASON = 2026;

// Public PLL stats pages the scraper opens (same pages a person can open).
const PAGES = [
  { key: "home",    url: "https://stats.premierlacrosseleague.com/" },
  { key: "games",   url: "https://stats.premierlacrosseleague.com/games" },
  { key: "players", url: "https://stats.premierlacrosseleague.com/players" },
  { key: "teams",   url: "https://stats.premierlacrosseleague.com/teams" },
];

const OUTPUT = new URL("../data.json", import.meta.url); // written next to index.html
const DEBUG_DIR = new URL("./_debug/", import.meta.url);

// Be a polite guest: identify yourself, go slowly, don't hammer the server.
const POLITE = {
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 LacrosseHub/1.0 (+personal fan project)",
  minDelayMs: 1500,
  navTimeoutMs: 45000,
  settleMs: 2500,
};

// Conference for each tri-code (used to split the standings table).
const CONF = { BOS:"East", MD:"East", NY:"East", PHI:"East", CAL:"West", CAR:"West", DEN:"West", UTA:"West" };

// Map whatever the source calls a team -> our tri-code. Add aliases freely.
const ALIASES = {
  BOS: ["bos","can","cns","cannons","boston","boston cannons"],
  MD:  ["md","whp","whi","whipsnakes","maryland","maryland whipsnakes"],
  NY:  ["ny","nya","atl","atlas","new york","new york atlas"],
  PHI: ["phi","phl","wat","wd","waterdogs","philadelphia","philadelphia waterdogs"],
  CAL: ["cal","red","rw","redwoods","california","california redwoods"],
  CAR: ["car","cha","chs","chaos","carolina","carolina chaos"],
  DEN: ["den","dnv","out","outlaws","denver","denver outlaws"],
  UTA: ["uta","uth","arc","archers","utah","utah archers"],
};
const LOOKUP = {};
for (const [tri, list] of Object.entries(ALIASES)) for (const a of list) LOOKUP[a] = tri;
function resolveTeam(value) {
  if (value == null) return null;
  const s = String(value).toLowerCase().trim();
  if (LOOKUP[s]) return LOOKUP[s];
  const parts = s.split(/\s+/);
  return LOOKUP[parts[parts.length - 1]] || LOOKUP[parts[0]] || null;
}

// ------------------ FIELD MAP (tune here if needed) ------------------
// Each logical field lists candidate source key names (any case, first match wins).
// After a run, open _debug/captured.full.json, find the real names, and append them.
const F = {
  team:      ["team","teamId","officialId","slug","abbreviation","abbr","name","fullName","teamName","triCode","clubId"],
  wins:      ["wins","w","win"],
  losses:    ["losses","l","loss"],
  pointsFor: ["scoresFor","pointsFor","goalsFor","pf","gf"],
  pointsAg:  ["scoresAgainst","pointsAgainst","goalsAgainst","pa","ga"],
  streak:    ["streak","strk","currentStreak"],

  homeTeam:  ["homeTeam","home","homeTeamId","homeOfficialId","homeAbbr","homeName","homeSlug"],
  awayTeam:  ["awayTeam","visitor","away","awayTeamId","awayOfficialId","awayAbbr","awayName","awaySlug"],
  homeScore: ["homeScore","homeScoreTotal","homePoints","homeGoals","homeFinal"],
  awayScore: ["awayScore","awayScoreTotal","awayPoints","awayGoals","awayFinal"],
  gameDate:  ["startTime","gameDate","date","scheduledTime","dateTimeGMT","start","eventDate"],
  gameStatus:["gameStatus","status","eventStatus","statusType","state"],
  period:    ["period","quarter","currentPeriod"],
  clock:     ["clock","gameClock","timeRemaining","displayClock"],
  network:   ["network","broadcast","tv","channel"],

  first:      ["firstName","first","givenName"],
  last:       ["lastName","last","familyName"],
  fullName:   ["fullName","name","displayName","playerName"],
  playerTeam: ["team","teamId","currentTeam","officialId","teamAbbr","slug"],
  goals:      ["goals","g","goalsScored"],
  assists:    ["assists","a"],
  points:     ["points","pts","p"],
  causedTO:   ["causedTurnovers","ct","causedTurnoversTotal"],
  saves:      ["saves","sv","savesTotal"],
  faceoffPct: ["faceoffPct","faceoffPctg","faceoffPercentage","foPct","faceoffWinPctg","faceoffWinPercentage"],
};

// ----------------------- helpers + normalize -----------------------
function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  const idx = {};
  for (const k of Object.keys(obj)) idx[k.toLowerCase()] = obj[k];
  for (const k of keys) {
    const v = idx[k.toLowerCase()];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}
const num = (v) => {
  const n = Number(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
function shortName(full) {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0][0].toUpperCase()}. ${parts.slice(1).join(" ")}`;
}
function collectArrays(node, out = []) {
  if (Array.isArray(node)) {
    if (node.length && node[0] && typeof node[0] === "object" && !Array.isArray(node[0])) out.push(node);
    for (const item of node) collectArrays(item, out);
  } else if (node && typeof node === "object") {
    for (const v of Object.values(node)) collectArrays(v, out);
  }
  return out;
}
function findArray(arrays, fields) {
  for (const arr of arrays) {
    if (fields.every((f) => pick(arr[0], F[f]) !== undefined)) return arr;
  }
  return null;
}

function normalize(payloads, { season } = {}) {
  const arrays = [];
  for (const p of payloads) collectArrays(p.json, arrays);

  const data = {
    week: "",
    season: season ? `Season ${season}` : "",
    updated: new Date().toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }),
    scheduleLabel: "This week",
    games: [],
    standings: { East: [], West: [] },
    schedule: [],
    stats: {},
    _notes: [],
  };

  // ---- STANDINGS ----
  const standArr = findArray(arrays, ["wins", "losses"]);
  if (standArr) {
    for (const row of standArr) {
      const tri = resolveTeam(pick(row, F.team));
      if (!tri || !CONF[tri]) continue;
      const rec = {
        tri,
        w: num(pick(row, F.wins)),
        l: num(pick(row, F.losses)),
        pf: num(pick(row, F.pointsFor)),
        pa: num(pick(row, F.pointsAg)),
        strk: String(pick(row, F.streak) ?? ""),
      };
      (CONF[tri] === "West" ? data.standings.West : data.standings.East).push(rec);
    }
    const bySort = (a, b) => (b.w - b.l) - (a.w - a.l) || (b.pf - b.pa) - (a.pf - a.pa);
    data.standings.East.sort(bySort);
    data.standings.West.sort(bySort);
  } else {
    data._notes.push("standings: no array with wins+losses found — inspect _debug/captured.full.json");
  }

  // ---- GAMES (scores) + SCHEDULE ----
  const gameArr = findArray(arrays, ["homeTeam", "awayTeam"]) || findArray(arrays, ["homeScore", "awayScore"]);
  if (gameArr) {
    const byDay = new Map();
    gameArr.forEach((g, i) => {
      const home = resolveTeam(pick(g, F.homeTeam));
      const away = resolveTeam(pick(g, F.awayTeam));
      if (!home || !away) return;

      const hs = num(pick(g, F.homeScore));
      const as = num(pick(g, F.awayScore));
      const statusRaw = String(pick(g, F.gameStatus) ?? "").toLowerCase();
      const live = /progress|live|active|in_play|playing/.test(statusRaw);
      const final = /final|complete|ended|closed|post/.test(statusRaw) || (!live && (hs || as));

      const when = pick(g, F.gameDate);
      const d = when ? new Date(when) : null;
      const valid = d && !isNaN(d);
      const dayLabel = valid ? d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : "Upcoming";
      const time = valid ? d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "TBD";

      const status = live ? "live" : (final ? "final" : "upcoming");
      data.games.push({
        id: "g" + (i + 1),
        status,
        clock: live ? `${pick(g, F.period) ?? ""} ${pick(g, F.clock) ?? ""}`.trim() : (final ? "Final" : time),
        date: dayLabel,
        away: { tri: away, q: [as] },
        home: { tri: home, q: [hs] },
        box: null, // detailed box score not pulled yet (modal shows a short note)
      });

      const row = {
        away, home, time, net: String(pick(g, F.network) ?? ""),
        ...(live ? { live: { away: as, home: hs } } : (final ? { result: { away: as, home: hs } } : {})),
      };
      if (!byDay.has(dayLabel)) byDay.set(dayLabel, []);
      byDay.get(dayLabel).push(row);
    });

    data.schedule = [...byDay.entries()].map(([day, games]) => ({ day, games }));
    data.games = data.games.filter((g) => g.status !== "upcoming");
  } else {
    data._notes.push("games: no array with home/away teams found — inspect _debug/captured.full.json");
  }

  // ---- STAT LEADERS ----
  const players = findArray(arrays, ["goals"]) || findArray(arrays, ["points"]) || findArray(arrays, ["saves"]);
  if (players) {
    const nameOf = (p) => {
      const full = pick(p, F.fullName);
      if (full) return shortName(full);
      const f = pick(p, F.first), l = pick(p, F.last);
      return l ? `${String(f || "")[0]?.toUpperCase() || ""}. ${l}`.trim() : String(f || "?");
    };
    const triOf = (p) => resolveTeam(pick(p, F.playerTeam)) || "";
    const leader = (field, decimals = 0) =>
      players
        .map((p) => ({ n: nameOf(p), t: triOf(p), v: pick(p, F[field]) }))
        .filter((r) => r.v !== undefined && r.t)
        .map((r) => [r.n, r.t, decimals ? Number(num(r.v).toFixed(decimals)) : num(r.v)])
        .sort((a, b) => b[2] - a[2])
        .slice(0, 4);

    data.stats = {
      "Goals":            { unit: "G",   rows: leader("goals") },
      "Assists":          { unit: "A",   rows: leader("assists") },
      "Points":           { unit: "PTS", rows: leader("points") },
      "Caused Turnovers": { unit: "CT",  rows: leader("causedTO") },
      "Saves":            { unit: "SV",  rows: leader("saves") },
      "Faceoff %":        { unit: "FO%", rows: leader("faceoffPct", 1) },
    };
    for (const [k, v] of Object.entries(data.stats)) {
      if (!v.rows.length) data._notes.push(`stats "${k}": field not found on player rows — check field names in the F{} map`);
    }
  } else {
    data._notes.push("stats: no player array with goals/points/saves found — inspect _debug/captured.full.json");
  }

  return data;
}

// ----------------------------- scrape -----------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  await mkdir(DEBUG_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: POLITE.userAgent,
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
  });

  const payloads = []; // { url, json }

  for (const def of PAGES) {
    const page = await ctx.newPage();
    page.setDefaultNavigationTimeout(POLITE.navTimeoutMs);

    page.on("response", async (res) => {
      try {
        const ct = (res.headers()["content-type"] || "").toLowerCase();
        if (!ct.includes("application/json") || !res.ok()) return;
        const text = await res.text();
        if (text.length > 4_000_000) return;
        payloads.push({ url: res.url(), json: JSON.parse(text) });
      } catch { /* some bodies can't be read; ignore */ }
    });

    try {
      console.log("→", def.url);
      await page.goto(def.url, { waitUntil: "networkidle" });
      await sleep(POLITE.settleMs);

      const nextData = await page.$eval("#__NEXT_DATA__", (el) => el.textContent).catch(() => null);
      if (nextData) {
        try { payloads.push({ url: def.url + "#__NEXT_DATA__", json: JSON.parse(nextData) }); } catch {}
      }

      const html = await page.content();
      await writeFile(new URL(`./${def.key}.html`, DEBUG_DIR), html);
    } catch (err) {
      console.warn("  ! failed:", err.message);
    } finally {
      await page.close();
      await sleep(POLITE.minDelayMs);
    }
  }

  await browser.close();

  await writeFile(new URL("./captured.urls.json", DEBUG_DIR), JSON.stringify(payloads.map((p) => p.url), null, 2));
  await writeFile(new URL("./captured.full.json", DEBUG_DIR), JSON.stringify(payloads, null, 2));

  const data = normalize(payloads, { season: SEASON });
  await writeFile(OUTPUT, JSON.stringify(data, null, 2));

  console.log(`\n========== SUMMARY ==========`);
  console.log(`captured payloads : ${payloads.length}`);
  console.log(`games found       : ${data.games.length}`);
  console.log(`standings (E/W)   : ${data.standings.East.length} / ${data.standings.West.length}`);
  console.log(`wrote             : data.json`);
  if (payloads.length === 0) {
    console.log(`\n⚠ 0 payloads captured — the site likely blocked the headless browser.`);
    console.log(`  This is the "bot-wall" case; we'll switch approaches.`);
  }
  if (data._notes?.length) {
    console.log(`\n⚠ needs tuning (download the debug-captures artifact to see field names):`);
    for (const n of data._notes) console.log("  -", n);
  }
  console.log(`=============================`);
}

run().catch((e) => { console.error(e); process.exit(1); });
