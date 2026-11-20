import { describe, expect, it } from "vitest";
import type { PaletteParams, StyleParams } from "@studio/contracts/src/style.mjs";
import { changedParams, consequence, draftOf, draftProblems, inkOn, previewBrief, withColor, withoutColor } from "../../src/lib/style-edit";

const palette: PaletteParams = {
  kind: "palette", title: "Palette", min: 2, max: 3,
  colors: [{ id: "ink", name: "Indigo", value: "#2b2f6b" }, { id: "paper", name: "Cream", value: "#f3ead7" }],
};
const params: Record<string, StyleParams> = {
  palette,
  motion: { kind: "values", title: "Motion", fields: [{ id: "timing", label: "Animate on", type: "enum", value: "twos", options: ["ones", "twos"] }] },
};

describe("a style draft", () => {
  it("says which files changed, leaving what was read alone", () => {
    const draft = draftOf(params);
    (draft.palette as PaletteParams).colors[0]!.value = "#000000";
    expect(changedParams(params, draft, ["palette", "motion"])).toEqual(["palette"]);
    expect(palette.colors[0]!.value).toBe("#2b2f6b");
  });

  it("finds what does not hold, by file", () => {
    const draft = draftOf(params);
    (draft.palette as PaletteParams).colors[0]!.value = "blue";
    expect(Object.keys(draftProblems(draft))).toEqual(["palette"]);
  });

  it("previews the brief with the draft's values", () => {
    const draft = draftOf(params);
    (draft.palette as PaletteParams).colors[1]!.value = "#ffffff";
    expect(previewBrief("On {{palette.paper}}, on {{motion.timing}}. {{unit.idea}}", draft, { idea: "A storm." }).text).toBe("On #ffffff, on twos. A storm.");
    expect(previewBrief("{{palette.gold}}", draft).problems[0]!.code).toBe("unknown-entry");
  });

  it("adds and removes colours within the palette's bounds", () => {
    const more = withColor(palette);
    expect(more.colors.map((c) => c.id)).toEqual(["ink", "paper", "color-3"]);
    expect(withColor(more)).toBe(more);
    expect(withoutColor(more, "ink").colors).toHaveLength(2);
    expect(withoutColor(palette, "ink")).toBe(palette);
  });

  it("chooses a readable ink for a swatch, and says what a save costs", () => {
    expect(inkOn("#000000")).toBe("#ffffff");
    expect(inkOn("#f3ead7")).toBe("#000000");
    expect(consequence([])).toMatch(/Nothing reads/);
    expect(consequence(["a", "b"])).toMatch(/^2 units read this style/);
  });
});
