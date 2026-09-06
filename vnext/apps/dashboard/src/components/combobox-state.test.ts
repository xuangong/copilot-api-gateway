import { describe, expect, test } from "bun:test";
import {
  filterComboboxOptions,
  getComboboxPlacement,
  getInitialActiveOptionIndex,
  moveActiveOption,
  type ComboboxOption,
} from "./combobox-state";

const options: [ComboboxOption, ComboboxOption, ComboboxOption] = [
  {
    value: "gpt-5-mini",
    label: "GPT 5 Mini",
    badge: "Azure OpenAI",
    keywords: ["fast", "economy"],
  },
  {
    value: "gpt-5",
    label: "GPT 5",
    badge: "Production",
    keywords: ["flagship"],
  },
  {
    value: "claude-haiku",
    label: "Haiku",
    badge: "Anthropic",
    keywords: ["fast"],
  },
];

describe("combobox state", () => {
  test("finds model IDs and abbreviated fuzzy queries", () => {
    expect(filterComboboxOptions(options, "gpt-5-mini")).toEqual([options[0]]);
    expect(filterComboboxOptions(options, "gpt5m")).toEqual([options[0]]);
    expect(filterComboboxOptions(options, "cldhaiku")).toEqual([options[2]]);
    expect(filterComboboxOptions(options, "no-such-model")).toEqual([]);
  });

  test("does not assemble a fuzzy model match across the upstream badge", () => {
    const copilotOptions = ["gpt-5.6-luna", "gpt-5.6-terra"].map((id) => ({
      value: id,
      label: id,
      badge: "Copilot demo",
    }));
    expect(filterComboboxOptions(copilotOptions, "gpt56t")).toEqual([
      { value: "gpt-5.6-terra", label: "gpt-5.6-terra", badge: "Copilot demo" },
    ]);
    expect(filterComboboxOptions(copilotOptions, "copilot luna")).toEqual([
      { value: "gpt-5.6-luna", label: "gpt-5.6-luna", badge: "Copilot demo" },
    ]);
  });

  test("filters case-insensitively by every query word across label badge and keywords", () => {
    expect(filterComboboxOptions(options, "azure FAST")).toEqual([options[0]]);
    expect(filterComboboxOptions(options, "production gpt")).toEqual([
      options[1],
    ]);
    expect(filterComboboxOptions(options, "anthropic fast")).toEqual([
      options[2],
    ]);
  });

  test("starts on the selected option and navigates only enabled options", () => {
    const disabledAtEdges: ComboboxOption[] = [
      { ...options[0], disabled: true },
      options[1],
      { ...options[2], disabled: true },
    ];
    expect(getInitialActiveOptionIndex(options, "gpt-5")).toBe(1);
    expect(getInitialActiveOptionIndex(options, "missing")).toBe(0);
    expect(moveActiveOption(options, 2, "ArrowDown")).toBe(0);
    expect(moveActiveOption(options, 0, "ArrowUp")).toBe(2);
    expect(moveActiveOption(disabledAtEdges, 1, "Home")).toBe(1);
    expect(moveActiveOption(disabledAtEdges, 1, "End")).toBe(1);
    expect(moveActiveOption(disabledAtEdges, 1, "ArrowDown")).toBe(1);
    expect(
      moveActiveOption(
        disabledAtEdges.map((option) => ({ ...option, disabled: true })),
        -1,
        "Home",
      ),
    ).toBe(-1);
  });

  test("places the popup above when below has less room and clamps it inside the viewport", () => {
    expect(
      getComboboxPlacement(
        { left: 290, top: 170, width: 80, height: 30 },
        { width: 180, height: 120 },
        { width: 320, height: 240 },
      ),
    ).toEqual({
      left: 132,
      top: 42,
      width: 180,
      maxHeight: 120,
      placement: "above",
    });
  });

  test("clamps an oversized popup width inside the viewport", () => {
    expect(
      getComboboxPlacement(
        { left: 0, top: 20, width: 600, height: 30 },
        { width: 600, height: 120 },
        { width: 320, height: 240 },
      ),
    ).toEqual({
      left: 8,
      top: 58,
      width: 304,
      maxHeight: 120,
      placement: "below",
    });
  });

  test("uses the room below and limits popup height when neither side fits", () => {
    expect(
      getComboboxPlacement(
        { left: 8, top: 100, width: 100, height: 30 },
        { width: 220, height: 400 },
        { width: 400, height: 240 },
      ),
    ).toEqual({
      left: 8,
      top: 138,
      width: 220,
      maxHeight: 94,
      placement: "below",
    });
  });
});
