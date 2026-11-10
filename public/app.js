const TZ = "America/New_York";
const REFRESH_MS = 3 * 60 * 1000;

const clockEl = document.getElementById("clock");
const dateEl = document.getElementById("date");
const wxTemp = document.getElementById("wx-temp");
const wxLabel = document.getElementById("wx-label");
const wxHours = document.getElementById("wx-hours");
const updatedEl = document.getElementById("updated");
const fsBtn = document.getElementById("fs-btn");

let lastData = null;
let lastFetchAt = 0;
let wakeLock = null;

function nyParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).formatToParts(d);
  const g = (t) => (parts.find((p) => p.type === t) || {}).value || "";
  return {
    weekday: g("weekday"),
    month: g("month"),
    day: g("day"),
    year: g("year"),
    hour: g("hour"),
    minute: g("minute"),
    second: g("second"),
    dayPeriod: g("dayPeriod"),
  };
}

function tickClock() {
  const p = nyParts();
  clockEl.innerHTML = `${p.hour}:${p.minute}<span class="sec">${p.second} ${p.dayPeriod}</span>`;
  dateEl.textContent = `${p.weekday}, ${p.month} ${p.day}, ${p.year}`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function setTag(panel, status, empty) {
  const tag = panel.querySelector("[data-tag]");
  tag.className = "tag";
  if (status === "connecting") {
    tag.classList.add("connecting");
    tag.textContent = "Connecting";
  } else if (empty) {
    tag.classList.add("idle");
    tag.textContent = "None";
  } else {
    tag.classList.add("live");
    tag.textContent = "Live";
  }
}

function row({ badge, badgeClass, title, detail, side, fail }) {
  const r = el("div", fail ? "row fail" : "row");
  if (badge) r.append(el("span", `badge ${badgeClass || ""}`.trim(), badge));
  else r.append(el("span", "badge", " "));
  const meta = el("div", "meta");
  meta.append(el("div", "title", title || "—"));
  if (detail) meta.append(el("div", "detail", detail));
  r.append(meta);
  r.append(el("div", "side", side || ""));
  return r;
}

function renderCrews(data) {
  const panel = document.querySelector('[data-panel="crews"]');
  const body = panel.querySelector("[data-body]");
  const sub = panel.querySelector("[data-sub]");
  const houses = (data && data.houses) || [];
  const status = (data && data.status) || "connecting";
  sub.textContent = (data && (data.scheduleNote || data.note)) || "Schedule: from crew app";
  setTag(panel, status, status === "live" && !houses.length);
  body.replaceChildren();
  if (status !== "live") {
    body.append(el("div", "blank", "Connecting to crew app"));
    return;
  }
  if (!houses.length) {
    body.append(el("div", "blank", "No active houses"));
    return;
  }
  const groups = new Map();
  for (const h of houses) {
    const stage = h.stage || "TBD";
    if (!groups.has(stage)) groups.set(stage, []);
    groups.get(stage).push(h);
  }
  const order = ["Underground", "Rough-in", "Trim", "Final", "Service call"];
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  for (const stage of keys) {
    body.append(el("div", "group", stage));
    for (const h of groups.get(stage)) {
      const detail = [h.builder, h.plan].filter(Boolean).join(" · ");
      const r = el("div", "row simple");
      const meta = el("div", "meta");
      meta.append(el("div", "title", h.address || "—"));
      const line = h.crew ? `${detail}${detail ? " · " : ""}${h.crew}` : (detail || "From crew app");
      if (line) meta.append(el("div", "detail", line));
      r.append(meta);
      body.append(r);
    }
  }
}

function renderInspections(data) {
  const panel = document.querySelector('[data-panel="inspections"]');
  const body = panel.querySelector("[data-body]");
  const sub = panel.querySelector("[data-sub]");
  const status = (data && data.status) || "connecting";
  const today = (data && data.today) || [];
  const tomorrow = (data && data.tomorrow) || [];
  const failed = (data && data.failed) || [];
  setTag(panel, status, status === "live" && !today.length && !tomorrow.length && !failed.length);
  sub.textContent = status === "connecting"
    ? "Connecting to permit tracker"
    : (failed.length ? `${failed.length} open fail${failed.length === 1 ? "" : "s"}` : "Today & tomorrow");
  body.replaceChildren();
  if (status !== "live") {
    body.append(el("div", "blank", "Connecting to permit tracker"));
    return;
  }
  if (!today.length && !tomorrow.length && !failed.length) {
    body.append(el("div", "blank", "No inspections today or tomorrow"));
    return;
  }
  const addList = (label, list) => {
    if (!list.length) return;
    body.append(el("div", "group", label));
    for (const i of list) {
      const fail = /fail|partial/i.test(i.result || "");
      body.append(row({
        badge: fail ? (i.result || "Fail") : (i.type || "Inspection"),
        badgeClass: fail ? "fail" : "",
        title: i.address || i.builder || "Inspection",
        detail: [i.builder, i.type, i.permitNumber].filter(Boolean).join(" · "),
        side: i.ahj || "",
        fail,
      }));
    }
  };
  addList("Today", today);
  addList("Tomorrow", tomorrow);
  addList("Open failed items", failed.filter((f) => {
    // Avoid repeating today's/tomorrow's fails already listed.
    const key = `${f.address}|${f.type}|${f.date}`;
    return !today.concat(tomorrow).some((x) => `${x.address}|${x.type}|${x.date}` === key && /fail|partial/i.test(x.result || ""));
  }).map((f) => ({ ...f, result: f.result || "Fail" })));
}

function renderBids(data) {
  const panel = document.querySelector('[data-panel="bids"]');
  const body = panel.querySelector("[data-body]");
  const sub = panel.querySelector("[data-sub]");
  const status = (data && data.status) || "connecting";
  const today = (data && data.dueToday) || [];
  const week = (data && data.dueThisWeek) || [];
  setTag(panel, status, status === "live" && !today.length && !week.length);
  sub.textContent = status === "connecting" ? "Connecting to bid tracker" : "Today & this week";
  body.replaceChildren();
  if (status !== "live") {
    body.append(el("div", "blank", "Connecting to bid tracker"));
    return;
  }
  if (!today.length && !week.length) {
    body.append(el("div", "blank", "No bids due today or this week"));
    return;
  }
  const addList = (label, list) => {
    if (!list.length) return;
    body.append(el("div", "group", label));
    for (const b of list) {
      body.append(row({
        badge: label === "Today" ? "Today" : "This week",
        title: b.builder || "Builder",
        detail: b.project || "",
        side: b.date || "",
      }));
    }
  };
  addList("Today", today);
  addList("This week", week);
}

function renderMeetings(data) {
  const panel = document.querySelector('[data-panel="meetings"]');
  const body = panel.querySelector("[data-body]");
  const events = (data && data.events) || [];
  setTag(panel, "live", !events.length);
  body.replaceChildren();
  if (!events.length) {
    body.append(el("div", "blank", "No meetings"));
    return;
  }
  for (const e of events) {
    body.append(row({
      badge: e.time || "All day",
      title: e.title,
      detail: "",
      side: "",
    }));
  }
}

function renderScoreboard(crew) {
  const panel = document.querySelector('[data-panel="scoreboard"]');
  const body = panel.querySelector("[data-body]");
  const sub = panel.querySelector("[data-sub]");
  const sb = (crew && crew.scoreboard) || {};
  const status = (crew && crew.status) || "connecting";
  setTag(panel, status, false);
  const month = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "long", year: "numeric" }).format(new Date());
  sub.textContent = status === "live" ? `From crew app · ${month}` : "From crew app";
  body.replaceChildren();
  body.className = "body score-body";

  const left = el("div", "stat");
  left.append(el("div", "num", status === "live" && sb.inProgress != null ? String(sb.inProgress) : "—"));
  left.append(el("div", "lbl", "In progress"));
  left.append(el("div", "hint", "Active houses"));
  const right = el("div", "stat");
  if (status !== "live") {
    right.append(el("div", "num", "—"));
    right.append(el("div", "lbl", "Finished"));
  } else if (sb.finishedThisMonth == null) {
    right.append(el("div", "num soon", "Tracking soon"));
    right.append(el("div", "lbl", "Finished"));
    right.append(el("div", "hint", `Target ${sb.target || 30} / month`));
  } else {
    right.append(el("div", "num", String(sb.finishedThisMonth)));
    right.append(el("div", "lbl", "Finished this month"));
    right.append(el("div", "hint", `vs ${sb.target || 30} / month`));
  }
  body.append(left, right);
}

