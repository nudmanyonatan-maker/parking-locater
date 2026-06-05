import { describe, it, expect } from "vitest";
import { shouldFireReminder } from "../src/reminder.js";

const base = { lat: 40.85, lng: -73.93, note: "", createdAt: 0, reminderSent: false };
const MIN = 60 * 1000;

describe("shouldFireReminder", () => {
  it("is false when there is no spot", () => {
    expect(shouldFireReminder(null, 0)).toBe(false);
  });

  it("is false when moveBy is null", () => {
    expect(shouldFireReminder({ ...base, moveBy: null }, 0)).toBe(false);
  });

  it("is false when more than 5 minutes remain", () => {
    expect(shouldFireReminder({ ...base, moveBy: 6 * MIN }, 0)).toBe(false);
  });

  it("is true at exactly 5 minutes out", () => {
    expect(shouldFireReminder({ ...base, moveBy: 5 * MIN }, 0)).toBe(true);
  });

  it("is true just before the move-by time", () => {
    expect(shouldFireReminder({ ...base, moveBy: 1 * MIN }, 0)).toBe(true);
  });

  it("is true within the 2-minute grace after move-by", () => {
    expect(shouldFireReminder({ ...base, moveBy: -1 * MIN }, 0)).toBe(true);
  });

  it("is false once the grace window has passed", () => {
    expect(shouldFireReminder({ ...base, moveBy: -3 * MIN }, 0)).toBe(false);
  });

  it("is false when the reminder was already sent", () => {
    expect(shouldFireReminder({ ...base, moveBy: 1 * MIN, reminderSent: true }, 0)).toBe(false);
  });
});
