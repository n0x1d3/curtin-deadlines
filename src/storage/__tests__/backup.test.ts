// ── Tests: storage/backup.ts ──────────────────────────────────────────────────
// importJSON: merge/dedup logic tested by mocking loadDeadlines + saveDeadlines.
// exportJSON: DOM-side-effect function — verified via spies.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MockedFunction } from "vitest";
import type { Deadline } from "../../types";

// Stub the Chrome storage module so tests never touch chrome.storage.local
vi.mock("../index", () => ({
  loadDeadlines: vi.fn(),
  saveDeadlines: vi.fn().mockResolvedValue(undefined),
}));

// Imports must come AFTER vi.mock() so the hoisted mock is in place
import { loadDeadlines, saveDeadlines } from "../index";
import { importJSON, exportJSON } from "../backup";

const mockLoad = loadDeadlines as MockedFunction<typeof loadDeadlines>;
const mockSave = saveDeadlines as MockedFunction<typeof saveDeadlines>;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDeadline(
  id: string,
  dueDate: string,
  overrides: Partial<Deadline> = {},
): Deadline {
  return {
    id,
    title: `Task ${id}`,
    unit: "COMP1005",
    dueDate,
    source: "manual",
    addedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeFile(content: string): File {
  return new File([content], "backup.json", { type: "application/json" });
}

// ── importJSON ────────────────────────────────────────────────────────────────

describe("importJSON — valid input", () => {
  beforeEach(() => {
    mockLoad.mockResolvedValue([]);
    mockSave.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves and saves a valid JSON array", async () => {
    const item = makeDeadline("1", "2026-05-03T00:00:00.000Z");
    await importJSON(makeFile(JSON.stringify([item])));

    expect(mockSave).toHaveBeenCalledOnce();
    const saved: Deadline[] = mockSave.mock.calls[0][0];
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe("1");
  });

  it("resolves with an empty import array (no-op merge)", async () => {
    mockLoad.mockResolvedValue([makeDeadline("1", "2026-05-03T00:00:00.000Z")]);
    await importJSON(makeFile("[]"));

    const saved: Deadline[] = mockSave.mock.calls[0][0];
    // Existing item kept, nothing added
    expect(saved).toHaveLength(1);
  });

  it("keeps existing deadlines whose ids are not in the import", async () => {
    const existing = makeDeadline("existing", "2026-03-01T00:00:00.000Z");
    const imported = makeDeadline("imported", "2026-05-03T00:00:00.000Z");
    mockLoad.mockResolvedValue([existing]);

    await importJSON(makeFile(JSON.stringify([imported])));

    const saved: Deadline[] = mockSave.mock.calls[0][0];
    expect(saved).toHaveLength(2);
    expect(saved.map((d) => d.id)).toContain("existing");
    expect(saved.map((d) => d.id)).toContain("imported");
  });

  it("overwrites an existing deadline when the imported item has the same id", () => {
    const existing = makeDeadline("1", "2026-03-01T00:00:00.000Z", {
      title: "Old Title",
    });
    const imported = makeDeadline("1", "2026-05-03T00:00:00.000Z", {
      title: "New Title",
    });
    mockLoad.mockResolvedValue([existing]);

    return importJSON(makeFile(JSON.stringify([imported]))).then(() => {
      const saved: Deadline[] = mockSave.mock.calls[0][0];
      expect(saved).toHaveLength(1);
      expect(saved[0].title).toBe("New Title");
    });
  });

  it("sorts the merged list by dueDate ascending", async () => {
    const later = makeDeadline("later", "2026-06-01T00:00:00.000Z");
    const earlier = makeDeadline("earlier", "2026-03-01T00:00:00.000Z");
    mockLoad.mockResolvedValue([later]);

    await importJSON(makeFile(JSON.stringify([earlier])));

    const saved: Deadline[] = mockSave.mock.calls[0][0];
    expect(saved[0].id).toBe("earlier");
    expect(saved[1].id).toBe("later");
  });

  it("handles multiple imported items with multiple deduplication targets", async () => {
    // 3 existing, 2 are overwritten, 1 is new
    const existing = [
      makeDeadline("a", "2026-03-01T00:00:00.000Z", { title: "Old A" }),
      makeDeadline("b", "2026-04-01T00:00:00.000Z", { title: "Old B" }),
      makeDeadline("c", "2026-05-01T00:00:00.000Z"),
    ];
    const imported = [
      makeDeadline("a", "2026-03-15T00:00:00.000Z", { title: "New A" }),
      makeDeadline("b", "2026-04-15T00:00:00.000Z", { title: "New B" }),
      makeDeadline("d", "2026-06-01T00:00:00.000Z"),
    ];
    mockLoad.mockResolvedValue(existing);

    await importJSON(makeFile(JSON.stringify(imported)));

    const saved: Deadline[] = mockSave.mock.calls[0][0];
    // c kept, a and b replaced, d added = 4 total
    expect(saved).toHaveLength(4);
    expect(saved.find((d) => d.id === "a")?.title).toBe("New A");
    expect(saved.find((d) => d.id === "b")?.title).toBe("New B");
    expect(saved.find((d) => d.id === "c")).toBeDefined();
    expect(saved.find((d) => d.id === "d")).toBeDefined();
  });
});

describe("importJSON — validation errors", () => {
  beforeEach(() => {
    mockLoad.mockResolvedValue([]);
    mockSave.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects when the file contains malformed JSON", async () => {
    await expect(importJSON(makeFile("not json {{"))).rejects.toThrow();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("rejects with a descriptive message when the JSON is not an array", async () => {
    await expect(importJSON(makeFile('{"not": "array"}'))).rejects.toThrow(
      "Expected a JSON array",
    );
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("rejects when an item is missing the required 'id' field", async () => {
    const bad = [
      { title: "T", unit: "COMP1005", dueDate: "2026-05-03T00:00:00.000Z" },
    ];
    await expect(importJSON(makeFile(JSON.stringify(bad)))).rejects.toThrow();
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("rejects when an item is missing the required 'title' field", async () => {
    const bad = [
      { id: "1", unit: "COMP1005", dueDate: "2026-05-03T00:00:00.000Z" },
    ];
    await expect(importJSON(makeFile(JSON.stringify(bad)))).rejects.toThrow();
  });

  it("rejects when an item is missing the required 'dueDate' field", async () => {
    const bad = [{ id: "1", title: "T", unit: "COMP1005" }];
    await expect(importJSON(makeFile(JSON.stringify(bad)))).rejects.toThrow();
  });

  it("does not call saveDeadlines when validation fails", async () => {
    await expect(importJSON(makeFile("null"))).rejects.toThrow();
    expect(mockSave).not.toHaveBeenCalled();
  });
});

// ── exportJSON ────────────────────────────────────────────────────────────────

describe("exportJSON", () => {
  let createObjectURL: ReturnType<typeof vi.spyOn>;
  let revokeObjectURL: ReturnType<typeof vi.spyOn>;
  let mockAnchor: {
    href: string;
    download: string;
    click: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test-url");
    revokeObjectURL = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    mockAnchor = { href: "", download: "", click: vi.fn() };
    vi.spyOn(document, "createElement").mockReturnValue(
      mockAnchor as unknown as HTMLElement,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("assigns a blob URL to the anchor and triggers a click", () => {
    exportJSON([makeDeadline("1", "2026-05-03T00:00:00.000Z")]);

    expect(mockAnchor.href).toBe("blob:test-url");
    expect(mockAnchor.click).toHaveBeenCalledOnce();
  });

  it("sets a download filename containing today's date", () => {
    vi.setSystemTime(new Date("2026-03-16T12:00:00"));
    exportJSON([]);

    expect(mockAnchor.download).toBe("curtin-deadlines-2026-03-16.json");
  });

  it("revokes the blob URL after the 3 s delay", () => {
    exportJSON([]);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test-url");
  });

  it("serialises all deadline fields as JSON", () => {
    const deadline = makeDeadline("1", "2026-05-03T00:00:00.000Z");
    exportJSON([deadline]);

    // The Blob passed to createObjectURL should contain valid JSON with the deadline
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blob: Blob = (createObjectURL as any).mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("application/json");
  });
});
