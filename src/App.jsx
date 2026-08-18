import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Plus, X, Check, Trash2, Settings, ChevronLeft, ChevronRight, Repeat,
  Briefcase, Home, AlertTriangle, Ban, Search, RotateCcw, Clock, Flame,
  CalendarDays, GripVertical, Undo2, BarChart3, CheckCircle2, Cloud, CloudOff
} from "lucide-react";

/* ============================== constants ============================== */

const MIN_MS = 60 * 1000;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const GRID_START_HOUR = 6;   // calendar shows 06:00 -> 24:00
const GRID_END_HOUR = 24;
const PX_PER_MIN = 1.05;
const HORIZON_DAYS = 21;
const MIN_CHUNK = 30; // minutes - smallest segment the scheduler will carve off

const PRIORITY_META = {
  urgent: { label: "Urgent", weight: 4, color: "#FF5C6C" },
  high:   { label: "High",   weight: 3, color: "#FF9F43" },
  medium: { label: "Medium", weight: 2, color: "#FFD166" },
  low:    { label: "Low",    weight: 1, color: "#6BCB77" },
};

const CATEGORY_META = {
  work:    { label: "Work",    accent: "#5B8DEF", tint: "rgba(91,141,239,0.16)", icon: Briefcase },
  private: { label: "Private", accent: "#C77DFF", tint: "rgba(199,125,255,0.16)", icon: Home },
};

const REPEAT_META = {
  none:    { label: "Does not repeat" },
  daily:   { label: "Every day" },
  weekly:  { label: "Every week" },
  monthly: { label: "Every month" },
};

/* =============================== date utils ============================= */

