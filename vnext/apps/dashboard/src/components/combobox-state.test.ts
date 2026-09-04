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
  test("filters case-insensitively by every query word across label badge and keywords", () => {
    expect(filterComboboxOptions(options, "azure FAST")).toEqual([options[0]]);
    expect(filterComboboxOptions(options, "production gpt")).toEqual([
      options[1],
    ]);
    expect(filterComboboxOptions(options, "anthropic fast")).toEqual([
      options[2],
    ]);
  });

  test("starts on the selected option and wraps keyboard active navigation", () => {
    expect(getInitialActiveOptionIndex(options, "gpt-5")).toBe(1);
    expect(getInitialActiveOptionIndex(options, "missing")).toBe(0);
    expect(moveActiveOption(2, 3, "ArrowDown")).toBe(0);
    expect(moveActiveOption(0, 3, "ArrowUp")).toBe(2);
    expect(moveActiveOption(1, 3, "Home")).toBe(0);
    expect(moveActiveOption(1, 3, "End")).toBe(2);
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
