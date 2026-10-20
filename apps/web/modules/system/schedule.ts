/**
 * Job staleness from each job's own cron schedule. Pure (no IO), so the health
 * check and its tests share one implementation.
 *
 * A fixed "older than 36 hours" rule flagged the monthly budget-periods job
 * as stale every month on day two, although it had run exactly on schedule.
 * The question the health check really asks is "did the job miss a run it
 * should have made?", which only the schedule can answer.
 */

/**
 * How long after a scheduled fire time a missing run is tolerated: one
 * schedule interval, but at least an hour (pg-boss polls, a deploy may be
 * restarting) and at most 12 hours, so a daily job reads stale by midday
 * after a missed run and a half-hourly one after an hour.
 */
export const MIN_GRACE_MS = 1000 * 60 * 60;
export const MAX_GRACE_MS = 1000 * 60 * 60 * 12;

/** Clock slack between the scheduler's fire time and the recorded start. */
const START_SLACK_MS = 1000 * 60 * 5;

/** How far back to look for a fire time before giving up (covers yearly). */
const MAX_LOOKBACK_DAYS = 366 * 2;

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1 || range === undefined) return null;
    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      if (a === undefined || b === undefined) return null;
      from = a;
      to = b;
    } else {
      from = Number(range);
      // "5/15" means "from 5 every 15", up to the field's maximum.
      to = stepText === undefined ? from : max;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      return null;
    }
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return values;
}

/**
 * The five standard cron fields (minute hour day-of-month month day-of-week),
 * numeric values only, which is every schedule this app registers. Returns
 * null for anything else, so the caller can fall back instead of guessing.
 */
export function parseCron(expression: string): CronFields | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const minutes = parseField(m, 0, 59);
  const hours = parseField(h, 0, 23);
  const daysOfMonth = parseField(dom, 1, 31);
  const months = parseField(mon, 1, 12);
  const daysOfWeekRaw = parseField(dow, 0, 7);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeekRaw) return null;
  // 7 is Sunday too.
  const daysOfWeek = new Set([...daysOfWeekRaw].map((d) => d % 7));
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

function dayMatches(cron: CronFields, day: Date): boolean {
  if (!cron.months.has(day.getUTCMonth() + 1)) return false;
  const domOk = cron.daysOfMonth.has(day.getUTCDate());
  const dowOk = cron.daysOfWeek.has(day.getUTCDay());
  // Standard cron: when both day fields are restricted, either may match.
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * The latest time at or before `at` the schedule fires, in UTC (jobs are
 * registered with tz UTC). Null when the expression is not understood or
 * never fires in the lookback window.
 */
export function previousFireTime(expression: string, at: Date): Date | null {
  const cron = parseCron(expression);
  if (!cron) return null;
  const hours = [...cron.hours].sort((a, b) => b - a);
  const minutes = [...cron.minutes].sort((a, b) => b - a);
  const day = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  for (let i = 0; i <= MAX_LOOKBACK_DAYS; i++) {
    if (dayMatches(cron, day)) {
      for (const hour of hours) {
        for (const minute of minutes) {
          const fire = new Date(day.getTime() + (hour * 60 + minute) * 60_000);
          if (fire.getTime() <= at.getTime()) return fire;
        }
      }
    }
    day.setUTCDate(day.getUTCDate() - 1);
  }
  return null;
}

/** Grace for a schedule: its interval clamped to [MIN_GRACE_MS, MAX_GRACE_MS]. */
export function staleGraceMs(expression: string, now: Date): number {
  const last = previousFireTime(expression, now);
  const before = last ? previousFireTime(expression, new Date(last.getTime() - 1)) : null;
  if (!last || !before) return MAX_GRACE_MS;
  return Math.min(MAX_GRACE_MS, Math.max(MIN_GRACE_MS, last.getTime() - before.getTime()));
}

/**
 * A job is stale when it missed a run it should have made: its last run
 * started before the most recent scheduled fire time that is older than the
 * schedule's grace. A job that never ran is not stale (it registers on first
 * start), and an unparseable schedule falls back to the old fixed 36-hour rule.
 */
export function isJobStale(job: { schedule: string | null; lastRunAt: Date | null }, now: Date): boolean {
  if (!job.lastRunAt) return false;
  const schedule = job.schedule ?? "";
  const grace = staleGraceMs(schedule, now);
  const due = previousFireTime(schedule, new Date(now.getTime() - grace));
  if (!due) return now.getTime() - job.lastRunAt.getTime() > 1000 * 60 * 60 * 36;
  return job.lastRunAt.getTime() < due.getTime() - START_SLACK_MS;
}
