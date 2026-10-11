import { describe, expect, it } from "vitest";
import { Brain, MODEL, normalizeDecision, renderMemories } from "../src/brain.ts";
import { Vault } from "../src/vault.ts";
import { SENDER, TZ, decision, makeClock, mockClaude, tempDir } from "./helpers.ts";

describe("Brain.decide", () => {
  it("sends the model, schema, current time and all of the sender's memories", async () => {
    const vault = new Vault(await tempDir(), TZ, makeClock("2026-10-10T17:00:00Z").now);
    await vault.save(SENDER, { title: "Suitcase", now: "attic", original: "my suitcase is in the attic" });
    const claude = mockClaude(decision({ intent: "recall", found: true, answer: "In the attic", source_notes: ["Suitcase"] }));
    const brain = new Brain(claude);

    const d = await brain.decide({
      message: "Where's the luggage?",
      memories: await vault.list(SENDER),
      now: new Date("2026-10-11T17:00:00Z"),
      timeZone: TZ,
      enabledActions: ["calendar_event"],
    });

    expect(d).toMatchObject({ intent: "recall", found: true, answer: "In the attic", source_notes: ["Suitcase"] });
    const params = claude.calls[0]!;
    expect(params.model).toBe(MODEL);
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.output_config?.format?.type).toBe("json_schema");
    const content = params.messages[0]!.content as string;
    expect(content).toContain("Sunday, October 11, 2026");
    expect(content).toContain('<note id="Suitcase" last_saved="Oct 10, 2026">');
    expect(content).toContain("my suitcase is in the attic");
    expect(content).toContain("<message>\nWhere's the luggage?\n</message>");
    const system = JSON.stringify(params.system);
    expect(system).toContain("calendar_event");
    expect(system).not.toContain("- bedtime:");
  });

  it("treats a refusal as unclear", async () => {
    const brain = new Brain(async () => {
      const { fakeResponse } = await import("./helpers.ts");
      return fakeResponse("", "refusal");
    });
    const d = await brain.decide({ message: "x", memories: [], now: new Date(), timeZone: TZ, enabledActions: [] });
    expect(d.intent).toBe("unclear");
  });

  it("treats malformed JSON as unclear", async () => {
    const brain = new Brain(mockClaude("not json"));
    const d = await brain.decide({ message: "x", memories: [], now: new Date(), timeZone: TZ, enabledActions: [] });
    expect(d.intent).toBe("unclear");
  });

  it("propagates API errors to the caller", async () => {
    const brain = new Brain(mockClaude(new Error("network down")));
    await expect(
      brain.decide({ message: "x", memories: [], now: new Date(), timeZone: TZ, enabledActions: [] }),
    ).rejects.toThrow("network down");
  });
});

describe("normalizeDecision", () => {
  it("drops actions that are not enabled or unknown, and coerces fields", () => {
    const d = normalizeDecision(
      {
        intent: "save",
        target_note: " ",
        title: "Dentist",
        now: "Tuesday 3pm",
        entities: ["Dr. Lee", 3, ""],
        found: "yes",
        answer: "",
        source_notes: [],
        actions: [
          { action: "calendar_event", title: "Dentist", start: "2026-10-13T15:00:00", end: "", notes: "", minutes: 0 },
          { action: "bedtime", title: "", start: "", end: "", notes: "", minutes: 0 },
          { action: "rm -rf /", title: "", start: "", end: "", notes: "", minutes: 0 },
        ],
      },
      ["calendar_event"],
    );
    expect(d.intent).toBe("save");
    expect(d.target_note).toBe("");
    expect(d.entities).toEqual(["Dr. Lee"]);
    expect(d.found).toBe(false);
    expect(d.actions.map((a) => a.action)).toEqual(["calendar_event"]);
  });

  it("maps unknown intents to unclear", () => {
    expect(normalizeDecision({ intent: "delete_everything" }, []).intent).toBe("unclear");
    expect(normalizeDecision(null, []).intent).toBe("unclear");
  });

  it("renders an explicit empty state", () => {
    expect(renderMemories([], TZ)).toContain("(none saved yet)");
  });
});
