import { describe, expect, it } from "vitest";
import { INFORMS_MS, noticeDuration } from "../src/ui/notice-time";

describe("how long a notice stays", () => {
  it("leaves on its own when it only informs", () => {
    expect(noticeDuration({})).toBe(INFORMS_MS);
    expect(noticeDuration({ actions: [] })).toBe(INFORMS_MS);
  });

  it("stays until used or closed when it has a button", () => {
    expect(noticeDuration({ actions: [{}] })).toBe(0);
  });

  it("keeps a time it was given", () => {
    expect(noticeDuration({ duration: 0 })).toBe(0);
    expect(noticeDuration({ duration: 8_000, actions: [{}] })).toBe(8_000);
  });
});
