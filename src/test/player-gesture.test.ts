import { describe, expect, it } from "vitest";
import { isDismissSwipe } from "@/lib/player-gesture";

const start = { x: 100, y: 100, time: 0 };
describe("player dismissal intent", () => {
  it("accepts an intentional downward swipe", () => {
    expect(isDismissSwipe(start, { x: 110, y: 230, time: 400 })).toBe(true);
  });
  it("rejects taps", () => {
    expect(isDismissSwipe(start, { x: 102, y: 105, time: 150 })).toBe(false);
  });
  it("rejects horizontal gestures", () => {
    expect(isDismissSwipe(start, { x: 250, y: 190, time: 300 })).toBe(false);
  });
  it("rejects upward gestures", () => {
    expect(isDismissSwipe(start, { x: 100, y: 0, time: 300 })).toBe(false);
  });
});
