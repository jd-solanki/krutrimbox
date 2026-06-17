import { describe, expect, test } from "vitest";
import { classifyOwnership, isImplementable } from "../src/lib/factory/ownership";

describe("classifyOwnership", () => {
  test("an issue assigned only to the Operator is owned", () => {
    expect(classifyOwnership({ assignees: [{ login: "alice" }] }, "alice")).toBe("owned");
  });

  test("an issue assigned to one other person belongs to that person", () => {
    expect(classifyOwnership({ assignees: [{ login: "bob" }] }, "alice")).toBe("assigned-to-others");
  });

  test("an issue assigned to several people is ambiguous, even when the Operator is one of them", () => {
    expect(
      classifyOwnership({ assignees: [{ login: "alice" }, { login: "bob" }] }, "alice")
    ).toBe("multiple-assignees");
  });

  test("an issue with no assignees is unassigned", () => {
    expect(classifyOwnership({ assignees: [] }, "alice")).toBe("unassigned");
  });
});

describe("isImplementable", () => {
  test("an Owned Issue is always implementable", () => {
    expect(isImplementable("owned", { allowUnassigned: false })).toBe(true);
  });

  test("an unassigned issue is implementable only under the Implement-Unassigned Override", () => {
    expect(isImplementable("unassigned", { allowUnassigned: false })).toBe(false);
    expect(isImplementable("unassigned", { allowUnassigned: true })).toBe(true);
  });

  test("an issue owned by others or ambiguously assigned is never implementable", () => {
    expect(isImplementable("assigned-to-others", { allowUnassigned: true })).toBe(false);
    expect(isImplementable("multiple-assignees", { allowUnassigned: true })).toBe(false);
  });
});