function renderWeather(wx) {
  if (!wx || wx.status !== "live" || wx.tempF == null) {
    wxTemp.textContent = "—";
    wxLabel.textContent = (wx && wx.label) || "Orlando weather";
    wxHours.replaceChildren();
    return;
  }
  wxTemp.textContent = `${wx.tempF}°`;
  const bits = ["Orlando", wx.label];
  if (wx.rainNow != null) bits.push(`${wx.rainNow}% rain`);
  wxLabel.textContent = bits.filter(Boolean).join(" · ");
  wxHours.replaceChildren();
  for (const h of wx.hours || []) {
    const n = el("div", `hour ${h.rain >= 40 ? "wet" : "dry"}`);
    n.append(el("span", "h", h.label));
    n.append(el("span", "p", h.rain == null ? "—" : `${h.rain}%`));
    wxHours.append(n);
  }
}

function truncatePanels() {
  document.querySelectorAll(".panel").forEach((panel) => {
    if (panel.dataset.panel === "scoreboard") return;
    const body = panel.querySelector("[data-body]");
    const more = panel.querySelector("[data-more]");
    if (!body || !more) return;
    // Reveal all, then hide overflow from the bottom.
    const kids = [...body.children];
    kids.forEach((k) => { k.hidden = false; });
    more.hidden = true;
    more.textContent = "";
    // Groups with no visible rows should hide too once we start clipping.
    const overflow = () => body.scrollHeight > body.clientHeight + 1;
    if (!overflow()) return;
    let hidden = 0;
    for (let i = kids.length - 1; i >= 0 && overflow(); i--) {
      const k = kids[i];
      if (k.classList.contains("blank")) break;
      k.hidden = true;
      if (!k.classList.contains("group")) hidden += 1;
    }
    // Hide trailing group headers that have no visible rows after them.
    for (let i = kids.length - 1; i >= 0; i--) {
      const k = kids[i];
      if (k.hidden) continue;
      if (k.classList.contains("group")) {
        const later = kids.slice(i + 1).some((x) => !x.hidden && !x.classList.contains("group"));
        if (!later) k.hidden = true;
      }
    }
    if (hidden > 0) {
      more.hidden = false;
      more.textContent = `+${hidden} more`;
    }
    // If the +N still overflows, hide one more row.
    while (overflow() && hidden > 0) {
      const vis = kids.filter((k) => !k.hidden && !k.classList.contains("group"));
      const last = vis[vis.length - 1];
      if (!last) break;
      last.hidden = true;
      hidden += 1;
      more.textContent = `+${hidden} more`;
    }
  });
}

