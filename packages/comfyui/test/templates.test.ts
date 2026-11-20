// The template machinery: placeholders keep their value's type, a missing or
// unknown name is refused, optional and bypassed nodes leave the graph.

import { describe, expect, it } from "vitest";
import { ComfyUiError, fillWorkflow, nodeClassesOf, placeholdersOf, type GraphTemplate } from "../src/index.js";

const template = (): GraphTemplate => ({
  prompt: {
    "1": { class_type: "LoadAudio", inputs: { audio: "{{input}}" } },
    "2": { class_type: "TrimAudioDuration", inputs: { audio: ["1", 0], start_index: "{{start}}", duration: 5 } },
    "3": { class_type: "SaveAudio", inputs: { audio: ["2", 0], filename_prefix: "{{prefix}}" } },
    "4": { class_type: "SaveAudio", inputs: { audio: ["1", 0], filename_prefix: "{{extra}}" } },
  },
  optionalNodes: { extra: "4" },
  bypassNodes: { trim: "2" },
});

describe("templates", () => {
  it("name their placeholders and node classes", () => {
    expect(placeholdersOf(template())).toEqual(["extra", "input", "prefix", "start"]);
    expect(nodeClassesOf(template().prompt)).toEqual(["LoadAudio", "SaveAudio", "TrimAudioDuration"]);
  });

  it("fill values with their types, leave out optional nodes and pass through bypassed ones", () => {
    const filled = fillWorkflow(template(), { input: "a.wav", prefix: "out/x", trim: true, start: 2.5 });
    expect(filled["2"]!.inputs).toEqual({ audio: ["1", 0], start_index: 2.5, duration: 5 });
    expect(filled["4"]).toBeUndefined();
    const bypassed = fillWorkflow({ ...template(), prompt: { ...template().prompt, "2": { class_type: "TrimAudioDuration", inputs: { audio: ["1", 0], duration: 5 } } } }, { input: "a.wav", prefix: "p", extra: "e" });
    expect(bypassed["2"]).toBeUndefined();
    expect(bypassed["3"]!.inputs.audio).toEqual(["1", 0]);
    expect(bypassed["4"]!.inputs.filename_prefix).toBe("e");
  });

  it("refuse a missing value and a value nothing asks for", () => {
    expect(() => fillWorkflow(template(), { prefix: "p", trim: true, start: 0 })).toThrow(ComfyUiError);
    expect(() => fillWorkflow(template(), { input: "a", prefix: "p", trim: true, start: 0, typo: 1 })).toThrow(/no placeholder for typo/);
  });
});
