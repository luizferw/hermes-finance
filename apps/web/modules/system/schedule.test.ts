import { describe, expect, it } from "vitest";
import { isJobStale, parseCron, previousFireTime, staleGraceMs } from "./schedule";

const at = (iso: string) => new Date(iso);

describe("previousFireTime", () => {
  it("finds the last monthly fire", () => {
    expect(previousFireTime("15 0 1 * *", at("2026-10-19T12:00:00Z"))?.toISOString()).toBe(
      "2026-10-01T00:15:00.000Z",
    );
    // Before the 1st's fire time, it is last month's.
    expect(previousFireTime("15 0 1 * *", at("2026-10-01T00:10:00Z"))?.toISOString()).toBe(
      "2026-09-01T00:15:00.000Z",
    );
  });

  it("handles daily, stepped and listed schedules", () => {
    expect(previousFireTime("0 6 * * *", at("2026-10-19T05:59:00Z"))?.toISOString()).toBe(
      "2026-10-18T06:00:00.000Z",
    );
    expect(previousFireTime("*/30 * * * *", at("2026-10-19T10:44:00Z"))?.toISOString()).toBe(
      "2026-10-19T10:30:00.000Z",
    );
    expect(previousFireTime("0 3,15 * * 1-5", at("2026-10-18T20:00:00Z"))?.toISOString()).toBe(
      // 2026-10-18 is a Sunday; the last weekday fire is Friday 15:00.
      "2026-10-16T15:00:00.000Z",
    );
  });

  it("returns null for an expression it does not understand", () => {
    expect(parseCron("@daily")).toBeNull();
    expect(previousFireTime("0 6 * * MON", at("2026-10-19T00:00:00Z"))).toBeNull();
  });
});

describe("isJobStale", () => {
  it("does not flag a monthly job that ran on schedule (the 36h false alarm)", () => {
    const job = { schedule: "15 0 1 * *", lastRunAt: at("2026-10-01T00:15:02Z") };
    expect(isJobStale(job, at("2026-10-19T12:00:00Z"))).toBe(false);
    expect(isJobStale(job, at("2026-10-31T23:00:00Z"))).toBe(false);
    // Still fine shortly after the next fire time (inside the grace)...
    expect(isJobStale(job, at("2026-11-01T06:00:00Z"))).toBe(false);
    // ...and stale once November's run is overdue by more than the grace.
    expect(isJobStale(job, at("2026-11-01T13:00:00Z"))).toBe(true);
  });

  it("flags a daily job that missed a day, but not one waiting for today's run", () => {
    const job = { schedule: "0 6 * * *", lastRunAt: at("2026-10-18T06:00:01Z") };
    expect(isJobStale(job, at("2026-10-19T05:00:00Z"))).toBe(false);
    expect(isJobStale(job, at("2026-10-19T17:00:00Z"))).toBe(false);
    expect(isJobStale(job, at("2026-10-19T18:30:00Z"))).toBe(true);
  });

  it("scales the grace to the interval", () => {
    expect(staleGraceMs("*/30 * * * *", at("2026-10-19T10:00:00Z"))).toBe(60 * 60 * 1000);
    expect(staleGraceMs("0 6 * * *", at("2026-10-19T10:00:00Z"))).toBe(12 * 60 * 60 * 1000);
    const job = { schedule: "*/30 * * * *", lastRunAt: at("2026-10-19T08:00:00Z") };
    expect(isJobStale(job, at("2026-10-19T09:00:00Z"))).toBe(false);
    expect(isJobStale(job, at("2026-10-19T09:40:00Z"))).toBe(true);
  });

  it("never flags a job that has not run yet", () => {
    expect(isJobStale({ schedule: "0 6 * * *", lastRunAt: null }, at("2026-10-19T00:00:00Z"))).toBe(false);
  });

  it("falls back to 36 hours for an unparseable schedule", () => {
    const job = { schedule: "@hourly", lastRunAt: at("2026-10-18T00:00:00Z") };
    expect(isJobStale(job, at("2026-10-19T11:00:00Z"))).toBe(false);
    expect(isJobStale(job, at("2026-10-19T13:00:00Z"))).toBe(true);
  });
});
