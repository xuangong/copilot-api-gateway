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
    const fields = [option.value, option.label, option.badge, ...(option.keywords ?? [])]
      .flatMap((field) => field ? [field.toLocaleLowerCase()] : []);
    return words.every((word) => fields.some((field) => {
      if (field.includes(word)) return true;
      let matched = 0;
      for (const char of field) {
        if (char === word[matched]) matched++;
        if (matched === word.length) return true;
      }
      return false;
    }));
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
  options: ComboboxOption[],
  currentIndex: number,
  key: "ArrowDown" | "ArrowUp" | "Home" | "End",
): number {
  const enabledIndexes = options.reduce<number[]>((indexes, option, index) => {
    if (!option.disabled) indexes.push(index);
    return indexes;
  }, []);
  if (enabledIndexes.length === 0) return -1;
  if (key === "Home") return enabledIndexes[0] ?? -1;
  if (key === "End") return enabledIndexes.at(-1) ?? -1;
  const currentEnabledIndex = enabledIndexes.indexOf(currentIndex);
  if (currentEnabledIndex < 0) {
    return key === "ArrowDown"
      ? (enabledIndexes[0] ?? -1)
      : (enabledIndexes.at(-1) ?? -1);
  }
  const delta = key === "ArrowDown" ? 1 : -1;
  return (
    enabledIndexes[
      (currentEnabledIndex + delta + enabledIndexes.length) %
        enabledIndexes.length
    ] ?? -1
  );
}

export function getComboboxPlacement(
  anchor: ComboboxRect,
  popup: ComboboxSize,
  viewport: ComboboxViewport,
): ComboboxPlacement {
  const width = Math.min(
    Math.max(anchor.width, popup.width),
    Math.max(0, viewport.width - VIEWPORT_PADDING * 2),
  );
  const maxLeft = Math.max(
    VIEWPORT_PADDING,
    viewport.width - VIEWPORT_PADDING - width,
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
  return { left, top, width, maxHeight, placement };
}
