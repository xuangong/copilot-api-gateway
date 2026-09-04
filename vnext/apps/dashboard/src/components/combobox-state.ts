export interface ComboboxOption {
  value: string;
  label: string;
  badge?: string;
  keywords?: string[];
  disabled?: boolean;
}

export interface ComboboxRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ComboboxSize {
  width: number;
  height: number;
}

export interface ComboboxViewport {
  width: number;
  height: number;
}

export interface ComboboxPlacement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: "above" | "below";
}

const VIEWPORT_PADDING = 8;
const POPUP_GAP = 8;

export function filterComboboxOptions(
  options: ComboboxOption[],
  query: string,
): ComboboxOption[] {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return options;
  return options.filter((option) => {
    const haystack = [option.label, option.badge, ...(option.keywords ?? [])]
      .filter(Boolean)
      .join(" ")
      .toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function getInitialActiveOptionIndex(
  options: ComboboxOption[],
  value: string,
): number {
  const selected = options.findIndex(
    (option) => option.value === value && !option.disabled,
  );
  if (selected >= 0) return selected;
  return options.findIndex((option) => !option.disabled);
}

export function moveActiveOption(
  currentIndex: number,
  optionCount: number,
  key: "ArrowDown" | "ArrowUp" | "Home" | "End",
): number {
  if (optionCount === 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return optionCount - 1;
  if (currentIndex < 0) return key === "ArrowDown" ? 0 : optionCount - 1;
  return key === "ArrowDown"
    ? (currentIndex + 1) % optionCount
    : (currentIndex - 1 + optionCount) % optionCount;
}

export function getComboboxPlacement(
  anchor: ComboboxRect,
  popup: ComboboxSize,
  viewport: ComboboxViewport,
): ComboboxPlacement {
  const maxLeft = Math.max(
    VIEWPORT_PADDING,
    viewport.width - VIEWPORT_PADDING - popup.width,
  );
  const left = Math.min(Math.max(VIEWPORT_PADDING, anchor.left), maxLeft);
  const belowSpace = Math.max(
    0,
    viewport.height -
      VIEWPORT_PADDING -
      (anchor.top + anchor.height) -
      POPUP_GAP,
  );
  const aboveSpace = Math.max(0, anchor.top - VIEWPORT_PADDING - POPUP_GAP);
  const placement = aboveSpace > belowSpace ? "above" : "below";
  const maxHeight = Math.max(
    0,
    Math.min(popup.height, placement === "above" ? aboveSpace : belowSpace),
  );
  const top =
    placement === "above"
      ? anchor.top - POPUP_GAP - maxHeight
      : anchor.top + anchor.height + POPUP_GAP;
  return { left, top, width: popup.width, maxHeight, placement };
}