function renderAll(data) {
  lastData = data;
  renderWeather(data.weather);
  renderCrews(data.crews);
  renderInspections(data.inspections);
  renderBids(data.bids);
  renderMeetings(data.meetings);
  renderScoreboard(data.crews || data.scoreboard);
  requestAnimationFrame(() => {
    truncatePanels();
    requestAnimationFrame(truncatePanels);
  });
}

function agoText(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 10) return "Updated just now";
  if (s < 60) return `Updated ${s}s ago`;
  const m = Math.round(s / 60);
  return `Updated ${m} min ago`;
}

async function loadSummary() {
  try {
    const res = await fetch("/api/summary", { cache: "no-store" });
    if (!res.ok) throw new Error("bad status");
    const data = await res.json();
    lastFetchAt = Date.now();
    renderAll(data);
  } catch (err) {
    if (!lastData) {
      renderAll({
        weather: { status: "unavailable" },
        crews: { status: "connecting", houses: [], scoreboard: {} },
        inspections: { status: "connecting", today: [], tomorrow: [], failed: [] },
        bids: { status: "connecting", dueToday: [], dueThisWeek: [] },
        meetings: { status: "live", events: [] },
      });
    }
  }
  updatedEl.textContent = agoText(lastFetchAt);
}

async function requestWake() {
  try {
    if (navigator.wakeLock && document.visibilityState === "visible") {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch {
    wakeLock = null;
  }
}

function setupFullscreen() {
  const sync = () => {
    const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    fsBtn.textContent = on ? "Exit full screen" : "Full screen";
  };
  fsBtn.addEventListener("click", async () => {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
      } else {
        const root = document.documentElement;
        if (root.requestFullscreen) await root.requestFullscreen();
        else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
      }
    } catch { /* ignore */ }
    sync();
  });
  document.addEventListener("fullscreenchange", sync);
  document.addEventListener("webkitfullscreenchange", sync);
  sync();
}

tickClock();
setInterval(tickClock, 1000);
setInterval(() => { updatedEl.textContent = agoText(lastFetchAt); }, 5000);
loadSummary();
setInterval(loadSummary, REFRESH_MS);
setupFullscreen();
requestWake();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    requestWake();
    loadSummary();
  }
});
window.addEventListener("resize", () => {
  if (lastData) {
    renderAll(lastData);
  }
});
