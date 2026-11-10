const TZ = "America/New_York";
const ORLANDO = { lat: 28.5383, lon: -81.3792 };
const WORKDAY_HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const MONTHLY_TARGET = 30;
const CACHE_TTL = {
  weather: 15 * 60,
  crew: 3 * 60,
  permits: 3 * 60,
  bids: 3 * 60,
  ics: 5 * 60,
};
const FETCH_MS = 6000;

const ROBOTS = "User-agent: *\nDisallow: /\n";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    try {
      if (path === "/robots.txt") {
        return withHeaders(
          new Response(ROBOTS, {
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        );
      }

      if (path === "/api/summary" && method === "GET") {
        return withHeaders(json(await buildSummary(env, ctx)));
      }

      if (path === "/api/feed/calendar") {
        if (method !== "POST") {
          return withHeaders(json({ error: "Method not allowed" }, 405));
        }
        return withHeaders(await postCalendar(request, env));
      }

      if (path.startsWith("/api/")) {
        return withHeaders(json({ error: "Not found" }, 404));
      }

      if (!env.ASSETS) {
        return withHeaders(json({ error: "Assets not bound" }, 500));
      }

      const assetPath = path === "/" ? "/index.html" : url.pathname;
      const assetUrl = new URL(assetPath, url.origin);
      const assetReq = new Request(assetUrl, { method: "GET" });
      const asset = await env.ASSETS.fetch(assetReq);
      return withHeaders(asset, path === "/" || assetPath.endsWith(".html") || assetPath.endsWith(".js"));
    } catch (err) {
      return withHeaders(json({ error: "Server error" }, 500));
    }
  },
};