function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addMinutes(d, n) { return new Date(d.getTime() + n * MIN_MS); }
function addMonthsSafe(d, n) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
function sameDay(a, b) { return startOfDay(a).getTime() === startOfDay(b).getTime(); }
function toHM(d) { return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0"); }
function parseHM(base, hm) { const [h, m] = hm.split(":").map(Number); const d = new Date(base); d.setHours(h, m, 0, 0); return d; }
function fmt12(d) {
  let h = d.getHours(), m = d.getMinutes();
  const ap = h >= 12 ? "pm" : "am";
  h = h % 12; if (h === 0) h = 12;
  return m === 0 ? `${h}${ap}` : `${h}:${m.toString().padStart(2, "0")}${ap}`;
}
function dayHeaderLabel(d) { return `${DAY_LABELS[d.getDay()]} ${d.getDate()}`; }
function monthDayLabel(d) { return `${MONTH_LABELS[d.getMonth()]} ${d.getDate()}`; }
function formatDuration(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
/* short "Due Thu" / "Due 15th" / "Due last day" chip text for a repeating
   task with a pinned repeatDueRule, or null if it's left flexible */
function repeatDueLabel(task) {
  if (task.repeat === "weekly" && task.repeatDueRule != null) return `Due ${DAY_LABELS[task.repeatDueRule]}`;
  if (task.repeat === "monthly" && task.repeatDueRule != null) {
    return task.repeatDueRule === -1 ? "Due last day" : `Due ${ordinal(task.repeatDueRule)}`;
  }
  return null;
}

/* helper: which weekday's ranges apply to a day, based on category hour settings */
function rangesForDay(day, rangesByWeekday) {
  const wd = day.getDay();
  const ranges = rangesByWeekday[wd] || [];
  return ranges.map(r => ({ start: parseHM(day, r.start), end: parseHM(day, r.end) }));
}

function subtractBusy(freeRanges, busy) {
  let result = freeRanges.slice();
  for (const b of busy) {
    const next = [];
    for (const f of result) {
      if (b.end <= f.start || b.start >= f.end) { next.push(f); continue; }
      if (b.start > f.start) next.push({ start: f.start, end: new Date(Math.min(b.start.getTime(), f.end.getTime())) });
      if (b.end < f.end) next.push({ start: new Date(Math.max(b.end.getTime(), f.start.getTime())), end: f.end });
    }
    result = next.filter(r => r.end > r.start);
  }
  return result;
}

function dayKey(d) { return startOfDay(d).toISOString().slice(0, 10); }

/* number of days in a given month (month is 0-indexed, matches Date's getMonth()) */
function daysInMonth(year, month) { return new Date(year, month + 1, 0).getDate(); }

/**
 * The period windows a repeating task should get a fresh, independent
 * occurrence for within [today, today+horizonDays) — one per day for
 * "daily", one per week for "weekly", one per month for "monthly". Each
 * period gets its own occurrenceKey so it can be completed, dragged, or
 * left unscheduled independently of every other period.
 *
 * `dueRule` optionally pins the period's deadline to a specific day instead
 * of just "whenever the period happens to end":
 *   - weekly:  dueRule is a weekday number, 0 (Sun) .. 6 (Sat)
 *   - monthly: dueRule is a day-of-month, 1..31, or -1 for "last day of month"
 * When dueRule is null/undefined the task is "flexible" and keeps the
 * original rolling-window behavior (period end = the deadline, wherever
 * that happens to fall relative to today).
 */
function periodsFor(repeat, today, horizonDays, dueRule) {
  const periods = [];
  const horizonEnd = addDays(today, horizonDays);
  if (repeat === "daily") {
    for (let i = 0; i < horizonDays; i++) {
      const start = addDays(today, i);
      periods.push({ start, end: addDays(start, 1), key: `d:${dayKey(start)}` });
    }
  } else if (repeat === "weekly") {
    if (dueRule == null) {
      for (let i = 0; i < horizonDays; i += 7) {
        const start = addDays(today, i);
        periods.push({ start, end: addDays(start, 7), key: `w:${dayKey(start)}` });
      }
    } else {
      // periods run from the day after one due-weekday to the next due-weekday
      // (inclusive), so "due every Thursday" gives each week a real Thursday
      // deadline instead of an arbitrary 7-day-from-today window.
      let periodStart = today, guard = 0;
      while (periodStart < horizonEnd && guard < 30) {
        const diff = (dueRule - periodStart.getDay() + 7) % 7;
        const due = addDays(periodStart, diff);
        periods.push({ start: periodStart, end: addDays(due, 1), key: `w:${dayKey(due)}` });
        periodStart = addDays(due, 1);
        guard++;
      }
    }
  } else if (repeat === "monthly") {
    if (dueRule == null) {
      let start = today, guard = 0;
      while (start < horizonEnd && guard < 12) {
        const end = addMonthsSafe(start, 1);
        periods.push({ start, end, key: `m:${dayKey(start)}` });
        start = end;
        guard++;
      }
    } else {
      // periods run from the day after one due-day-of-month to the next
      // (inclusive), so "due the 15th" gives each month a real 15th deadline;
      // short months clamp to their last day (or dueRule === -1 always means
      // "the last day of the month", whatever that is).
      let periodStart = today, guard = 0;
      while (periodStart < horizonEnd && guard < 12) {
        const y = periodStart.getFullYear(), m = periodStart.getMonth();
        const dim = daysInMonth(y, m);
        const targetDay = dueRule === -1 ? dim : Math.min(dueRule, dim);
        let due = new Date(y, m, targetDay);
        if (due < periodStart) {
          const nm = m + 1, ny = y + Math.floor(nm / 12), nmi = ((nm % 12) + 12) % 12;
          const dim2 = daysInMonth(ny, nmi);
          due = new Date(ny, nmi, dueRule === -1 ? dim2 : Math.min(dueRule, dim2));
        }
        periods.push({ start: periodStart, end: addDays(due, 1), key: `m:${dayKey(due)}` });
        periodStart = addDays(due, 1);
        guard++;
      }
    }
  }
  return periods;
}

/* ============================ scheduling engine ========================== */
/**
 * Greedy heuristic time-blocking scheduler.
 * - Locked blocks (user-dragged) are always respected as fixed and are
 *   subtracted from availability before anything else is placed.
 * - Remaining tasks are sorted by priority, then by due date.
 * - Each task is dropped into the earliest free slots inside its category's
 *   working hours, splitting across multiple slots/days ("segments") if a
 *   single slot isn't long enough to hold it.
 * - If a task still doesn't fit before its due date, the scheduler keeps
 *   trying slots after the due date (within the horizon) and flags it
 *   "overdue" so the UI can call it out.
 */
/**
 * Clip a day's available ranges so nothing before `now` counts as free —
 * otherwise the greedy auto-scheduler (which always fills the earliest open
 * slot) will happily backfill tasks into today's already-passed hours the
 * moment anything reshuffles (e.g. completing a task frees up a later slot,
 * pulling a subsequent task earlier into a slot that's since become past).
 * Rounds up to the next 15-minute mark so newly-opened slots land on a clean
 * boundary instead of "right now, down to the second".
 */
function clipRangesToNow(ranges, now) {
  const cutoff = new Date(Math.ceil(now.getTime() / (15 * MIN_MS)) * (15 * MIN_MS));
  return ranges
    .map(r => (r.start < cutoff ? { start: cutoff, end: r.end } : r))
    .filter(r => r.end > r.start);
}

function computeSchedule({ tasks, blockedEvents, lockedBlocks, completedOccurrences, horizonDays = HORIZON_DAYS, minChunk = MIN_CHUNK, workRanges, privateRanges, now = new Date() }) {
  const today = startOfDay(now);
  const doneSet = new Set(completedOccurrences || []);

  const expandedBlocked = [];
  for (const be of blockedEvents) {
    if (be.recurringWeekly) {
      for (let i = 0; i < horizonDays; i++) {
        const day = addDays(today, i);
        if (day.getDay() === be.weekday) {
          expandedBlocked.push({ start: parseHM(day, be.startHM), end: parseHM(day, be.endHM), title: be.title, id: be.id + "-" + i });
        }
      }
    } else {
      const s = new Date(be.start);
      if (s >= today) expandedBlocked.push({ start: new Date(be.start), end: new Date(be.end), title: be.title, id: be.id });
    }
  }

  const lockedRanges = lockedBlocks.map(b => ({ start: new Date(b.start), end: new Date(b.end) }));

  const freeMap = {};
  for (let i = 0; i < horizonDays; i++) {
    const day = addDays(today, i);
    for (const category of ["work", "private"]) {
      let ranges = rangesForDay(day, category === "work" ? workRanges : privateRanges);
      if (i === 0) ranges = clipRangesToNow(ranges, now);
      const busy = [...expandedBlocked, ...lockedRanges];
      freeMap[`${i}-${category}`] = subtractBusy(ranges, busy);
    }
  }

  // build one instance per task (non-repeating) or one per period within the
  // horizon (repeating) — each independently schedulable, lockable, and
  // completable, so a daily task actually gets a fresh block every day
  // instead of a single occurrence for the whole week.
  const instances = [];
  for (const t of tasks) {
    if (t.repeat === "none" || !t.repeat) {
      if (t.completed) continue;
      const lockedForOcc = lockedBlocks.filter(b => b.taskId === t.id && !b.occurrenceKey);
      const lockedMinutes = lockedForOcc.reduce((s, b) => s + (new Date(b.end) - new Date(b.start)) / MIN_MS, 0);
      const remaining = Math.max(0, t.duration - lockedMinutes);
      if (remaining <= 0) continue;
      instances.push({
        taskId: t.id, occurrenceKey: null, name: t.name, category: t.category, priority: t.priority,
        due: t.dueDate ? new Date(t.dueDate) : null, remaining,
      });
    } else {
      for (const p of periodsFor(t.repeat, today, horizonDays, t.repeatDueRule)) {
        const occurrenceKey = `${t.id}::${p.key}`;
        if (doneSet.has(occurrenceKey)) continue;
        const lockedForOcc = lockedBlocks.filter(b => b.occurrenceKey === occurrenceKey);
        const lockedMinutes = lockedForOcc.reduce((s, b) => s + (new Date(b.end) - new Date(b.start)) / MIN_MS, 0);
        const remaining = Math.max(0, t.duration - lockedMinutes);
        if (remaining <= 0) continue;
        instances.push({
          taskId: t.id, occurrenceKey, name: t.name, category: t.category, priority: t.priority,
          due: p.end, periodStart: p.start, remaining,
        });
      }
    }
  }

  instances.sort((a, b) => {
    const pw = PRIORITY_META[b.priority].weight - PRIORITY_META[a.priority].weight;
    if (pw !== 0) return pw;
    if (a.due && b.due) return a.due - b.due;
    if (a.due) return -1;
    if (b.due) return 1;
    return 0;
  });

  const autoBlocks = [];
  const overdue = new Set();
  const unscheduled = new Set();

  for (const inst of instances) {
    let remaining = inst.remaining;
    const startIdx = inst.periodStart ? Math.max(0, Math.floor((startOfDay(inst.periodStart) - today) / (24 * 60 * MIN_MS))) : 0;
    // `due` marks the EXCLUSIVE end of a recurring instance's period (e.g. a
    // daily period's due is midnight of the *next* day) — convert that to the
    // last day index actually inside the period, or the loop below would
    // wrongly reach one day past it (this is what let a Sunday occurrence
    // spill over onto Monday).
    const dueIdx = inst.periodStart
      ? startIdx + Math.round((inst.due - inst.periodStart) / (24 * 60 * MIN_MS)) - 1
      : (inst.due ? Math.floor((startOfDay(inst.due) - today) / (24 * 60 * MIN_MS)) : horizonDays - 1);
    // recurring occurrences stay within their own day/week/month — if a given
    // day has no room (e.g. a work task on a day with no work hours), that
    // day's instance is simply missed rather than piling onto a later day.
    // Non-repeating tasks still get the "search after the due date" fallback,
    // since finishing a one-off task late generally beats not at all.
    const maxPass = inst.occurrenceKey ? 1 : 2;
    let segIndex = 0;
    for (let pass = 0; pass < maxPass && remaining > 0; pass++) {
      const startI = pass === 0 ? startIdx : Math.max(startIdx, dueIdx + 1);
      const endI = pass === 0 ? Math.min(dueIdx, horizonDays - 1) : horizonDays - 1;
      if (startI > endI) continue;
      for (let i = startI; i <= endI && remaining > 0; i++) {
        const key = `${i}-${inst.category}`;
        const free = freeMap[key];
        for (let s = 0; s < free.length && remaining > 0; s++) {
          const slot = free[s];
          const slotMin = (slot.end - slot.start) / MIN_MS;
          if (slotMin < Math.min(minChunk, remaining)) continue;
          const take = Math.min(slotMin, remaining);
          const blockStart = slot.start;
          const blockEnd = addMinutes(blockStart, take);
          segIndex += 1;
          autoBlocks.push({
            id: `auto-${inst.taskId}-${inst.occurrenceKey || "x"}-${blockStart.getTime()}`,
            taskId: inst.taskId, occurrenceKey: inst.occurrenceKey, name: inst.name, category: inst.category,
            start: blockStart, end: blockEnd, locked: false, segIndex,
          });
          remaining -= take;
          free[s] = { start: blockEnd, end: slot.end };
        }
      }
      if (remaining > 0 && inst.due) overdue.add(inst.taskId);
    }
    if (remaining > 0) unscheduled.add(inst.taskId);
  }

  // total segment counts, grouped per occurrence (so each day of a daily
  // task counts its own segments, rather than lumping the whole week together)
  const totalByGroup = {};
  for (const b of autoBlocks) {
    const g = b.occurrenceKey || b.taskId;
    totalByGroup[g] = (totalByGroup[g] || 0) + 1;
  }
  for (const b of autoBlocks) b.segTotal = totalByGroup[b.occurrenceKey || b.taskId];

  return { autoBlocks, expandedBlocked, overdue: [...overdue], unscheduled: [...unscheduled] };
}

/* ============================= default seed data ========================= */

function seedTasks() {
  const today = startOfDay(new Date());
  return [
    { id: uid(), name: "Review MPRA figure drafts", category: "work", priority: "high", duration: 120, dueDate: addDays(today, 2).toISOString(), repeat: "none", repeatDueRule: null, completed: false, lastCompletedAt: null },
    { id: uid(), name: "Reply to lab emails", category: "work", priority: "medium", duration: 30, dueDate: null, repeat: "daily", repeatDueRule: null, completed: false, lastCompletedAt: null },
    { id: uid(), name: "Grocery run", category: "private", priority: "medium", duration: 60, dueDate: null, repeat: "weekly", repeatDueRule: null, completed: false, lastCompletedAt: null },
    { id: uid(), name: "Gym session", category: "private", priority: "low", duration: 75, dueDate: null, repeat: "weekly", repeatDueRule: 4, completed: false, lastCompletedAt: null },
    { id: uid(), name: "Prep NIW recommender notes", category: "work", priority: "urgent", duration: 180, dueDate: addDays(today, 4).toISOString(), repeat: "none", repeatDueRule: null, completed: false, lastCompletedAt: null },
  ];
}
function seedWorkRanges() {
  return { 0: [], 1: [{ start: "09:00", end: "17:00" }], 2: [{ start: "09:00", end: "17:00" }], 3: [{ start: "09:00", end: "17:00" }], 4: [{ start: "09:00", end: "17:00" }], 5: [{ start: "09:00", end: "17:00" }], 6: [] };
}
function seedPrivateRanges() {
  return { 0: [{ start: "10:00", end: "21:00" }], 1: [{ start: "18:00", end: "22:30" }], 2: [{ start: "18:00", end: "22:30" }], 3: [{ start: "18:00", end: "22:30" }], 4: [{ start: "18:00", end: "22:30" }], 5: [{ start: "17:00", end: "23:00" }], 6: [{ start: "10:00", end: "22:00" }] };
}
function seedBlockedEvents() {
  return [{ id: uid(), title: "Lab meeting", recurringWeekly: true, weekday: 2, startHM: "12:00", endHM: "13:00" }];
}

/* ============================ persistence helpers ========================= */
// A real deployed site has normal localStorage, unlike Claude's artifact
// sandbox — this keeps everything on-device instantly, with Drive (below)
// as the optional cross-device layer on top.

async function loadKey(key, fallback) {
  try {
    const raw = window.localStorage.getItem(`slate:${key}`);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* storage unavailable or bad JSON */ }
  return fallback;
}
async function saveKey(key, value) {
  try { window.localStorage.setItem(`slate:${key}`, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

/* ============================ google drive sync ============================ */
/**
 * Mirrors the app's full state as a single JSON file in the user's own Google
 * Drive, using the "drive.file" scope — which only ever grants access to
 * files this app itself creates (never the rest of the user's Drive).
 *
 * IMPORTANT: this requires a Google OAuth Client ID configured for the exact
 * URL the app is running on, so it only works once this app is deployed to a
 * real address (see the setup notes in the Drive sync panel). It will not
 * work inside a sandboxed in-chat preview.
 */
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
// Bumped by hand on every meaningful code change, and shown in the Drive
// sync panel — a quick way to confirm a device is actually running the
// latest deployed build rather than something stale a service worker or
// browser cache is still hanging onto.
const BUILD_TAG = "2026.08.18-15";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_FILE_NAME = "slate-schedule.json";

function isClientIdConfigured() {
  return !!GOOGLE_CLIENT_ID;
}

function loadGoogleIdentityScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const existing = document.getElementById("gis-client-script");
    if (existing) { existing.addEventListener("load", () => resolve()); existing.addEventListener("error", reject); return; }
    const script = document.createElement("script");
    script.id = "gis-client-script";
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Couldn't reach Google's sign-in script — this page's origin may not be allowed yet, or it's running somewhere without network access to accounts.google.com."));
    document.head.appendChild(script);
  });
}

async function driveFindFile(token) {
  const q = encodeURIComponent(`name='${DRIVE_FILE_NAME}' and trashed=false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name,modifiedTime)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Couldn't search your Drive for the schedule file.");
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

async function driveCreateFile(token, payload) {
  const metadata = { name: DRIVE_FILE_NAME, mimeType: "application/json" };
  const boundary = "slate-sync-boundary";
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(payload)}\r\n--${boundary}--`;
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error("Couldn't create the schedule file in Drive.");
  return res.json();
}

async function driveWriteFile(token, fileId, payload) {
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Couldn't save to Drive — your Drive session may have expired.");
  return res.json();
}

async function driveReadFile(token, fileId) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Couldn't read the schedule file from Drive.");
  return res.json();
}

function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// Remembers the live Drive connection (access token + which file, with the
// token's own expiry) in sessionStorage, so refreshing the page resumes the
// same session instead of forcing a full reconnect + reconciliation every
// time. Cleared automatically once the token's actual expiry passes, and
// whenever you close the tab (sessionStorage's normal behavior) or disconnect.
const DRIVE_SESSION_KEY = "slate:driveSession";
function saveDriveSession(token, expiresAt, fileId) {
  try { window.sessionStorage.setItem(DRIVE_SESSION_KEY, JSON.stringify({ token, expiresAt, fileId })); } catch (e) { /* ignore */ }
}
function loadDriveSession() {
  try {
    const raw = window.sessionStorage.getItem(DRIVE_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed.token || !parsed.fileId || !parsed.expiresAt || Date.now() >= parsed.expiresAt - 30000) return null;
    return parsed;
  } catch (e) { return null; }
}
function clearDriveSession() {
  try { window.sessionStorage.removeItem(DRIVE_SESSION_KEY); } catch (e) { /* ignore */ }
}

/* which occurrence of a repeating task "today" (or this week/month) counts
   as, for the sidebar's simple checkbox — reuses periodsFor's own logic (with
   horizonDays=1, which is enough to always yield exactly the current period)
   so this always lines up with whatever computeSchedule considers period 0,
   whether the task is flexible or pinned to a specific due weekday/day. */
function currentPeriodKeyFor(task, refDate) {
  if (!task.repeat || task.repeat === "none") return null;
  const today = startOfDay(refDate);
  const periods = periodsFor(task.repeat, today, 1, task.repeatDueRule);
  if (!periods.length) return null;
  return `${task.id}::${periods[0].key}`;
}

/* =================================== app =================================== */

export default function App() {
  const [ready, setReady] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [blockedEvents, setBlockedEvents] = useState([]);
  const [lockedBlocks, setLockedBlocks] = useState([]);
  const [workRanges, setWorkRanges] = useState({});
  const [privateRanges, setPrivateRanges] = useState({});
  const [completionLog, setCompletionLog] = useState([]); // history of completions, for the weekly review
  const [completedOccurrences, setCompletedOccurrences] = useState([]); // which specific periods of repeating tasks are done, e.g. "taskId::d:2026-08-17"

  const [weekStartOffset, setWeekStartOffset] = useState(0); // in days
  const [taskModal, setTaskModal] = useState(null); // null | 'new' | task object
  const [hoursModalOpen, setHoursModalOpen] = useState(false);
  const [blockedModal, setBlockedModal] = useState(null); // null | 'new' | event object
  const [reviewOpen, setReviewOpen] = useState(false);
  const [completingTask, setCompletingTask] = useState(null); // task pending "how long did it actually take"
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  // undo stack for drag-to-reschedule / unlock actions (stores previous lockedBlocks snapshots)
  const [undoStack, setUndoStack] = useState([]);

  // a live clock: ticks every 30s so the "now" line and today's highlight
  // keep moving even if you just leave the tab open without touching anything
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  // Google Drive sync
  const [drive, setDrive] = useState({ status: "disconnected", fileId: null, lastSyncedAt: null, error: null });
  const [driveModalOpen, setDriveModalOpen] = useState(false);
  const [mobileTasksOpen, setMobileTasksOpen] = useState(false);
  const [driveConflict, setDriveConflict] = useState(null); // {fileId, driveData, localPayload, token}
  const driveTokenRef = useRef(null);
  const driveTokenExpiryRef = useRef(null);
  // the updatedAt string of the last version of the data we know Drive has —
  // whether because we just wrote it, or just pulled it. Lets the polling
  // check below tell "something changed elsewhere" apart from "I just wrote this myself"
  const lastKnownDriveUpdatedAtRef = useRef(null);

  // tracks whether THIS device has ever had real (non-default) data typed
  // into it, and when it was actually last changed — used to tell a fresh
  // device apart from one with real edits worth protecting during sync
  const [hasLocalEdits, setHasLocalEdits] = useState(false);
  const [localUpdatedAt, setLocalUpdatedAt] = useState(null);
  const skipNextEditMarkRef = useRef(true);

  /* ---- load once ---- */
  useEffect(() => {
    (async () => {
      const [t, be, lb, wr, pr, cl, co, hle, lua] = await Promise.all([
        loadKey("tasks", null),
        loadKey("blockedEvents", null),
        loadKey("lockedBlocks", null),
        loadKey("workRanges", null),
        loadKey("privateRanges", null),
        loadKey("completionLog", null),
        loadKey("completedOccurrences", null),
        loadKey("hasLocalEdits", false),
        loadKey("localUpdatedAt", null),
      ]);
      setTasks(t || seedTasks());
      setBlockedEvents(be || seedBlockedEvents());
      setLockedBlocks(lb || []);
      setWorkRanges(wr || seedWorkRanges());
      setPrivateRanges(pr || seedPrivateRanges());
      setCompletionLog(cl || []);
      setCompletedOccurrences(co || []);
      setHasLocalEdits(hle);
      setLocalUpdatedAt(lua);
      setReady(true);
    })();
  }, []);

  /* ---- persist on change ---- */
  useEffect(() => { if (ready) saveKey("tasks", tasks); }, [tasks, ready]);
  useEffect(() => { if (ready) saveKey("blockedEvents", blockedEvents); }, [blockedEvents, ready]);
  useEffect(() => { if (ready) saveKey("lockedBlocks", lockedBlocks); }, [lockedBlocks, ready]);
  useEffect(() => { if (ready) saveKey("workRanges", workRanges); }, [workRanges, ready]);
  useEffect(() => { if (ready) saveKey("privateRanges", privateRanges); }, [privateRanges, ready]);
  useEffect(() => { if (ready) saveKey("completionLog", completionLog); }, [completionLog, ready]);
  useEffect(() => { if (ready) saveKey("completedOccurrences", completedOccurrences); }, [completedOccurrences, ready]);
  useEffect(() => { if (ready) saveKey("hasLocalEdits", hasLocalEdits); }, [hasLocalEdits, ready]);
  useEffect(() => { if (ready) saveKey("localUpdatedAt", localUpdatedAt); }, [localUpdatedAt, ready]);

  // marks this device as having "real" data worth protecting during sync,
  // and records exactly when it actually changed — but skips the very first
  // run right after loading, so simply opening the app doesn't count as an edit
  useEffect(() => {
    if (!ready) return;
    if (skipNextEditMarkRef.current) { skipNextEditMarkRef.current = false; console.log("[Slate/Drive] initial load — not marking as edited"); return; }
    console.log("[Slate/Drive] marking this device as having real edits, task count =", tasks.length);
    setHasLocalEdits(true);
    setLocalUpdatedAt(new Date().toISOString());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, blockedEvents, lockedBlocks, workRanges, privateRanges, completionLog, completedOccurrences, ready]);

  /* ---- undo keyboard shortcut (Ctrl/Cmd+Z) ---- */
  useEffect(() => {
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoStack, lockedBlocks]);

  function showToast(msg) {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }

  /* ---- scheduling (recomputed whenever inputs change, or the clock ticks
     past a 15-min boundary — see `now` below — so today's already-passed
     hours never get reclaimed as free by the auto-scheduler) ---- */
  const schedule = useMemo(() => {
    if (!ready) return { autoBlocks: [], expandedBlocked: [], overdue: [], unscheduled: [] };
    return computeSchedule({ tasks, blockedEvents, lockedBlocks, completedOccurrences, workRanges, privateRanges, now });
  }, [tasks, blockedEvents, lockedBlocks, completedOccurrences, workRanges, privateRanges, now, ready]);

  const tasksById = useMemo(() => Object.fromEntries(tasks.map(t => [t.id, t])), [tasks]);

  const allBlocks = useMemo(() => {
    const locked = lockedBlocks.map(b => {
      const t = tasksById[b.taskId];
      return { id: b.id, taskId: b.taskId, occurrenceKey: b.occurrenceKey || null, name: t ? t.name : "(deleted task)", category: t ? t.category : "work", start: new Date(b.start), end: new Date(b.end), locked: true, segIndex: 1, segTotal: 1 };
    });
    return [...locked, ...schedule.autoBlocks];
  }, [lockedBlocks, schedule.autoBlocks, tasksById]);

  /* ---- task CRUD ---- */
  function addTask(data) {
    setTasks(prev => [...prev, { id: uid(), completed: false, lastCompletedAt: null, ...data }]);
    showToast(`Added "${data.name}"`);
  }
  function updateTask(id, patch) {
    setTasks(prev => prev.map(t => (t.id === id ? { ...t, ...patch } : t)));
  }
  function deleteTask(id) {
    setTasks(prev => prev.filter(t => t.id !== id));
    setLockedBlocks(prev => prev.filter(b => b.taskId !== id));
    showToast("Task deleted");
  }
  function toggleComplete(task, occurrenceKey) {
    if (task.repeat && task.repeat !== "none") {
      const key = occurrenceKey || currentPeriodKeyFor(task, now);
      if (completedOccurrences.includes(key)) {
        setCompletedOccurrences(prev => prev.filter(k => k !== key));
      } else {
        setCompletingTask({ task, occurrenceKey: key });
      }
      return;
    }
    if (!task.completed) {
      // completing now — ask how long it actually took before logging it
      setCompletingTask({ task, occurrenceKey: null });
    } else {
      // un-completing — just flip it back, no need to touch the log
      setTasks(prev => prev.map(t => (t.id === task.id ? { ...t, completed: false } : t)));
    }
  }

  function confirmComplete(task, occurrenceKey, actualDuration) {
    setCompletionLog(prev => [...prev, {
      id: uid(), taskId: task.id, name: task.name, category: task.category, priority: task.priority,
      estimatedDuration: task.duration, actualDuration, completedAt: new Date().toISOString(),
    }]);
    if (task.repeat && task.repeat !== "none") {
      setLockedBlocks(prev => prev.filter(b => b.occurrenceKey !== occurrenceKey)); // free up any locked slot for just this occurrence
      setCompletedOccurrences(prev => [...prev, occurrenceKey]);
      showToast(`Nice work! "${task.name}" is done for this period — it'll come back next time around`);
    } else {
      setLockedBlocks(prev => prev.filter(b => b.taskId !== task.id));
      setTasks(prev => prev.map(t => (t.id === task.id ? { ...t, completed: true, lastCompletedAt: new Date().toISOString() } : t)));
      showToast(`Marked "${task.name}" complete — rescheduling the rest of your week`);
    }
    setCompletingTask(null);
  }

  /* ---- blocked events CRUD ---- */
  function saveBlockedEvent(data) {
    if (data.id) {
      setBlockedEvents(prev => prev.map(e => (e.id === data.id ? data : e)));
    } else {
      setBlockedEvents(prev => [...prev, { ...data, id: uid() }]);
    }
  }
  function deleteBlockedEvent(id) { setBlockedEvents(prev => prev.filter(e => e.id !== id)); }

  /* ---- undo (for drag / unlock actions) ---- */
  function pushUndoSnapshot() {
    setUndoStack(prev => [...prev.slice(-19), lockedBlocks]);
  }
  function undo() {
    setUndoStack(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      setLockedBlocks(last);
      showToast("Undid last change");
      return prev.slice(0, -1);
    });
  }

  /* ---- drag to reschedule ---- */
  function lockBlockAt(block, newStart) {
    pushUndoSnapshot();
    const durationMin = (block.end - block.start) / MIN_MS;
    const newEnd = addMinutes(newStart, durationMin);
    setLockedBlocks(prev => {
      const withoutThis = prev.filter(b => b.id !== block.id);
      return [...withoutThis, { id: block.locked ? block.id : uid(), taskId: block.taskId, occurrenceKey: block.occurrenceKey || null, start: newStart.toISOString(), end: newEnd.toISOString() }];
    });
    showToast("Block moved — everything else adjusted around it");
  }
  function unlockBlock(block) {
    pushUndoSnapshot();
    setLockedBlocks(prev => prev.filter(b => b.id !== block.id));
    showToast("Block reset to auto-scheduling");
  }

  /* ---- google drive sync ---- */
  function buildSyncPayload() {
    return { tasks, blockedEvents, lockedBlocks, workRanges, privateRanges, completionLog, completedOccurrences, updatedAt: new Date().toISOString() };
  }
  function applyDriveData(data) {
    if (Array.isArray(data.tasks)) setTasks(data.tasks);
    if (Array.isArray(data.blockedEvents)) setBlockedEvents(data.blockedEvents);
    if (Array.isArray(data.lockedBlocks)) setLockedBlocks(data.lockedBlocks);
    if (data.workRanges) setWorkRanges(data.workRanges);
    if (data.privateRanges) setPrivateRanges(data.privateRanges);
    if (Array.isArray(data.completionLog)) setCompletionLog(data.completionLog);
    if (Array.isArray(data.completedOccurrences)) setCompletedOccurrences(data.completedOccurrences);
  }

  function connectDrive() {
    if (!isClientIdConfigured()) {
      setDrive(d => ({ ...d, status: "error", error: "No Google Client ID is set up yet for this deployment — see the setup notes below." }));
      return;
    }
    setDrive(d => ({ ...d, status: "connecting", error: null }));
    loadGoogleIdentityScript()
      .then(() => {
        const tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: DRIVE_SCOPE,
          callback: async (resp) => {
            if (resp.error) {
              setDrive(d => ({ ...d, status: "error", error: "Google didn't grant access — you can try again." }));
              return;
            }
            driveTokenRef.current = resp.access_token;
            const expiresAt = Date.now() + (Number(resp.expires_in || 3600) * 1000);
            driveTokenExpiryRef.current = expiresAt;
            await handleDriveConnected(resp.access_token);
          },
        });
        tokenClient.requestAccessToken();
      })
      .catch(err => setDrive(d => ({ ...d, status: "error", error: err.message })));
  }

  async function handleDriveConnected(token) {
    try {
      let file = await driveFindFile(token);
      const localPayload = buildSyncPayload();
      console.log("[Slate/Drive] connect: file found?", !!file, file);
      console.log("[Slate/Drive] connect: hasLocalEdits =", hasLocalEdits, "local task count =", localPayload.tasks.length);

      if (!file) {
        file = await driveCreateFile(token, localPayload);
        console.log("[Slate/Drive] branch: created new file (none existed)", file.id);
        lastKnownDriveUpdatedAtRef.current = localPayload.updatedAt;
        setDrive({ status: "connected", fileId: file.id, lastSyncedAt: new Date().toISOString(), error: null });
        showToast("Connected — this device's schedule is now on Drive");
        return;
      }

      const driveData = await driveReadFile(token, file.id);
      // "Has this file ever been really synced?" should be based on whether it
      // was ever actually written by the app (it always carries an updatedAt
      // stamp when it has), NOT on whether tasks happens to be non-empty right
      // now — a legitimately-synced file can validly have zero tasks in it
      // (e.g. everything got completed elsewhere), and treating that as "blank,
      // nothing to lose" was exactly what caused silent overwrites.
      const driveHasData = !!(driveData && typeof driveData === "object" && driveData.updatedAt);
      console.log("[Slate/Drive] connect: driveData =", driveData, "driveHasData =", driveHasData);

      if (!driveHasData) {
        // Drive file exists but is empty/blank — nothing to lose, just push this device's data
        console.log("[Slate/Drive] branch: drive file had no real data, pushing local");
        await driveWriteFile(token, file.id, localPayload);
        lastKnownDriveUpdatedAtRef.current = localPayload.updatedAt;
        setDrive({ status: "connected", fileId: file.id, lastSyncedAt: new Date().toISOString(), error: null });
        showToast("Connected — this device's schedule is now on Drive");
        return;
      }

      if (!hasLocalEdits) {
        // this device has nothing of its own worth keeping yet (still just the
        // starter tasks, or truly untouched) — adopt Drive's real schedule, no prompt needed
        console.log("[Slate/Drive] branch: no local edits, pulling from Drive");
        applyDriveData(driveData);
        lastKnownDriveUpdatedAtRef.current = driveData.updatedAt;
        setDrive({ status: "connected", fileId: file.id, lastSyncedAt: new Date().toISOString(), error: null });
        showToast("Loaded your schedule from Drive");
        return;
      }

      const sameContent =
        JSON.stringify(driveData.tasks) === JSON.stringify(localPayload.tasks) &&
        JSON.stringify(driveData.blockedEvents) === JSON.stringify(localPayload.blockedEvents) &&
        JSON.stringify(driveData.completionLog) === JSON.stringify(localPayload.completionLog) &&
        JSON.stringify(driveData.completedOccurrences) === JSON.stringify(localPayload.completedOccurrences);
      console.log("[Slate/Drive] connect: sameContent =", sameContent);

      if (sameContent) {
        lastKnownDriveUpdatedAtRef.current = driveData.updatedAt;
        setDrive({ status: "connected", fileId: file.id, lastSyncedAt: new Date().toISOString(), error: null });
        showToast("Already in sync with Drive");
        return;
      }

      // both sides have real, different data — let the person choose, rather than guessing
      console.log("[Slate/Drive] branch: showing conflict dialog");
      setDriveConflict({ fileId: file.id, driveData, localPayload, token });
      setDrive(d => ({ ...d, status: "connecting" }));
    } catch (e) {
      console.log("[Slate/Drive] connect: threw an error", e);
      setDrive(d => ({ ...d, status: "error", error: e.message }));
    }
  }

  function resolveDriveConflict(choice) {
    const { fileId, driveData, localPayload, token } = driveConflict;
    if (choice === "cancel") {
      setDrive({ status: "disconnected", fileId: null, lastSyncedAt: null, error: null });
      showToast("Connection cancelled — nothing was changed");
    } else if (choice === "drive") {
      applyDriveData(driveData);
      lastKnownDriveUpdatedAtRef.current = driveData.updatedAt;
      setDrive({ status: "connected", fileId, lastSyncedAt: new Date().toISOString(), error: null });
      showToast("Loaded the version from Drive");
    } else {
      driveWriteFile(token, fileId, localPayload)
        .then(() => {
          lastKnownDriveUpdatedAtRef.current = localPayload.updatedAt;
          setDrive({ status: "connected", fileId, lastSyncedAt: new Date().toISOString(), error: null });
          showToast("Pushed this device's schedule to Drive");
        })
        .catch(e => setDrive(d => ({ ...d, status: "error", error: e.message })));
    }
    setDriveConflict(null);
  }

  function disconnectDrive() {
    driveTokenRef.current = null;
    driveTokenExpiryRef.current = null;
    clearDriveSession();
    setDrive({ status: "disconnected", fileId: null, lastSyncedAt: null, error: null });
    showToast("Disconnected — your data stays on this device only");
  }

  function manualSyncDrive() {
    if (drive.status !== "connected" || !driveTokenRef.current || !drive.fileId) return;
    const payload = buildSyncPayload();
    driveWriteFile(driveTokenRef.current, drive.fileId, payload)
      .then(() => { lastKnownDriveUpdatedAtRef.current = payload.updatedAt; setDrive(d => ({ ...d, lastSyncedAt: new Date().toISOString() })); showToast("Synced to Drive"); })
      .catch(() => { setDrive(d => ({ ...d, status: "expired", error: "Drive session expired — reconnect to keep syncing." })); showToast("Drive sync failed — reconnect to keep going"); });
  }

  // auto-push to Drive a couple seconds after any change, once connected
  useEffect(() => {
    if (drive.status !== "connected" || !driveTokenRef.current || !drive.fileId) return;
    const t = setTimeout(() => {
      const payload = buildSyncPayload();
      driveWriteFile(driveTokenRef.current, drive.fileId, payload)
        .then(() => { lastKnownDriveUpdatedAtRef.current = payload.updatedAt; setDrive(d => ({ ...d, lastSyncedAt: new Date().toISOString() })); })
        .catch(() => { setDrive(d => ({ ...d, status: "expired", error: "Drive session expired — reconnect to keep syncing." })); showToast("Drive sync paused — reconnect to keep going"); });
    }, 2000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, blockedEvents, lockedBlocks, workRanges, privateRanges, completionLog, completedOccurrences, drive.status, drive.fileId]);

  // remember this connection across a page refresh, so reloading resumes
  // instead of forcing a full reconnect
  useEffect(() => {
    if (drive.status === "connected" && drive.fileId && driveTokenRef.current && driveTokenExpiryRef.current) {
      saveDriveSession(driveTokenRef.current, driveTokenExpiryRef.current, drive.fileId);
    }
  }, [drive.status, drive.fileId]);

  // on first load, silently resume a still-valid session from before a
  // refresh — no reconnect click, no reconciliation, just pick up where
  // things left off (the immediate poll right below catches up on anything
  // that changed elsewhere during the reload gap)
  useEffect(() => {
    if (!ready) return;
    const session = loadDriveSession();
    if (session) {
      driveTokenRef.current = session.token;
      driveTokenExpiryRef.current = session.expiresAt;
      lastKnownDriveUpdatedAtRef.current = null; // force the next poll to reconcile, rather than assume it's already in sync
      setDrive({ status: "connected", fileId: session.fileId, lastSyncedAt: null, error: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // poll Drive every 15s for changes made from another device, so two open
  // devices actually catch up to each other without needing a manual
  // disconnect/reconnect. Skips applying anything that turns out to just be
  // an echo of this device's own last push. Also runs once immediately when
  // a connection starts/resumes, so you're not waiting up to 15s to catch up.
  useEffect(() => {
    if (drive.status !== "connected" || !drive.fileId) return;
    let cancelled = false;
    const poll = async (isInitial) => {
      if (!driveTokenRef.current) return;
      try {
        const data = await driveReadFile(driveTokenRef.current, drive.fileId);
        if (cancelled) return;
        if (data && data.updatedAt && data.updatedAt !== lastKnownDriveUpdatedAtRef.current) {
          applyDriveData(data);
          lastKnownDriveUpdatedAtRef.current = data.updatedAt;
          setDrive(d => ({ ...d, lastSyncedAt: new Date().toISOString() }));
          if (!isInitial) showToast("Updated from another device");
        }
      } catch (e) {
        if (!cancelled) setDrive(d => (d.status === "connected" ? { ...d, status: "expired", error: "Drive session expired — reconnect to keep syncing." } : d));
      }
    };
    poll(true);
    const id = setInterval(() => poll(false), 15000);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drive.status, drive.fileId]);

  const weekStart = addDays(startOfDay(now), weekStartOffset);
  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const weekStats = useMemo(() => {
    const stats = { work: 0, private: 0 };
    const rangeStart = weekStart, rangeEnd = addDays(weekStart, 7);
    for (const b of allBlocks) {
      if (b.start >= rangeStart && b.start < rangeEnd) stats[b.category] += (b.end - b.start) / MIN_MS;
    }
    return stats;
  }, [allBlocks, weekStart]);

  const filteredTasks = useMemo(() => {
    return tasks.filter(t => {
      if (!showCompleted && t.completed) return false;
      if (showCompleted && !t.completed) return false;
      if (categoryFilter !== "all" && t.category !== categoryFilter) return false;
      if (search && !t.name.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    }).sort((a, b) => {
      const pw = PRIORITY_META[b.priority].weight - PRIORITY_META[a.priority].weight;
      if (pw !== 0) return pw;
      const ad = a.dueDate ? new Date(a.dueDate) : null, bd = b.dueDate ? new Date(b.dueDate) : null;
      if (ad && bd) return ad - bd;
      if (ad) return -1;
      if (bd) return 1;
      return 0;
    });
  }, [tasks, categoryFilter, search, showCompleted]);

  if (!ready) {
    return <div className="loading-screen">Loading your week…</div>;
  }

  const sidebarProps = {
    tasks: filteredTasks,
    overdueIds: schedule.overdue,
    unscheduledIds: schedule.unscheduled,
    categoryFilter, setCategoryFilter,
    search, setSearch,
    showCompleted, setShowCompleted,
    onAddTask: () => { setTaskModal("new"); setMobileTasksOpen(false); },
    onEditTask: (t) => { setTaskModal(t); setMobileTasksOpen(false); },
    onDeleteTask: deleteTask,
    onToggleComplete: toggleComplete,
    completedOccurrences,
    now,
    blockedEvents,
    onAddBlocked: () => { setBlockedModal("new"); setMobileTasksOpen(false); },
    onEditBlocked: (e) => { setBlockedModal(e); setMobileTasksOpen(false); },
    onDeleteBlocked: deleteBlockedEvent,
  };

  return (
    <div className="app">
      <style>{CSS}</style>

      <Sidebar
        {...sidebarProps}
      />

      {mobileTasksOpen && (
        <div className="mobile-drawer-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setMobileTasksOpen(false); }}>
          <div className="mobile-drawer">
            <div className="mobile-drawer-head">
              <span>Tasks & blocked time</span>
              <button className="icon-btn small" onClick={() => setMobileTasksOpen(false)}><X size={16} /></button>
            </div>
            <Sidebar {...sidebarProps} />
          </div>
        </div>
      )}

      <div className="main">
        <Header
          weekDays={weekDays}
          onPrev={() => setWeekStartOffset(o => o - 7)}
          onNext={() => setWeekStartOffset(o => o + 7)}
          onToday={() => setWeekStartOffset(0)}
          stats={weekStats}
          onOpenHours={() => setHoursModalOpen(true)}
          onAddTask={() => setTaskModal("new")}
          onUndo={undo}
          canUndo={undoStack.length > 0}
          onOpenReview={() => setReviewOpen(true)}
          driveStatus={drive.status}
          onOpenDrive={() => setDriveModalOpen(true)}
          onOpenMobileTasks={() => setMobileTasksOpen(true)}
        />
        <CalendarGrid
          weekDays={weekDays}
          blocks={allBlocks}
          blockedRanges={schedule.expandedBlocked}
          overdueIds={schedule.overdue}
          onDropBlock={lockBlockAt}
          onUnlockBlock={unlockBlock}
          onToggleComplete={(taskId, occurrenceKey) => { const t = tasksById[taskId]; if (t) toggleComplete(t, occurrenceKey); }}
          onEditTask={(taskId) => { const t = tasksById[taskId]; if (t) setTaskModal(t); }}
          now={now}
        />
      </div>

      {taskModal && (
        <TaskModal
          initial={taskModal === "new" ? null : taskModal}
          onClose={() => setTaskModal(null)}
          onSave={(data) => {
            if (taskModal !== "new" && taskModal.id) updateTask(taskModal.id, data);
            else addTask(data);
            setTaskModal(null);
          }}
        />
      )}

      {hoursModalOpen && (
        <HoursModal
          workRanges={workRanges} privateRanges={privateRanges}
          onChangeWork={setWorkRanges} onChangePrivate={setPrivateRanges}
          onClose={() => setHoursModalOpen(false)}
        />
      )}

      {blockedModal && (
        <BlockedEventModal
          initial={blockedModal === "new" ? null : blockedModal}
          onClose={() => setBlockedModal(null)}
          onSave={(data) => { saveBlockedEvent(data); setBlockedModal(null); }}
        />
      )}

      {completingTask && (
        <CompleteModal
          task={completingTask.task}
          onClose={() => setCompletingTask(null)}
          onConfirm={(actualDuration) => confirmComplete(completingTask.task, completingTask.occurrenceKey, actualDuration)}
        />
      )}

      {reviewOpen && (
        <WeeklyReviewModal
          weekDays={weekDays}
          completionLog={completionLog}
          weekStats={weekStats}
          overdueIds={schedule.overdue}
          unscheduledIds={schedule.unscheduled}
          tasksById={tasksById}
          onClose={() => setReviewOpen(false)}
          now={now}
        />
      )}

      {driveModalOpen && (
        <DriveSyncModal
          drive={drive}
          onConnect={connectDrive}
          onDisconnect={disconnectDrive}
          onManualSync={manualSyncDrive}
          onClose={() => setDriveModalOpen(false)}
        />
      )}

      {driveConflict && (
        <DriveConflictModal conflict={driveConflict} localUpdatedAt={localUpdatedAt} onResolve={resolveDriveConflict} />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

/* ================================ header =================================== */

function Header({ weekDays, onPrev, onNext, onToday, stats, onOpenHours, onAddTask, onUndo, canUndo, onOpenReview, driveStatus, onOpenDrive, onOpenMobileTasks }) {
  const first = weekDays[0], last = weekDays[6];
  const label = first.getMonth() === last.getMonth()
    ? `${MONTH_LABELS[first.getMonth()]} ${first.getDate()}–${last.getDate()}`
    : `${monthDayLabel(first)} – ${monthDayLabel(last)}`;
  return (
    <div className="header">
      <div className="header-left">
        <button className="mobile-tasks-btn" onClick={onOpenMobileTasks} title="Tasks & blocked time">
          <CalendarDays size={16} />
        </button>
        <div className="brand"><span className="brand-dot" />Slate</div>
        <div className="week-nav">
          <button className="icon-btn" onClick={onPrev}><ChevronLeft size={16} /></button>
          <button className="today-btn" onClick={onToday}>Today</button>
          <button className="icon-btn" onClick={onNext}><ChevronRight size={16} /></button>
          <span className="week-label">{label}</span>
        </div>
      </div>
      <div className="header-right">
        <div className="stat-pill" style={{ "--c": CATEGORY_META.work.accent }}>
          <Briefcase size={13} /> {formatDuration(Math.round(stats.work))}
        </div>
        <div className="stat-pill" style={{ "--c": CATEGORY_META.private.accent }}>
          <Home size={13} /> {formatDuration(Math.round(stats.private))}
        </div>
        <button className="icon-btn" onClick={onUndo} disabled={!canUndo} title="Undo last move (Ctrl+Z)" style={{ opacity: canUndo ? 1 : 0.35, cursor: canUndo ? "pointer" : "default" }}>
          <Undo2 size={16} />
        </button>
        <button className="icon-btn" onClick={onOpenReview} title="Weekly review"><BarChart3 size={16} /></button>
        <button className="icon-btn" onClick={onOpenDrive} title="Google Drive sync" style={{ color: driveStatus === "connected" ? "var(--success)" : driveStatus === "error" || driveStatus === "expired" ? "var(--danger)" : undefined }}>
          {driveStatus === "connected" ? <Cloud size={16} /> : <CloudOff size={16} />}
        </button>
        <button className="icon-btn" onClick={onOpenHours} title="Work / private hours"><Settings size={16} /></button>
        <button className="primary-btn" onClick={onAddTask}><Plus size={15} /> New task</button>
      </div>
    </div>
  );
}

/* ================================ sidebar =================================== */

function Sidebar({
  tasks, overdueIds, unscheduledIds, categoryFilter, setCategoryFilter, search, setSearch,
  showCompleted, setShowCompleted, onAddTask, onEditTask, onDeleteTask, onToggleComplete,
  blockedEvents, onAddBlocked, onEditBlocked, onDeleteBlocked, completedOccurrences, now,
}) {
  return (
    <div className="sidebar">
      <div className="sidebar-search">
        <Search size={14} className="search-icon" />
        <input placeholder="Search tasks…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <div className="filter-row">
        {["all", "work", "private"].map(c => (
          <button key={c} className={`chip ${categoryFilter === c ? "chip-active" : ""}`} onClick={() => setCategoryFilter(c)}>
            {c === "all" ? "All" : CATEGORY_META[c].label}
          </button>
        ))}
        <button className={`chip ${showCompleted ? "chip-active" : ""}`} style={{ marginLeft: "auto" }} onClick={() => setShowCompleted(s => !s)}>
          {showCompleted ? "Active" : "Done"}
        </button>
      </div>

      <div className="sidebar-scroll">
        <div className="section-title">
          <span>Tasks</span>
          <button className="icon-btn small" onClick={onAddTask}><Plus size={13} /></button>
        </div>

        {tasks.length === 0 && <div className="empty-hint">Nothing here. Add a task to start blocking your week.</div>}

        {tasks.map(t => (
          <TaskRow
            key={t.id} task={t}
            isOverdue={overdueIds.includes(t.id)}
            isUnscheduled={unscheduledIds.includes(t.id)}
            completedOccurrences={completedOccurrences}
            now={now}
            onEdit={() => onEditTask(t)}
            onDelete={() => onDeleteTask(t.id)}
            onToggle={() => onToggleComplete(t, currentPeriodKeyFor(t, now))}
          />
        ))}

        <div className="section-title" style={{ marginTop: 18 }}>
          <span>Blocked time</span>
          <button className="icon-btn small" onClick={onAddBlocked}><Plus size={13} /></button>
        </div>
        {blockedEvents.length === 0 && <div className="empty-hint">No blocked hours yet.</div>}
        {blockedEvents.map(e => (
          <div className="blocked-row" key={e.id} onClick={() => onEditBlocked(e)}>
            <Ban size={13} className="blocked-icon" />
            <div className="blocked-info">
              <div className="blocked-title">{e.title}</div>
              <div className="blocked-sub">
                {e.recurringWeekly ? `Every ${DAY_LABELS[e.weekday]} · ${e.startHM}–${e.endHM}` : `${monthDayLabel(new Date(e.start))} · ${toHM(new Date(e.start))}–${toHM(new Date(e.end))}`}
              </div>
            </div>
            <button className="icon-btn small" onClick={(ev) => { ev.stopPropagation(); onDeleteBlocked(e.id); }}><Trash2 size={12} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function TaskRow({ task, isOverdue, isUnscheduled, onEdit, onDelete, onToggle, completedOccurrences, now }) {
  const cat = CATEGORY_META[task.category];
  const pri = PRIORITY_META[task.priority];
  const Icon = cat.icon;
  const isRepeating = task.repeat && task.repeat !== "none";
  const currentKey = isRepeating ? currentPeriodKeyFor(task, now) : null;
  const isDone = isRepeating ? (completedOccurrences || []).includes(currentKey) : task.completed;
  return (
    <div className={`task-row ${isDone ? "task-row-done" : ""}`}>
      <button className="check-btn" onClick={onToggle} style={{ "--pc": pri.color }}>
        {isDone && <Check size={12} />}
      </button>
      <div className="task-info" onClick={onEdit}>
        <div className="task-name">{task.name}</div>
        <div className="task-meta">
          <span className="meta-chip" style={{ color: cat.accent }}><Icon size={11} /> {cat.label}</span>
          <span className="meta-chip"><Clock size={11} /> {formatDuration(task.duration)}</span>
          {isRepeating && <span className="meta-chip"><Repeat size={11} /> {REPEAT_META[task.repeat].label}</span>}
          {isRepeating && repeatDueLabel(task) && <span className="meta-chip">{repeatDueLabel(task)}</span>}
          {isRepeating && isDone && <span className="meta-chip">Done for now{task.repeat === "daily" ? " — back tomorrow" : task.repeat === "weekly" ? " — back next week" : " — back next month"}</span>}
          {!isRepeating && task.dueDate && <span className="meta-chip">Due {monthDayLabel(new Date(task.dueDate))}</span>}
          {isOverdue && <span className="meta-chip meta-warn"><AlertTriangle size={11} /> At risk</span>}
          {isUnscheduled && <span className="meta-chip meta-danger"><AlertTriangle size={11} /> Won't fit</span>}
        </div>
      </div>
      <span className="pri-dot" style={{ background: pri.color }} title={pri.label} />
      <button className="icon-btn small ghost" onClick={onDelete}><Trash2 size={12} /></button>
    </div>
  );
}

/* ============================== calendar grid =============================== */

function CalendarGrid({ weekDays, blocks, blockedRanges, overdueIds, onDropBlock, onUnlockBlock, onToggleComplete, onEditTask, now }) {
  const gridMinutes = (GRID_END_HOUR - GRID_START_HOUR) * 60;
  const gridHeight = gridMinutes * PX_PER_MIN;
  const hourMarks = Array.from({ length: GRID_END_HOUR - GRID_START_HOUR + 1 }, (_, i) => GRID_START_HOUR + i);
  const colRefs = useRef({});
  const [dragGhost, setDragGhost] = useState(null); // {dayIdx, top, height, category}
  const draggingBlock = useRef(null);

  function minutesFromGridTop(date) {
    return (date.getHours() - GRID_START_HOUR) * 60 + date.getMinutes();
  }

  function handleDragStart(e, block) {
    draggingBlock.current = block;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", block.id);
  }

  function handleDragOver(e, dayIdx) {
    e.preventDefault();
    const col = colRefs.current[dayIdx];
    if (!col || !draggingBlock.current) return;
    const rect = col.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const durationMin = (draggingBlock.current.end - draggingBlock.current.start) / MIN_MS;
    let startMin = Math.round(y / PX_PER_MIN / 15) * 15;
    startMin = Math.max(0, Math.min(gridMinutes - durationMin, startMin));
    setDragGhost({ dayIdx, top: startMin * PX_PER_MIN, height: durationMin * PX_PER_MIN, category: draggingBlock.current.category });
  }

  function handleDrop(e, day, dayIdx) {
    e.preventDefault();
    const block = draggingBlock.current;
    if (!block) return;
    const col = colRefs.current[dayIdx];
    const rect = col.getBoundingClientRect();
    const y = e.clientY - rect.top;
    const durationMin = (block.end - block.start) / MIN_MS;
    let startMin = Math.round(y / PX_PER_MIN / 15) * 15;
    startMin = Math.max(0, Math.min(gridMinutes - durationMin, startMin));
    const newStart = addMinutes(startOfDay(day), GRID_START_HOUR * 60 + startMin);
    onDropBlock(block, newStart);
    draggingBlock.current = null;
    setDragGhost(null);
  }

  return (
    <div className="calendar-wrap">
      <div className="calendar-scroll">
        <div className="calendar-grid" style={{ gridTemplateColumns: `56px repeat(7, 1fr)` }}>
          <div className="gutter-header" />
          {weekDays.map((d, i) => (
            <div key={i} className={`day-header ${sameDay(d, now) ? "day-header-today" : ""}`}>
              <div className="day-header-name">{DAY_LABELS[d.getDay()]}</div>
              <div className="day-header-num">{d.getDate()}</div>
            </div>
          ))}

          <div className="gutter" style={{ height: gridHeight }}>
            {hourMarks.map(h => (
              <div key={h} className="hour-mark" style={{ top: (h - GRID_START_HOUR) * 60 * PX_PER_MIN }}>
                {h % 24 === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`}
              </div>
            ))}
          </div>

          {weekDays.map((day, dayIdx) => {
            const isToday = sameDay(day, now);
            const dayBlocks = blocks.filter(b => sameDay(b.start, day));
            const dayBusy = blockedRanges.filter(b => sameDay(b.start, day));
            return (
              <div
                key={dayIdx}
                className={`day-col ${isToday ? "day-col-today" : ""}`}
                style={{ height: gridHeight }}
                ref={el => (colRefs.current[dayIdx] = el)}
                onDragOver={(e) => handleDragOver(e, dayIdx)}
                onDrop={(e) => handleDrop(e, day, dayIdx)}
                onDragLeave={() => setDragGhost(g => (g && g.dayIdx === dayIdx ? null : g))}
              >
                {hourMarks.slice(0, -1).map(h => (
                  <div key={h} className="hour-line" style={{ top: (h - GRID_START_HOUR) * 60 * PX_PER_MIN }} />
                ))}

                {isToday && minutesFromGridTop(now) >= 0 && minutesFromGridTop(now) <= gridMinutes && (
                  <div className="now-line" style={{ top: minutesFromGridTop(now) * PX_PER_MIN }}>
                    <span className="now-dot" />
                  </div>
                )}

                {dayBusy.map((b, i) => {
                  const top = minutesFromGridTop(b.start) * PX_PER_MIN;
                  // never inflate past the real duration — a min-height here would
                  // make short blocks visually bleed into whatever comes right after
                  // them, since top is based on real (uninflated) start time.
                  const height = Math.max(4, ((b.end - b.start) / MIN_MS) * PX_PER_MIN - 2);
                  return (
                    <div key={i} className="busy-block" style={{ top, height }}>
                      <Ban size={11} /> {b.title || "Blocked"}
                    </div>
                  );
                })}

                {dayBlocks.map(b => {
                  const top = minutesFromGridTop(b.start) * PX_PER_MIN;
                  const rawHeight = ((b.end - b.start) / MIN_MS) * PX_PER_MIN;
                  // -2px leaves a small visual gap between back-to-back blocks
                  // instead of them touching edge-to-edge; the floor is a tiny
                  // sliver only, never large enough to overlap a neighbor.
                  const height = Math.max(4, rawHeight - 2);
                  // below this, there isn't room for two lines of text (title +
                  // time range) — collapse to a single compact line instead of
                  // clipping content or (worse) forcing the box taller than its
                  // real time slot, which is what used to cause short back-to-back
                  // tasks to visually overlap the next block.
                  const compact = rawHeight < 34;
                  const cat = CATEGORY_META[b.category];
                  const risky = overdueIds.includes(b.taskId);
                  return (
                    <div
                      key={b.id}
                      className={`task-block ${b.locked ? "task-block-locked" : ""} ${compact ? "task-block-compact" : ""}`}
                      draggable
                      title={`${b.name} · ${fmt12(b.start)}–${fmt12(b.end)}`}
                      onDragStart={(e) => handleDragStart(e, b)}
                      onDragEnd={() => setDragGhost(null)}
                      style={{ top, height, "--accent": cat.accent, "--tint": cat.tint }}
                      onClick={() => onEditTask(b.taskId)}
                    >
                      <div className="task-block-head">
                        <GripVertical size={11} className="grip" />
                        <span className="task-block-title">{b.name}</span>
                        {compact && <span className="task-block-time-inline">{fmt12(b.start)}</span>}
                        {compact && risky && <AlertTriangle size={11} className="risk-flag" />}
                      </div>
                      {!compact && (
                        <div className="task-block-sub">
                          {fmt12(b.start)}–{fmt12(b.end)}
                          {b.segTotal > 1 && <span className="seg-tag"> · {b.segIndex}/{b.segTotal}</span>}
                          {risky && <AlertTriangle size={11} className="risk-flag" />}
                        </div>
                      )}
                      <div className="task-block-actions">
                        <button onClick={(e) => { e.stopPropagation(); onToggleComplete(b.taskId, b.occurrenceKey); }} title="Mark complete"><Check size={11} /></button>
                        {b.locked && <button onClick={(e) => { e.stopPropagation(); onUnlockBlock(b); }} title="Reset to auto-schedule"><RotateCcw size={11} /></button>}
                      </div>
                    </div>
                  );
                })}

                {dragGhost && dragGhost.dayIdx === dayIdx && (
                  <div className="drag-ghost" style={{ top: dragGhost.top, height: dragGhost.height, borderColor: CATEGORY_META[dragGhost.category].accent }} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* =============================== task modal ================================= */

function TaskModal({ initial, onClose, onSave }) {
  const today = new Date();
  const [name, setName] = useState(initial?.name || "");
  const [category, setCategory] = useState(initial?.category || "work");
  const [priority, setPriority] = useState(initial?.priority || "medium");
  const [duration, setDuration] = useState(initial?.duration || 60);
  const [hasDue, setHasDue] = useState(!!initial?.dueDate);
  const [dueDate, setDueDate] = useState(initial?.dueDate ? new Date(initial.dueDate).toISOString().slice(0, 10) : "");
  const [repeat, setRepeat] = useState(initial?.repeat || "none");

  // repeat-segment due day — only meaningful for weekly/monthly repeats.
  const [hasRepeatDue, setHasRepeatDue] = useState(initial?.repeatDueRule != null);
  const [repeatDueWeekday, setRepeatDueWeekday] = useState(
    initial?.repeat === "weekly" && initial?.repeatDueRule != null ? initial.repeatDueRule : today.getDay()
  );
  const [repeatDueLastDay, setRepeatDueLastDay] = useState(initial?.repeat === "monthly" && initial?.repeatDueRule === -1);
  const [repeatDueDay, setRepeatDueDay] = useState(
    initial?.repeat === "monthly" && initial?.repeatDueRule != null && initial.repeatDueRule !== -1
      ? initial.repeatDueRule
      : today.getDate()
  );

  function submit() {
    if (!name.trim()) return;
    let repeatDueRule = null;
    if (repeat === "weekly" && hasRepeatDue) repeatDueRule = repeatDueWeekday;
    if (repeat === "monthly" && hasRepeatDue) repeatDueRule = repeatDueLastDay ? -1 : (Number(repeatDueDay) || 1);
    onSave({
      name: name.trim(), category, priority, duration: Number(duration) || 15,
      dueDate: hasDue && dueDate ? new Date(dueDate + "T23:59:00").toISOString() : null,
      repeat, repeatDueRule,
    });
  }

  return (
    <ModalShell title={initial ? "Edit task" : "New task"} onClose={onClose}>
      <label className="field-label">Task name</label>
      <input className="text-input" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Draft grant figures" />

      <label className="field-label">Category</label>
      <div className="segmented">
        {Object.entries(CATEGORY_META).map(([k, v]) => (
          <button key={k} className={`segment ${category === k ? "segment-active" : ""}`} style={{ "--c": v.accent }} onClick={() => setCategory(k)}>
            <v.icon size={13} /> {v.label}
          </button>
        ))}
      </div>

      <label className="field-label">Priority</label>
      <div className="segmented">
        {Object.entries(PRIORITY_META).map(([k, v]) => (
          <button key={k} className={`segment ${priority === k ? "segment-active" : ""}`} style={{ "--c": v.color }} onClick={() => setPriority(k)}>
            {v.label}
          </button>
        ))}
      </div>

      <label className="field-label">Estimated time</label>
      <div className="row-inline">
        <input className="text-input small" type="number" min={15} step={15} value={duration} onChange={e => setDuration(e.target.value)} />
        <span className="unit-label">minutes</span>
      </div>

      <label className="field-label">Repeats</label>
      <select className="text-input" value={repeat} onChange={e => setRepeat(e.target.value)}>
        {Object.entries(REPEAT_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </select>

      {(repeat === "weekly" || repeat === "monthly") && (
        <>
          <label className="field-label row-inline" style={{ justifyContent: "space-between" }}>
            <span>Due on a specific {repeat === "weekly" ? "day of the week" : "day of the month"}</span>
            <input type="checkbox" checked={hasRepeatDue} onChange={e => setHasRepeatDue(e.target.checked)} />
          </label>
          {hasRepeatDue && repeat === "weekly" && (
            <select className="text-input" value={repeatDueWeekday} onChange={e => setRepeatDueWeekday(Number(e.target.value))}>
              {DAY_LABELS.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          )}
          {hasRepeatDue && repeat === "monthly" && (
            <div className="row-inline">
              <input
                className="text-input small" type="number" min={1} max={31}
                disabled={repeatDueLastDay} value={repeatDueDay}
                onChange={e => setRepeatDueDay(e.target.value)}
              />
              <label className="row-inline" style={{ gap: 6 }}>
                <input type="checkbox" checked={repeatDueLastDay} onChange={e => setRepeatDueLastDay(e.target.checked)} />
                <span className="unit-label">Last day of month</span>
              </label>
            </div>
          )}
        </>
      )}
      {repeat !== "none" && (
        <div className="hint-text">
          {!hasRepeatDue && `Flexible — Slate fits it in anywhere in the ${repeat === "daily" ? "day" : repeat === "weekly" ? "week" : "month"}, wherever there's room.`}
          {hasRepeatDue && repeat === "weekly" && `Slate fits it in sometime that week, but flags it if it slips past ${DAY_LABELS[repeatDueWeekday]}.`}
          {hasRepeatDue && repeat === "monthly" && `Slate fits it in sometime that month, but flags it if it slips past the ${repeatDueLastDay ? "last day" : ordinal(Number(repeatDueDay) || 1)}.`}
        </div>
      )}

      {repeat === "none" && (
        <>
          <label className="field-label row-inline" style={{ justifyContent: "space-between" }}>
            <span>Due date</span>
            <input type="checkbox" checked={hasDue} onChange={e => setHasDue(e.target.checked)} />
          </label>
          {hasDue && <input className="text-input" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />}
        </>
      )}

      <div className="modal-actions">
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" onClick={submit}>{initial ? "Save changes" : "Add task"}</button>
      </div>
    </ModalShell>
  );
}

/* =============================== hours modal ================================= */

function HoursModal({ workRanges, privateRanges, onChangeWork, onChangePrivate, onClose }) {
  function updateRange(setFn, ranges, day, idx, field, value) {
    const next = { ...ranges, [day]: ranges[day].map((r, i) => (i === idx ? { ...r, [field]: value } : r)) };
    setFn(next);
  }
  function addRange(setFn, ranges, day) {
    setFn({ ...ranges, [day]: [...(ranges[day] || []), { start: "09:00", end: "17:00" }] });
  }
  function removeRange(setFn, ranges, day, idx) {
    setFn({ ...ranges, [day]: ranges[day].filter((_, i) => i !== idx) });
  }

  return (
    <ModalShell title="Work & private hours" onClose={onClose} wide>
      <div className="hint-text" style={{ marginBottom: 12 }}>
        Set the hours where each type of task is allowed to be scheduled. Slate will only place work tasks inside work hours, and private tasks inside private hours.
      </div>
      <div className="hours-grid">
        <div className="hours-col">
          <div className="hours-col-title" style={{ color: CATEGORY_META.work.accent }}><Briefcase size={14} /> Work hours</div>
          {DAY_LABELS.map((label, day) => (
            <div className="hours-day-row" key={day}>
              <div className="hours-day-label">{label}</div>
              <div className="hours-ranges">
                {(workRanges[day] || []).map((r, idx) => (
                  <div className="hours-range" key={idx}>
                    <input type="time" value={r.start} onChange={e => updateRange(onChangeWork, workRanges, day, idx, "start", e.target.value)} />
                    <span>–</span>
                    <input type="time" value={r.end} onChange={e => updateRange(onChangeWork, workRanges, day, idx, "end", e.target.value)} />
                    <button className="icon-btn small" onClick={() => removeRange(onChangeWork, workRanges, day, idx)}><X size={11} /></button>
                  </div>
                ))}
                <button className="icon-btn small" onClick={() => addRange(onChangeWork, workRanges, day)}><Plus size={11} /></button>
              </div>
            </div>
          ))}
        </div>
        <div className="hours-col">
          <div className="hours-col-title" style={{ color: CATEGORY_META.private.accent }}><Home size={14} /> Private hours</div>
          {DAY_LABELS.map((label, day) => (
            <div className="hours-day-row" key={day}>
              <div className="hours-day-label">{label}</div>
              <div className="hours-ranges">
                {(privateRanges[day] || []).map((r, idx) => (
                  <div className="hours-range" key={idx}>
                    <input type="time" value={r.start} onChange={e => updateRange(onChangePrivate, privateRanges, day, idx, "start", e.target.value)} />
                    <span>–</span>
                    <input type="time" value={r.end} onChange={e => updateRange(onChangePrivate, privateRanges, day, idx, "end", e.target.value)} />
                    <button className="icon-btn small" onClick={() => removeRange(onChangePrivate, privateRanges, day, idx)}><X size={11} /></button>
                  </div>
                ))}
                <button className="icon-btn small" onClick={() => addRange(onChangePrivate, privateRanges, day)}><Plus size={11} /></button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="modal-actions">
        <button className="primary-btn" onClick={onClose}>Done</button>
      </div>
    </ModalShell>
  );
}

/* ============================ blocked event modal ============================= */

function BlockedEventModal({ initial, onClose, onSave }) {
  const [title, setTitle] = useState(initial?.title || "");
  const [recurringWeekly, setRecurringWeekly] = useState(initial?.recurringWeekly ?? true);
  const [weekday, setWeekday] = useState(initial?.weekday ?? 1);
  const [startHM, setStartHM] = useState(initial?.startHM || "09:00");
  const [endHM, setEndHM] = useState(initial?.endHM || "10:00");
  const [date, setDate] = useState(initial?.start ? new Date(initial.start).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));

  function submit() {
    if (!title.trim()) return;
    if (recurringWeekly) {
      onSave({ id: initial?.id, title: title.trim(), recurringWeekly: true, weekday: Number(weekday), startHM, endHM });
    } else {
      onSave({ id: initial?.id, title: title.trim(), recurringWeekly: false, start: new Date(`${date}T${startHM}`).toISOString(), end: new Date(`${date}T${endHM}`).toISOString() });
    }
  }

  return (
    <ModalShell title={initial ? "Edit blocked time" : "Block out time"} onClose={onClose}>
      <label className="field-label">Title</label>
      <input className="text-input" autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Lab meeting" />

      <label className="field-label row-inline" style={{ justifyContent: "space-between" }}>
        <span>Repeats weekly</span>
        <input type="checkbox" checked={recurringWeekly} onChange={e => setRecurringWeekly(e.target.checked)} />
      </label>

      {recurringWeekly ? (
        <>
          <label className="field-label">Day</label>
          <select className="text-input" value={weekday} onChange={e => setWeekday(e.target.value)}>
            {DAY_LABELS.map((d, i) => <option key={i} value={i}>{d}</option>)}
          </select>
        </>
      ) : (
        <>
          <label className="field-label">Date</label>
          <input className="text-input" type="date" value={date} onChange={e => setDate(e.target.value)} />
        </>
      )}

      <label className="field-label">Time range</label>
      <div className="row-inline">
        <input className="text-input" type="time" value={startHM} onChange={e => setStartHM(e.target.value)} />
        <span className="unit-label">to</span>
        <input className="text-input" type="time" value={endHM} onChange={e => setEndHM(e.target.value)} />
      </div>

      <div className="modal-actions">
        <button className="secondary-btn" onClick={onClose}>Cancel</button>
        <button className="primary-btn" onClick={submit}>{initial ? "Save changes" : "Add block"}</button>
      </div>
    </ModalShell>
  );
}

/* ================================ complete modal ============================== */

function CompleteModal({ task, onClose, onConfirm }) {
  const [actual, setActual] = useState(task.duration);
  return (
    <ModalShell title="Mark complete" onClose={onClose}>
      <div className="complete-task-name">{task.name}</div>
      <div className="hint-text" style={{ marginBottom: 4 }}>Estimated {formatDuration(task.duration)}. How long did it actually take? This helps your weekly review stay accurate.</div>
      <label className="field-label">Actual time</label>
      <div className="row-inline">
        <input className="text-input small" type="number" min={5} step={5} value={actual} onChange={e => setActual(e.target.value)} />
        <span className="unit-label">minutes</span>
      </div>
      <div className="modal-actions" style={{ justifyContent: "space-between" }}>
        <button className="secondary-btn" onClick={() => onConfirm(task.duration)}>Same as planned</button>
        <button className="primary-btn" onClick={() => onConfirm(Number(actual) || task.duration)}><Check size={14} /> Mark complete</button>
      </div>
    </ModalShell>
  );
}

/* ============================ weekly review modal ============================== */

function WeeklyReviewModal({ weekDays, completionLog, weekStats, overdueIds, unscheduledIds, tasksById, onClose, now }) {
  const data = useMemo(() => {
    const weekStart = startOfDay(weekDays[0]);
    const weekEnd = addDays(weekStart, 7);
    const entries = completionLog.filter(e => {
      const d = new Date(e.completedAt);
      return d >= weekStart && d < weekEnd;
    });

    const loggedByCategory = { work: 0, private: 0 };
    const priorityCounts = { urgent: 0, high: 0, medium: 0, low: 0 };
    const byDay = weekDays.map(() => 0);
    let loggedTotal = 0, ratioSum = 0;

    for (const e of entries) {
      loggedByCategory[e.category] += e.actualDuration;
      priorityCounts[e.priority] += 1;
      loggedTotal += e.actualDuration;
      ratioSum += e.actualDuration / Math.max(1, e.estimatedDuration);
      const idx = weekDays.findIndex(d => sameDay(d, new Date(e.completedAt)));
      if (idx >= 0) byDay[idx] += 1;
    }

    const plannedTotal = weekStats.work + weekStats.private;
    const accuracyPct = entries.length ? Math.round((ratioSum / entries.length) * 100) : null;

    const attentionIds = [...new Set([...unscheduledIds, ...overdueIds])];
    const attentionTasks = attentionIds.map(id => tasksById[id]).filter(Boolean);

    return { entries, loggedByCategory, priorityCounts, byDay, loggedTotal, plannedTotal, accuracyPct, attentionTasks };
  }, [weekDays, completionLog, weekStats, overdueIds, unscheduledIds, tasksById]);

  const maxCatMinutes = Math.max(weekStats.work, weekStats.private, data.loggedByCategory.work, data.loggedByCategory.private, 1);
  const maxDayCount = Math.max(...data.byDay, 1);

  return (
    <ModalShell title={`Weekly review · ${monthDayLabel(weekDays[0])}–${monthDayLabel(weekDays[6])}`} onClose={onClose} wide>
      <div className="review-stats-row">
        <div className="review-stat-card">
          <div className="review-stat-num">{data.entries.length}</div>
          <div className="review-stat-label">Completed</div>
        </div>
        <div className="review-stat-card">
          <div className="review-stat-num">{formatDuration(Math.round(data.plannedTotal))}</div>
          <div className="review-stat-label">Planned</div>
        </div>
        <div className="review-stat-card">
          <div className="review-stat-num">{formatDuration(Math.round(data.loggedTotal))}</div>
          <div className="review-stat-label">Logged</div>
        </div>
        <div className="review-stat-card">
          <div className="review-stat-num">{data.accuracyPct === null ? "—" : `${data.accuracyPct}%`}</div>
          <div className="review-stat-label">Of estimate</div>
        </div>
      </div>

      <div className="review-section-title">Planned vs logged, by category</div>
      {["work", "private"].map(cat => (
        <div className="review-cat-row" key={cat}>
          <div className="review-cat-label" style={{ color: CATEGORY_META[cat].accent }}>{CATEGORY_META[cat].label}</div>
          <div className="review-bar-stack">
            <div className="review-bar-track">
              <div className="review-bar review-bar-planned" style={{ width: `${(weekStats[cat] / maxCatMinutes) * 100}%`, background: CATEGORY_META[cat].accent }} />
            </div>
            <div className="review-bar-track">
              <div className="review-bar review-bar-logged" style={{ width: `${(data.loggedByCategory[cat] / maxCatMinutes) * 100}%`, background: CATEGORY_META[cat].accent, opacity: 0.55 }} />
            </div>
          </div>
          <div className="review-cat-nums">{formatDuration(Math.round(weekStats[cat]))} planned · {formatDuration(Math.round(data.loggedByCategory[cat]))} logged</div>
        </div>
      ))}

      <div className="review-two-col">
        <div>
          <div className="review-section-title">Momentum this week</div>
          <div className="momentum-row">
            {weekDays.map((d, i) => (
              <div className="momentum-col" key={i}>
                <div className="momentum-bar-track">
                  <div className="momentum-bar" style={{ height: `${(data.byDay[i] / maxDayCount) * 100}%` }} />
                </div>
                <div className={`momentum-label ${sameDay(d, now) ? "momentum-today" : ""}`}>{DAY_LABELS[d.getDay()][0]}</div>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="review-section-title">Priority mix</div>
          {Object.entries(PRIORITY_META).map(([k, v]) => (
            <div className="priority-mix-row" key={k}>
              <span className="pri-dot" style={{ background: v.color }} />
              <span className="priority-mix-label">{v.label}</span>
              <span className="priority-mix-count">{data.priorityCounts[k]}</span>
            </div>
          ))}
        </div>
      </div>

      {data.attentionTasks.length > 0 && (
        <>
          <div className="review-section-title">Needs attention</div>
          <div className="attention-list">
            {data.attentionTasks.map(t => (
              <div className="attention-row" key={t.id}>
                <AlertTriangle size={13} className="risk-flag" />
                <span className="attention-name">{t.name}</span>
                <span className="meta-chip" style={{ color: CATEGORY_META[t.category].accent }}>{CATEGORY_META[t.category].label}</span>
                <span className="meta-chip meta-warn">{unscheduledIds.includes(t.id) ? "Won't fit" : "At risk"}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="review-section-title">Completed this week</div>
      {data.entries.length === 0 && <div className="empty-hint">Nothing logged yet this week — completions will show up here.</div>}
      <div className="completed-list">
        {data.entries.slice().reverse().map(e => (
          <div className="completed-row" key={e.id}>
            <CheckCircle2 size={13} style={{ color: "var(--success)", flexShrink: 0 }} />
            <span className="completed-name">{e.name}</span>
            <span className="completed-time">{formatDuration(e.actualDuration)} <span className="text-faint">/ {formatDuration(e.estimatedDuration)} est.</span></span>
          </div>
        ))}
      </div>

      <div className="modal-actions">
        <button className="primary-btn" onClick={onClose}>Done</button>
      </div>
    </ModalShell>
  );
}

/* ============================== drive sync modal ============================== */

function DriveSyncModal({ drive, onConnect, onDisconnect, onManualSync, onClose }) {
  return (
    <ModalShell title="Google Drive sync" onClose={onClose}>
      <div className="hint-text" style={{ marginBottom: 14 }}>
        Keeps one JSON file, created by this app in your own Drive, in sync with your tasks, blocks, and hours. Connect the same account on another device to share the same schedule there — nothing else in your Drive is touched. Once connected, changes made on either device show up on the other within about 15 seconds, no need to reload — and refreshing the page won't disconnect you either, it'll just pick back up.
      </div>

      {drive.status === "connected" && (
        <>
          <div className="drive-status drive-status-ok"><Cloud size={14} /> Connected · synced {drive.lastSyncedAt ? timeAgo(drive.lastSyncedAt) : "just now"}</div>
          <div className="modal-actions" style={{ justifyContent: "space-between" }}>
            <button className="secondary-btn" onClick={onDisconnect}>Disconnect</button>
            <button className="primary-btn" onClick={onManualSync}>Sync now</button>
          </div>
        </>
      )}

      {drive.status === "expired" && (
        <>
          <div className="drive-status drive-status-warn"><AlertTriangle size={14} /> {drive.error || "Drive session expired."}</div>
          <div className="modal-actions"><button className="primary-btn" onClick={onConnect}>Reconnect</button></div>
        </>
      )}

      {(drive.status === "disconnected" || drive.status === "connecting") && (
        <div className="modal-actions">
          <button className="primary-btn" onClick={onConnect} disabled={drive.status === "connecting"}>
            <Cloud size={14} /> {drive.status === "connecting" ? "Connecting…" : "Connect Google Drive"}
          </button>
        </div>
      )}

      {drive.status === "error" && (
        <>
          <div className="drive-status drive-status-warn"><AlertTriangle size={14} /> {drive.error}</div>
          <div className="modal-actions"><button className="primary-btn" onClick={onConnect}>Try again</button></div>
        </>
      )}

      <div className="hint-text" style={{ marginTop: 18 }}>
        <strong style={{ color: "var(--text-dim)" }}>First-time setup</strong> (one-time, in Google Cloud Console — free):
      </div>
      <ol className="setup-steps">
        <li>Create a project at console.cloud.google.com, then enable the "Google Drive API".</li>
        <li>Under OAuth consent screen, add your own Google account as a test user (keeps it in "Testing" mode, no app review needed).</li>
        <li>Under Credentials, create an OAuth Client ID → type "Web application" → add this app's deployed URL as an authorized JavaScript origin.</li>
        <li>Add that Client ID as the <code>VITE_GOOGLE_CLIENT_ID</code> secret in your GitHub repo, then redeploy — see the README for exact steps.</li>
      </ol>
      <div className="hint-text">This only works once the app is running at a real, fixed URL — Google won't grant access to a sandboxed preview link.</div>
      <div className="build-tag">Build {BUILD_TAG}</div>
    </ModalShell>
  );
}

function DriveConflictModal({ conflict, localUpdatedAt, onResolve }) {
  const driveCount = conflict.driveData?.tasks?.length ?? 0;
  const localCount = conflict.localPayload?.tasks?.length ?? 0;
  const driveWhen = conflict.driveData?.updatedAt ? timeAgo(conflict.driveData.updatedAt) : "unknown";
  const localWhen = localUpdatedAt ? timeAgo(localUpdatedAt) : "just now";
  return (
    <ModalShell title="Two schedules found" onClose={() => onResolve("cancel")}>
      <div className="hint-text" style={{ marginBottom: 16 }}>
        Drive already has a saved schedule that's different from what's on this device. Nothing changes until you pick one — closing this without choosing just cancels the connection, nothing is touched.
      </div>
      <div className="conflict-compare">
        <div className="conflict-side">
          <div className="conflict-side-title">This device</div>
          <div className="conflict-side-meta">{localCount} tasks · edited {localWhen}</div>
        </div>
        <div className="conflict-side">
          <div className="conflict-side-title">Google Drive</div>
          <div className="conflict-side-meta">{driveCount} tasks · edited {driveWhen}</div>
        </div>
      </div>
      <div className="modal-actions" style={{ justifyContent: "space-between" }}>
        <button className="secondary-btn" onClick={() => onResolve("local")}>Erase Drive, use this device</button>
        <button className="primary-btn" onClick={() => onResolve("drive")}>Erase this device, use Drive</button>
      </div>
    </ModalShell>
  );
}

/* ================================ modal shell ================================ */

function ModalShell({ title, children, onClose, wide }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`modal ${wide ? "modal-wide" : ""}`} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>{title}</span>
          <button className="icon-btn small" onClick={onClose}><X size={14} /></button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/* ==================================== css ==================================== */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');

:root{
  --bg:#0A0C11; --bg-elevated:#10131A; --surface:#161A23; --surface-hover:#1D222D;
  --border:#242A36; --border-soft:rgba(255,255,255,0.05); --text:#E8EAEF; --text-dim:#8A90A0; --text-faint:#565C6B;
  --danger:#FF5C6C; --success:#4ADE80;
  --radius:12px;
}
*{box-sizing:border-box;}
html, body{height:100%; margin:0; padding:0; overflow:hidden; overscroll-behavior:none; background:#0A0C11;}
#root{height:100%;}
.app, .app *{font-family:'Inter',system-ui,sans-serif;}
.app{
  display:flex; width:100%; height:100vh; height:100dvh; background:var(--bg); color:var(--text);
  overflow:hidden;
}
.loading-screen{
  width:100%; height:100vh; height:100dvh; display:flex; align-items:center; justify-content:center;
  background:var(--bg); color:var(--text-dim); font-family:'Inter',sans-serif; font-size:14px;
}

/* ---------- sidebar ---------- */
.sidebar{
  width:300px; min-width:300px; background:var(--bg-elevated); border-right:1px solid var(--border);
  display:flex; flex-direction:column; padding:16px 14px;
}
.sidebar-search{
  display:flex; align-items:center; gap:8px; background:var(--surface); border:1px solid var(--border);
  border-radius:10px; padding:8px 10px; margin-bottom:12px;
}
.sidebar-search input{
  background:transparent; border:none; outline:none; color:var(--text); font-size:13px; width:100%;
}
.search-icon{color:var(--text-faint); flex-shrink:0;}
.filter-row{display:flex; gap:6px; margin-bottom:14px;}
.chip{
  background:var(--surface); border:1px solid var(--border); color:var(--text-dim); font-size:12px;
  padding:5px 10px; border-radius:999px; cursor:pointer; transition:all .15s;
}
.chip:hover{color:var(--text); border-color:#333a48;}
.chip-active{background:#232838; color:var(--text); border-color:#3a4256;}
.sidebar-scroll{flex:1; overflow-y:auto; padding-right:2px;}
.section-title{
  display:flex; align-items:center; justify-content:space-between; color:var(--text-faint);
  font-size:11px; text-transform:uppercase; letter-spacing:0.06em; font-weight:600; margin:6px 2px 8px;
}
.empty-hint{color:var(--text-faint); font-size:12.5px; padding:10px 4px; line-height:1.5;}

.task-row{
  display:flex; align-items:flex-start; gap:9px; padding:9px 6px; border-radius:10px; cursor:default;
  transition:background .15s;
}
.task-row:hover{background:var(--surface);}
.task-row-done .task-name{color:var(--text-faint); text-decoration:line-through;}
.check-btn{
  width:18px; height:18px; border-radius:6px; border:1.5px solid var(--pc, #555); background:transparent;
  color:var(--pc,#555); display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:2px;
  cursor:pointer; transition:all .15s;
}
.task-row-done .check-btn{background:var(--pc); color:#0A0C11;}
.task-info{flex:1; min-width:0; cursor:pointer;}
.task-name{font-size:13px; font-weight:500; margin-bottom:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.task-meta{display:flex; flex-wrap:wrap; gap:6px;}
.meta-chip{
  display:flex; align-items:center; gap:3px; font-size:10.5px; color:var(--text-dim); background:var(--bg);
  padding:2px 6px; border-radius:6px; border:1px solid var(--border);
}
.meta-warn{color:#FFB86B; border-color:#4a3a20;}
.meta-danger{color:var(--danger); border-color:#4a2228;}
.pri-dot{width:6px; height:6px; border-radius:50%; margin-top:6px; flex-shrink:0;}
.icon-btn{
  background:transparent; border:none; color:var(--text-dim); cursor:pointer; padding:6px; border-radius:8px;
  display:flex; align-items:center; justify-content:center; transition:all .15s;
}
.icon-btn:hover{background:var(--surface-hover); color:var(--text);}
.icon-btn.small{padding:4px;}
.icon-btn.ghost{opacity:0; }
.task-row:hover .icon-btn.ghost{opacity:1;}
.mobile-tasks-btn{
  background:var(--surface); border:1px solid var(--border); color:var(--text-dim); cursor:pointer;
  padding:7px; border-radius:9px; align-items:center; justify-content:center; flex-shrink:0;
}
.mobile-tasks-btn:active{background:var(--surface-hover);}

.blocked-row{
  display:flex; align-items:center; gap:8px; padding:8px 6px; border-radius:10px; cursor:pointer; transition:background .15s;
}
.blocked-row:hover{background:var(--surface);}
.blocked-icon{color:var(--text-faint); flex-shrink:0;}
.blocked-info{flex:1; min-width:0;}
.blocked-title{font-size:12.5px; font-weight:500;}
.blocked-sub{font-size:11px; color:var(--text-faint); margin-top:2px;}

/* ---------- main / header ---------- */
.main{flex:1; display:flex; flex-direction:column; min-width:0; min-height:0;}
.header{
  display:flex; align-items:center; justify-content:space-between; padding:14px 20px;
  border-bottom:1px solid var(--border); background:var(--bg-elevated);
}
.header-left{display:flex; align-items:center; gap:22px;}
.brand{font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:17px; display:flex; align-items:center; gap:8px;}
.brand-dot{width:9px; height:9px; border-radius:50%; background:linear-gradient(135deg,#5B8DEF,#C77DFF); box-shadow:0 0 10px rgba(120,140,240,0.6);}
.week-nav{display:flex; align-items:center; gap:4px;}
.today-btn{
  background:var(--surface); border:1px solid var(--border); color:var(--text); font-size:12px; font-weight:500;
  padding:6px 12px; border-radius:8px; cursor:pointer;
}
.today-btn:hover{background:var(--surface-hover);}
.week-label{font-size:13px; color:var(--text-dim); margin-left:8px; font-variant-numeric:tabular-nums;}
.header-right{display:flex; align-items:center; gap:10px;}
.stat-pill{
  display:flex; align-items:center; gap:5px; font-size:12px; color:var(--c); background:color-mix(in srgb, var(--c) 14%, transparent);
  border:1px solid color-mix(in srgb, var(--c) 30%, transparent); padding:5px 10px; border-radius:999px; font-variant-numeric:tabular-nums;
}
.primary-btn{
  display:flex; align-items:center; gap:6px; background:linear-gradient(135deg,#5B8DEF,#7B6EF6); color:#fff; border:none;
  font-size:13px; font-weight:600; padding:8px 14px; border-radius:9px; cursor:pointer; transition:filter .15s;
}
.primary-btn:hover{filter:brightness(1.1);}
.secondary-btn{
  background:var(--surface); border:1px solid var(--border); color:var(--text); font-size:13px; font-weight:500;
  padding:8px 14px; border-radius:9px; cursor:pointer;
}
.secondary-btn:hover{background:var(--surface-hover);}

/* ---------- calendar ---------- */
.calendar-wrap{flex:1; overflow:hidden; background:var(--bg); min-height:0;}
.calendar-scroll{height:100%; overflow-y:auto; overflow-x:auto; -webkit-overflow-scrolling:touch; overscroll-behavior:contain;}
.calendar-grid{display:grid; min-width:820px;}
.gutter-header{position:sticky; top:0; z-index:5; background:var(--bg);}
.day-header{
  position:sticky; top:0; z-index:5; background:var(--bg); text-align:center; padding:10px 4px 12px;
  border-bottom:1px solid var(--border); border-left:1px solid var(--border-soft);
}
.day-header-today .day-header-num{
  background:linear-gradient(135deg,#5B8DEF,#7B6EF6); color:#fff; box-shadow:0 0 12px rgba(91,141,239,0.5);
}
.day-header-name{font-size:11px; color:var(--text-faint); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:5px;}
.day-header-num{
  font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:14px; width:26px; height:26px; border-radius:50%;
  display:flex; align-items:center; justify-content:center; margin:0 auto; color:var(--text);
}
.gutter{position:relative; border-right:1px solid var(--border-soft);}
.hour-mark{position:absolute; right:8px; transform:translateY(-50%); font-size:10.5px; color:var(--text-faint); font-variant-numeric:tabular-nums;}
.day-col{position:relative; border-left:1px solid var(--border-soft);}
.day-col-today{background:rgba(91,141,239,0.035);}
.hour-line{position:absolute; left:0; right:0; height:1px; background:var(--border-soft);}
.now-line{position:absolute; left:0; right:0; height:2px; background:var(--danger); z-index:3;}
.now-dot{position:absolute; left:-4px; top:-3px; width:8px; height:8px; border-radius:50%; background:var(--danger); box-shadow:0 0 8px rgba(255,92,108,0.8);}

.busy-block{
  position:absolute; left:3px; right:3px; background:repeating-linear-gradient(135deg, #262b36, #262b36 6px, #1c202a 6px, #1c202a 12px);
  border:1px dashed #3a4150; border-radius:8px; font-size:10.5px; color:var(--text-faint); padding:4px 7px;
  display:flex; align-items:center; gap:4px; z-index:1;
}

.task-block{
  position:absolute; left:3px; right:3px; background:var(--tint); border:1px solid color-mix(in srgb, var(--accent) 55%, transparent);
  border-left:3px solid var(--accent); border-radius:9px; padding:5px 7px; overflow:hidden; cursor:grab; z-index:2;
  transition:box-shadow .15s; box-shadow:0 1px 3px rgba(0,0,0,0.3);
}
.task-block:hover{box-shadow:0 2px 10px rgba(0,0,0,0.45); z-index:4;}
.task-block:active{cursor:grabbing;}
.task-block-locked{border-style:solid; box-shadow:0 0 0 1px color-mix(in srgb, var(--accent) 70%, transparent);}
.task-block-compact{padding:2px 6px; display:flex; align-items:center;}
.task-block-compact .task-block-head{flex:1; min-width:0;}
.task-block-time-inline{font-size:9.5px; color:var(--text-dim); flex-shrink:0; font-variant-numeric:tabular-nums; margin-left:auto; padding-left:4px;}
.task-block-head{display:flex; align-items:center; gap:4px;}
.grip{color:var(--text-faint); flex-shrink:0;}
.task-block-title{font-size:11.5px; font-weight:600; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.task-block-sub{font-size:10px; color:var(--text-dim); margin-top:2px; display:flex; align-items:center; gap:4px; font-variant-numeric:tabular-nums;}
.seg-tag{color:var(--text-faint);}
.risk-flag{color:#FFB86B;}
.task-block-actions{
  position:absolute; top:4px; right:4px; display:flex; gap:2px; opacity:0; transition:opacity .15s;
}
.task-block:hover .task-block-actions{opacity:1;}
.task-block-actions button{
  background:rgba(10,12,17,0.75); border:none; color:var(--text); border-radius:5px; width:18px; height:18px;
  display:flex; align-items:center; justify-content:center; cursor:pointer;
}
.task-block-actions button:hover{background:rgba(10,12,17,0.95);}
.drag-ghost{position:absolute; left:3px; right:3px; border:2px dashed; border-radius:9px; background:rgba(255,255,255,0.04); z-index:5; pointer-events:none;}

/* ---------- toast ---------- */
.toast{
  position:fixed; bottom:22px; left:50%; transform:translateX(-50%); background:var(--surface); border:1px solid var(--border);
  color:var(--text); padding:10px 16px; border-radius:10px; font-size:13px; box-shadow:0 8px 24px rgba(0,0,0,0.5); z-index:50;
  animation:toast-in .2s ease-out;
}
@keyframes toast-in{from{opacity:0; transform:translate(-50%,8px);} to{opacity:1; transform:translate(-50%,0);}}

/* ---------- modals ---------- */
.modal-overlay{
  position:fixed; inset:0; background:rgba(5,6,9,0.6); backdrop-filter:blur(3px); display:flex; align-items:center;
  justify-content:center; z-index:100;
}
.modal{
  width:380px; max-width:92vw; max-height:85vh; overflow-y:auto; background:var(--bg-elevated); border:1px solid var(--border);
  border-radius:14px; box-shadow:0 20px 60px rgba(0,0,0,0.5);
}
.modal-wide{width:640px;}
.modal-header{
  display:flex; align-items:center; justify-content:space-between; padding:16px 18px; border-bottom:1px solid var(--border);
  font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:15px;
}
.modal-body{padding:16px 18px;}
.field-label{display:block; font-size:11.5px; color:var(--text-dim); margin:14px 0 6px; text-transform:uppercase; letter-spacing:0.04em;}
.field-label:first-child{margin-top:0;}
.text-input{
  width:100%; background:var(--surface); border:1px solid var(--border); color:var(--text); font-size:13.5px;
  padding:9px 11px; border-radius:9px; outline:none;
}
.text-input:focus{border-color:#4a5aa8;}
.text-input.small{width:90px;}
.row-inline{display:flex; align-items:center; gap:8px;}
.unit-label{font-size:12.5px; color:var(--text-dim);}
.hint-text{font-size:11.5px; color:var(--text-faint); margin-top:6px; line-height:1.5;}
.segmented{display:flex; gap:6px; flex-wrap:wrap;}
.segment{
  display:flex; align-items:center; gap:5px; background:var(--surface); border:1px solid var(--border); color:var(--text-dim);
  font-size:12px; padding:6px 11px; border-radius:8px; cursor:pointer;
}
.segment-active{color:var(--text); border-color:var(--c); background:color-mix(in srgb, var(--c) 16%, transparent);}
.modal-actions{display:flex; justify-content:flex-end; gap:8px; margin-top:20px;}

.hours-grid{display:grid; grid-template-columns:1fr 1fr; gap:22px;}
.hours-col-title{display:flex; align-items:center; gap:6px; font-weight:600; font-size:13px; margin-bottom:10px;}
.hours-day-row{display:flex; align-items:flex-start; gap:8px; padding:5px 0; border-bottom:1px solid var(--border);}
.hours-day-label{width:36px; font-size:11.5px; color:var(--text-dim); padding-top:6px; flex-shrink:0;}
.hours-ranges{display:flex; flex-direction:column; gap:5px; flex:1;}
.hours-range{display:flex; align-items:center; gap:4px;}
.hours-range input{background:var(--surface); border:1px solid var(--border); color:var(--text); font-size:11px; padding:4px 5px; border-radius:6px; width:76px;}

/* ---------- complete modal ---------- */
.complete-task-name{font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:14.5px; margin-bottom:4px;}

/* ---------- weekly review ---------- */
.review-stats-row{display:grid; grid-template-columns:repeat(4,1fr); gap:10px; margin-bottom:20px;}
.review-stat-card{background:var(--surface); border:1px solid var(--border); border-radius:11px; padding:12px 10px; text-align:center;}
.review-stat-num{font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:20px;}
.review-stat-label{font-size:10.5px; color:var(--text-faint); text-transform:uppercase; letter-spacing:0.04em; margin-top:3px;}
.review-section-title{font-size:11.5px; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.05em; font-weight:600; margin:18px 0 10px;}
.review-cat-row{margin-bottom:12px;}
.review-cat-label{font-size:12.5px; font-weight:600; margin-bottom:5px;}
.review-bar-stack{display:flex; flex-direction:column; gap:3px;}
.review-bar-track{height:8px; background:var(--bg); border-radius:5px; overflow:hidden;}
.review-bar{height:100%; border-radius:5px; transition:width .3s;}
.review-cat-nums{font-size:11px; color:var(--text-faint); margin-top:5px;}
.review-two-col{display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-top:6px;}
.momentum-row{display:flex; align-items:flex-end; gap:8px; height:80px; padding-top:6px;}
.momentum-col{flex:1; display:flex; flex-direction:column; align-items:center; height:100%; justify-content:flex-end;}
.momentum-bar-track{width:100%; flex:1; display:flex; align-items:flex-end;}
.momentum-bar{width:100%; background:linear-gradient(180deg,#7B6EF6,#5B8DEF); border-radius:4px 4px 2px 2px; min-height:2px;}
.momentum-label{font-size:10px; color:var(--text-faint); margin-top:5px;}
.momentum-today{color:var(--text); font-weight:700;}
.priority-mix-row{display:flex; align-items:center; gap:8px; padding:5px 0;}
.priority-mix-label{font-size:12.5px; color:var(--text-dim); flex:1;}
.priority-mix-count{font-size:12.5px; font-weight:600; font-variant-numeric:tabular-nums;}
.attention-list{display:flex; flex-direction:column; gap:6px;}
.attention-row{display:flex; align-items:center; gap:7px; background:var(--surface); border:1px solid var(--border); border-radius:9px; padding:7px 10px;}
.attention-name{font-size:12.5px; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.completed-list{max-height:180px; overflow-y:auto; display:flex; flex-direction:column; gap:2px;}
.completed-row{display:flex; align-items:center; gap:8px; padding:7px 4px; border-bottom:1px solid var(--border); font-size:12.5px;}
.completed-name{flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.completed-time{color:var(--text-dim); font-size:11.5px; font-variant-numeric:tabular-nums; flex-shrink:0;}
.text-faint{color:var(--text-faint);}

/* ---------- drive sync ---------- */
.drive-status{display:flex; align-items:center; gap:7px; font-size:12.5px; padding:9px 11px; border-radius:9px; background:var(--surface); border:1px solid var(--border);}
.drive-status-ok{color:var(--success); border-color:#1f4a34;}
.drive-status-warn{color:#FFB86B; border-color:#4a3a20;}
.conflict-compare{display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:16px;}
.conflict-side{background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:10px 12px;}
.conflict-side-title{font-size:11.5px; font-weight:600; color:var(--text-dim); text-transform:uppercase; letter-spacing:0.03em; margin-bottom:4px;}
.conflict-side-meta{font-size:12.5px; color:var(--text);}
.setup-steps{margin:8px 0 0; padding-left:18px; font-size:11.5px; color:var(--text-faint); line-height:1.7;}
.setup-steps code{background:var(--surface); border:1px solid var(--border); border-radius:4px; padding:1px 5px; color:var(--text-dim); font-size:11px;}
.build-tag{margin-top:14px; font-size:10.5px; color:var(--text-faint); text-align:center; font-variant-numeric:tabular-nums;}
@media (max-width: 820px){
  .review-stats-row{grid-template-columns:repeat(2,1fr);}
  .review-two-col{grid-template-columns:1fr;}
}

/* scrollbars */
.sidebar-scroll::-webkit-scrollbar, .calendar-scroll::-webkit-scrollbar, .modal::-webkit-scrollbar{width:8px; height:8px;}
.sidebar-scroll::-webkit-scrollbar-thumb, .calendar-scroll::-webkit-scrollbar-thumb, .modal::-webkit-scrollbar-thumb{background:#2a2f3b; border-radius:8px;}

.mobile-tasks-btn{display:none;}

@media (max-width: 820px){
  .app{flex-direction:column;}
  .sidebar{display:none;} /* on mobile the sidebar only appears inside the drawer below */
  .header{padding:10px 12px;}
  .header-left{gap:10px;}
  .stat-pill{display:none;}
  .mobile-tasks-btn{display:flex;}
}

/* ---------- mobile tasks drawer ---------- */
.mobile-drawer-backdrop{
  position:fixed; inset:0; background:rgba(5,6,9,0.55); z-index:60;
  display:flex; flex-direction:column; align-items:stretch;
  animation:drawer-fade-in .15s ease-out;
}
@keyframes drawer-fade-in{from{opacity:0;} to{opacity:1;}}
.mobile-drawer{
  background:var(--bg-elevated); border-bottom:1px solid var(--border);
  border-radius:0 0 18px 18px; box-shadow:0 20px 50px rgba(0,0,0,0.55);
  max-height:82vh; display:flex; flex-direction:column; overflow:hidden;
  animation:drawer-slide-down .2s ease-out;
}
@keyframes drawer-slide-down{from{transform:translateY(-12px); opacity:0;} to{transform:translateY(0); opacity:1;}}
.mobile-drawer-head{
  display:flex; align-items:center; justify-content:space-between; padding:14px 16px;
  border-bottom:1px solid var(--border); font-family:'Space Grotesk',sans-serif; font-weight:600; font-size:14.5px;
  flex-shrink:0;
}
.mobile-drawer .sidebar{
  display:flex; width:100%; min-width:0; min-height:0; max-height:none; border-right:none; padding:12px 14px 20px; flex:1; overflow-y:auto;
}
`;