function withHeaders(res, noStore = true) {
  const headers = new Headers(res.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  if (noStore || !headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function todayNY(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}

function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function thisMonday(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0 Sun
  const back = dow === 0 ? 6 : dow - 1;
  return addDays(iso, -back);
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(String(a || ""));
  const bb = enc.encode(String(b || ""));
  const len = Math.max(aa.length, bb.length, 1);
  let out = aa.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    out |= (aa[i] || 0) ^ (bb[i] || 0);
  }
  return out === 0;
}

function clip(s, n = 120) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
}

async function kvGetJson(env, key) {
  if (!env.TV) return null;
  try {
    const raw = await env.TV.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function kvPutJson(env, key, value, ttl) {
  if (!env.TV) return;
  try {
    const opts = ttl ? { expirationTtl: Math.max(60, ttl) } : undefined;
    await env.TV.put(key, JSON.stringify(value), opts);
  } catch {
    /* ignore cache write failures */
  }
}

async function cached(env, key, ttl, fn) {
  const hit = await kvGetJson(env, key);
  if (hit && hit._ts && Date.now() - hit._ts < ttl * 1000) return hit.data;
  const data = await fn();
  if (data && data._cache !== false) {
    await kvPutJson(env, key, { _ts: Date.now(), data }, ttl + 30);
  }
  return data;
}

function serviceBindingFor(url, env) {
  if (!env) return null;
  const host = (() => { try { return new URL(url).host; } catch { return ""; } })();
  if (host.startsWith("sharma-crew.") && env.CREW) return env.CREW;
  if (host.startsWith("sharma-permits.") && env.PERMITS) return env.PERMITS;
  if (host.startsWith("sharma-bids.") && env.BIDS) return env.BIDS;
  return null;
}

async function getText(url, opts = {}) {
  const headers = { Accept: opts.accept || "*/*", ...(opts.headers || {}) };
  const binding = serviceBindingFor(url, opts.env);
  if (binding && typeof binding.fetch === "function") {
    try {
      const u = new URL(url);
      const req = new Request("https://service-binding" + u.pathname + u.search, { method: "GET", headers });
      const res = await binding.fetch(req);
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    } catch (err) {
      // Fall through to public URL.
    }
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || FETCH_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal, redirect: "follow", headers });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch {
    return { ok: false, status: 0, text: "" };
  } finally {
    clearTimeout(t);
  }
}

async function getJson(url, opts = {}) {
  const r = await getText(url, { ...opts, accept: "application/json" });
  if (!r.ok) return { ...r, json: null };
  try {
    return { ...r, json: JSON.parse(r.text) };
  } catch {
    return { ...r, json: null };
  }
}

async function buildSummary(env, ctx) {
  const today = todayNY();
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(thisMonday(today), 6);

  const weatherP = getWeather(env);
  const crewP = getCrew(env);
  const inspP = getInspections(env, today, tomorrow);
  const bidsP = getBids(env, today, weekEnd);
  const meetsP = getMeetings(env, today, ctx);

  const [weather, crew, inspections, bids, meetings] = await Promise.all([
    weatherP, crewP, inspP, bidsP, meetsP,
  ]);

  return {
    generatedAt: new Date().toISOString(),
    today,
    timezone: TZ,
    weather,
    crews: crew,
    inspections,
    bids,
    meetings,
    scoreboard: crew.scoreboard,
  };
}

/* ---------------- Weather ---------------- */

function wmoText(code) {
  const c = Number(code);
  if (c === 0) return "Clear";
  if (c === 1) return "Mostly clear";
  if (c === 2) return "Partly cloudy";
  if (c === 3) return "Cloudy";
  if (c === 45 || c === 48) return "Fog";
  if (c >= 51 && c <= 57) return "Drizzle";
  if (c >= 61 && c <= 67) return "Rain";
  if (c >= 71 && c <= 77) return "Snow";
  if (c >= 80 && c <= 82) return "Showers";
  if (c === 85 || c === 86) return "Snow showers";
  if (c >= 95) return "Thunderstorms";
  return "Orlando";
}

async function getWeather(env) {
  const empty = { status: "unavailable", label: "Weather unavailable", tempF: null, hours: [] };
  try {
    return await cached(env, "cache:weather", CACHE_TTL.weather, async () => {
      const u = new URL("https://api.open-meteo.com/v1/forecast");
      u.searchParams.set("latitude", String(ORLANDO.lat));
      u.searchParams.set("longitude", String(ORLANDO.lon));
      u.searchParams.set("current", "temperature_2m,weather_code,precipitation_probability,wind_speed_10m");
      u.searchParams.set("hourly", "precipitation_probability,temperature_2m");
      u.searchParams.set("temperature_unit", "fahrenheit");
      u.searchParams.set("wind_speed_unit", "mph");
      u.searchParams.set("timezone", TZ);
      u.searchParams.set("forecast_days", "1");
      const r = await getJson(u.toString());
      if (!r.json || r.json.current == null) return { ...empty, _cache: false };
      const cur = r.json.current;
      const hourly = r.json.hourly || {};
      const times = hourly.time || [];
      const probs = hourly.precipitation_probability || [];
      const hours = [];
      for (let i = 0; i < times.length; i++) {
        const hour = Number(String(times[i]).slice(11, 13));
        if (!WORKDAY_HOURS.includes(hour)) continue;
        hours.push({
          hour,
          label: hour === 12 ? "12p" : hour > 12 ? `${hour - 12}p` : `${hour}a`,
          rain: Number.isFinite(Number(probs[i])) ? Math.round(Number(probs[i])) : null,
        });
      }
      const temp = cur.temperature_2m;
      return {
        status: "live",
        label: wmoText(cur.weather_code),
        tempF: Number.isFinite(Number(temp)) ? Math.round(Number(temp)) : null,
        windMph: Number.isFinite(Number(cur.wind_speed_10m)) ? Math.round(Number(cur.wind_speed_10m)) : null,
        rainNow: Number.isFinite(Number(cur.precipitation_probability)) ? Math.round(Number(cur.precipitation_probability)) : null,
        hours,
      };
    });
  } catch {
    return empty;
  }
}

/* ---------------- Crews / scoreboard ---------------- */

const DONE_STAGES = /^(final|closed|complete|completed|done|finished|co\b)/i;

function normStage(raw) {
  const t = String(raw || "").trim();
  const l = t.toLowerCase();
  if (/underground|temp(?:orary)?\s*pole|service\s*lateral/.test(l)) return "Underground";
  if (/service\s*call|service/.test(l) && !/service\s*lateral/.test(l)) return "Service call";
  if (/trim/.test(l)) return "Trim";
  if (/final|close.?out/.test(l)) return "Final";
  if (/rough/.test(l)) return "Rough-in";
  return t || "TBD";
}

function parseCrewHtml(html) {
  const houses = [];
  const re = /<a\s+class=b\s+href="\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const id = m[1];
    if (id === "code-of-conduct") continue;
    const inner = m[2];
    const addrMatch = inner.match(/^([^<]+)/);
    const address = clip(addrMatch ? addrMatch[1] : "", 80);
    const small = (inner.match(/<small[^>]*>([\s\S]*?)<\/small>/i) || [, ""])[1];
    const enStage = (small.match(/<span\s+class=en>([\s\S]*?)<\/span>/i) || [, ""])[1];
    const text = clip(small.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "), 200);
    const parts = text.split("·").map((s) => s.trim()).filter(Boolean);
    const builder = parts[0] || "";
    const plan = parts.length >= 3 ? parts[1] : "";
    let stage = clip(enStage, 40);
    if (!stage) {
      const rest = parts.length >= 2 ? parts[parts.length - 1] : "";
      // Prefer the English phrase before any accented translation.
      stage = rest.split(/\s+(?=[A-ZÁÉÍÓÚÑÃÕ])/)[0]
        ? rest.replace(/\s+(Preliminar|Instala[cç][aã]o|Acabados|Inspecci[oó]n|Inspecci[oó]n final).*/i, "").trim()
        : rest;
    }
    houses.push({
      id: clip(id, 40),
      address: address || clip(id, 40),
      builder: clip(builder, 60),
      plan: clip(plan, 40),
      stage: normStage(stage),
    });
  }
  return houses;
}

function parseCrewJson(data) {
  const list = Array.isArray(data)
    ? data
    : data.houses || data.jobs || data.items || data.data || data.crews || [];
  if (!Array.isArray(list)) return [];
  return list.map((h, i) => ({
    id: clip(h.id || h.slug || h.key || String(i), 40),
    address: clip(h.address || h.job || h.name || h.house || "", 80),
    builder: clip(h.builder || h.client || "", 60),
    plan: clip(h.plan || "", 40),
    stage: normStage(h.stage || h.phase || h.status || ""),
    crew: clip(h.crew || h.assigned || h.who || "", 40),
    finishedDate: clip(h.finishedDate || h.finished_date || h.completedAt || h.completed_at || h.finalDate || "", 12),
  })).filter((h) => h.address || h.builder);
}

function scoreboardFrom(houses, note) {
  const inProgress = houses.filter((h) => !DONE_STAGES.test(h.stage || "")).length;
  const finishedThisMonth = houses.filter((h) => {
    if (h.finishedDate && String(h.finishedDate).slice(0, 7) === todayNY().slice(0, 7)) return true;
    return false;
  });
  const hasFinishDates = houses.some((h) => h.finishedDate);
  const finishedKnown = houses.some((h) => DONE_STAGES.test(h.stage || "") || h.finishedDate);
  return {
    inProgress,
    finishedThisMonth: hasFinishDates ? finishedThisMonth.length : null,
    finishedKnown,
    target: MONTHLY_TARGET,
    note: hasFinishDates ? note : "Finished: tracking soon",
  };
}

async function getCrew(env) {
  const fallback = {
    status: "connecting",
    note: "Connecting to crew app",
    scheduleNote: "Schedule: from crew app",
    houses: [],
    scoreboard: scoreboardFrom([], "Finished: tracking soon"),
  };
  const base = (env.CREW_URL || "https://sharma-crew.sharma-crew.workers.dev").replace(/\/+$/, "");
  try {
    return await cached(env, "cache:crew", CACHE_TTL.crew, async () => {
      for (const path of ["/api/houses", "/api/tv", "/api/jobs", "/houses.json"]) {
        const r = await getJson(base + path, { env });
        if (r.ok && r.json) {
          const houses = parseCrewJson(r.json);
          if (houses.length) {
            const hasAssignments = houses.some((h) => h.crew);
            return {
              status: "live",
              note: hasAssignments ? "Today from crew app" : "Schedule: from crew app",
              scheduleNote: hasAssignments ? "Today’s crew assignments" : "Schedule: from crew app",
              houses,
              scoreboard: scoreboardFrom(houses),
            };
          }
        }
      }
      const html = await getText(base + "/", { env });
      if (!html.ok || !html.text) return { ...fallback, _cache: false };
      const houses = parseCrewHtml(html.text);
      if (!houses.length) return { ...fallback, _cache: false };
      return {
        status: "live",
        note: "Schedule: from crew app",
        scheduleNote: "Schedule: from crew app",
        houses,
        scoreboard: scoreboardFrom(houses),
      };
    });
  } catch {
    return fallback;
  }
}

/* ---------------- Inspections ---------------- */

function mapInsp(row) {
  const result = clip(row.result || row.status || "", 20);
  return {
    builder: clip(row.builder || "", 60),
    address: clip(row.address || row.job || row.job_address || "", 80),
    type: clip(row.type || row.inspection_type || row.permit_type || "Inspection", 40),
    result,
    date: clip(row.scheduled_date || row.date || row.scheduled || "", 10),
    permitNumber: clip(row.permit_number || row.draft_temp_number || row.permitNumber || "", 30),
    ahj: clip(row.ahj || row.county || "", 40),
    item: clip(row.item || row.description || row.failed_item || "", 80),
  };
}

function isOpenFail(row) {
  const r = String(row.result || "").toLowerCase();
  const fixed = row.fixed_date || row.fixedDate || row.re_inspected || row.reInspected;
  return (r === "fail" || r === "partial" || r === "failed") && !fixed;
}

async function getInspections(env, today, tomorrow) {
  const connecting = {
    status: "connecting",
    note: "Connecting to permit tracker",
    today: [],
    tomorrow: [],
    failed: [],
  };
  const base = (env.PERMITS_URL || "https://sharma-permits.sharma-crew.workers.dev").replace(/\/+$/, "");
  try {
    return await cached(env, "cache:permits", CACHE_TTL.permits, async () => {
      const paths = ["/api/tv", "/api/crew/today", "/api/inspections"];
      for (const path of paths) {
        const r = await getJson(base + path, { env });
        if (!r.ok || !r.json) continue;
        const data = r.json;
        let todayRows = data.today_inspections || data.today || data.inspectionsToday || [];
        let tomRows = data.tomorrow_inspections || data.tomorrow || data.inspectionsTomorrow || [];
        let failRows = data.open_fails || data.failed || data.failed_items || data.openFailed || [];
        if (data.inspections && !todayRows.length && !tomRows.length) {
          const list = Array.isArray(data.inspections) ? data.inspections : [];
          todayRows = list.filter((i) => (i.scheduled_date || i.date) === today);
          tomRows = list.filter((i) => (i.scheduled_date || i.date) === tomorrow);
          failRows = list.filter(isOpenFail);
        }
        if (!Array.isArray(todayRows)) todayRows = [];
        if (!Array.isArray(tomRows)) tomRows = [];
        if (!Array.isArray(failRows)) failRows = [];

        // Endpoint existed and parsed — live even if lists are empty.
        const todayItems = todayRows.map(mapInsp);
        const tomItems = tomRows.map(mapInsp);
        const failed = [
          ...todayItems.filter((i) => /fail|partial/i.test(i.result)),
          ...tomItems.filter((i) => /fail|partial/i.test(i.result)),
          ...failRows.map(mapInsp),
        ];
        const seen = new Set();
        const uniqFailed = failed.filter((f) => {
          const k = `${f.address}|${f.type}|${f.item}|${f.date}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        return {
          status: "live",
          note: "From permit tracker",
          today: todayItems,
          tomorrow: tomItems,
          failed: uniqFailed,
        };
      }
      return { ...connecting, _cache: false };
    });
  } catch {
    return connecting;
  }
}

/* ---------------- Bids ---------------- */

async function getBids(env, today, weekEnd) {
  const connecting = {
    status: "connecting",
    note: "Connecting to bid tracker",
    dueToday: [],
    dueThisWeek: [],
  };
  const base = (env.BIDS_URL || "https://sharma-bids.sharma-crew.workers.dev").replace(/\/+$/, "");
  const headers = {};
  if (env.TV_BID_SECRET) headers["X-TV-Secret"] = env.TV_BID_SECRET;
  try {
    return await cached(env, "cache:bids", CACHE_TTL.bids, async () => {
      const r = await getJson(base + "/api/tv", { headers, env });
      if (!r.ok || !r.json) return { ...connecting, _cache: false };
      const data = r.json;
      const mapBid = (b) => ({
        builder: clip(b.builder || "", 60),
        project: clip(b.project || b.job || b.address || "", 80),
        date: clip(b.date || b.followUpDate || b.follow_up_date || b.dueDate || b.due_date || "", 10),
      });
      const dueToday = (data.dueToday || data.today || []).map(mapBid);
      let dueThisWeek = (data.dueThisWeek || data.week || []).map(mapBid);
      if (!dueThisWeek.length && Array.isArray(data.bids)) {
        dueThisWeek = data.bids
          .map(mapBid)
          .filter((b) => b.date && b.date >= today && b.date <= weekEnd);
      }
      // Never pass amounts even if a future endpoint includes them.
      return {
        status: "live",
        note: "From bid tracker",
        dueToday,
        dueThisWeek: dueThisWeek.filter((b) => !dueToday.some((t) => t.builder === b.builder && t.project === b.project && t.date === b.date)),
      };
    });
  } catch {
    return connecting;
  }
}

/* ---------------- Meetings ---------------- */

function cleanEvent(e) {
  const time = clip(e.time || e.start || e.starts || "", 20);
  const title = clip(e.title || e.summary || e.name || "", 80);
  if (!title) return null;
  return { time: time || "All day", title };
}

async function postCalendar(request, env) {
  const expected = String(env.FEED_SECRET || "").trim();
  if (!expected) return json({ error: "Feed is not configured" }, 503);
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const header = (request.headers.get("x-feed-secret") || request.headers.get("x-tv-secret") || "").trim();
  const got = bearer || header;
  if (!got || !safeEqual(got, expected)) return json({ error: "Unauthorized" }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const today = todayNY();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? String(body.date) : today;
  const list = Array.isArray(body.events) ? body.events : [];
  const events = list.map(cleanEvent).filter(Boolean).slice(0, 40);
  const record = { date, updatedAt: new Date().toISOString(), events };
  await kvPutJson(env, `calendar:${date}`, record, 60 * 60 * 24 * 7);
  return json({ ok: true, date, count: events.length });
}

function unfoldIcs(text) {
  return text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function parseIcsDay(text, day) {
  const raw = unfoldIcs(text);
  const events = [];
  const blocks = raw.split(/BEGIN:VEVENT/i).slice(1);
  for (const block of blocks) {
    const body = block.split(/END:VEVENT/i)[0] || "";
    const summary = (body.match(/^SUMMARY(?:;[^:]*)?:(.*)$/m) || [, ""])[1].trim();
    const dtstart = (body.match(/^DTSTART(?:;[^:]*)?:(.*)$/m) || [, ""])[1].trim();
    if (!dtstart) continue;
    const { date, time } = icsDate(dtstart);
    if (date !== day) continue;
    const ev = cleanEvent({ time, title: summary.replace(/\\,/g, ",").replace(/\\n/g, " ") });
    if (ev) events.push(ev);
  }
  events.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return events;
}

function icsDate(value) {
  const v = value.trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/);
  if (!m) return { date: "", time: "" };
  if (!m[4]) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: "All day" };
  if (m[7] === "Z") {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || "00"}Z`);
    return formatNy(d);
  }
  // Floating / TZID times: keep the wall-clock date and time, already in local (we request NY calendars).
  const hour = Number(m[4]);
  const suffix = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    time: `${h12}:${m[5]} ${suffix}`,
  };
}

function formatNy(d) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")} ${get("dayPeriod")}`,
  };
}

async function getMeetings(env, today, ctx) {
  const empty = { status: "live", note: "", events: [] };
  let posted = [];
  const rec = await kvGetJson(env, `calendar:${today}`);
  if (rec && Array.isArray(rec.events)) {
    posted = rec.events.map(cleanEvent).filter(Boolean);
  }

  let icsEvents = [];
  const icsUrl = String(env.ICS_URL || "").trim();
  if (icsUrl) {
    try {
      const ics = await cached(env, "cache:ics", CACHE_TTL.ics, async () => {
        const r = await getText(icsUrl, { timeout: 8000, accept: "text/calendar, text/plain, */*", env });
        if (!r.ok || !r.text) return { events: [], _cache: false };
        return { events: parseIcsDay(r.text, today) };
      });
      icsEvents = (ics && ics.events) || [];
    } catch {
      icsEvents = [];
    }
  }

  const seen = new Set();
  const events = [];
  for (const e of [...icsEvents, ...posted]) {
    const k = `${e.time}|${e.title}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    events.push(e);
  }
  events.sort((a, b) => String(a.time).localeCompare(String(b.time)));
  return { status: "live", note: events.length ? "" : "", events };
}
