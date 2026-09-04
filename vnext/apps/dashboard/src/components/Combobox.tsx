import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  filterComboboxOptions,
  getComboboxPlacement,
  getInitialActiveOptionIndex,
  moveActiveOption,
  type ComboboxOption,
  type ComboboxPlacement,
} from "./combobox-state";

export interface ComboboxProps {
  value: string;
  options: ComboboxOption[];
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
  ariaInvalid?: boolean;
  ariaDescribedBy?: string;
  noMatchesText: string;
}

const EMPTY_PLACEMENT: ComboboxPlacement = {
  left: 0,
  top: 0,
  width: 0,
  maxHeight: 0,
  placement: "below",
};

export function Combobox({
  value,
  options,
  onChange,
  placeholder,
  ariaLabel,
  disabled = false,
  ariaInvalid = false,
  ariaDescribedBy,
  noMatchesText,
}: ComboboxProps) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [placement, setPlacement] = useState(EMPTY_PLACEMENT);
  const selected = options.find((option) => option.value === value);
  const filteredOptions = useMemo(
    () => filterComboboxOptions(options, query),
    [options, query],
  );

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  const positionPopup = () => {
    const anchor = rootRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const viewport = window.visualViewport;
    const viewportWidth = viewport?.width ?? window.innerWidth;
    const viewportHeight = viewport?.height ?? window.innerHeight;
    const popupHeight = popupRef.current?.getBoundingClientRect().height ?? 256;
    setPlacement(
      getComboboxPlacement(
        anchor,
        { width: anchor.width, height: popupHeight },
        { width: viewportWidth, height: viewportHeight },
      ),
    );
  };

  const openMenu = () => {
    if (disabled) return;
    setQuery("");
    setActiveIndex(getInitialActiveOptionIndex(options, value));
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    positionPopup();
  }, [open, filteredOptions.length]);

  useEffect(() => {
    if (!open) return;
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        !rootRef.current?.contains(target) &&
        !popupRef.current?.contains(target)
      )
        close();
    };
    const handleViewportChange = () => positionPopup();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(handleViewportChange);
    if (rootRef.current) observer?.observe(rootRef.current);
    if (popupRef.current) observer?.observe(popupRef.current);
    document.addEventListener("pointerdown", handleOutsidePointer, true);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    window.visualViewport?.addEventListener("resize", handleViewportChange);
    window.visualViewport?.addEventListener("scroll", handleViewportChange);
    return () => {
      observer?.disconnect();
      document.removeEventListener("pointerdown", handleOutsidePointer, true);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.visualViewport?.removeEventListener(
        "resize",
        handleViewportChange,
      );
      window.visualViewport?.removeEventListener(
        "scroll",
        handleViewportChange,
      );
    };
  }, [open]);

  useEffect(() => {
    if (activeIndex >= filteredOptions.length)
      setActiveIndex(getInitialActiveOptionIndex(filteredOptions, value));
  }, [activeIndex, filteredOptions, value]);

  const choose = (option: ComboboxOption) => {
    if (option.disabled) return;
    onChange(option.value);
    close();
    inputRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        close();
      }
      return;
    }
    if (event.key === "Enter") {
      if (!open) {
        event.preventDefault();
        openMenu();
        return;
      }
      const active = filteredOptions[activeIndex];
      if (active && !active.disabled) {
        event.preventDefault();
        choose(active);
      }
      return;
    }
    if (
      event.key !== "ArrowDown" &&
      event.key !== "ArrowUp" &&
      event.key !== "Home" &&
      event.key !== "End"
    )
      return;
    event.preventDefault();
    if (!open) {
      openMenu();
      return;
    }
    let nextIndex = moveActiveOption(
      activeIndex,
      filteredOptions.length,
      event.key,
    );
    while (nextIndex >= 0 && filteredOptions[nextIndex]?.disabled) {
      const candidate = moveActiveOption(
        nextIndex,
        filteredOptions.length,
        event.key,
      );
      if (candidate === nextIndex) break;
      nextIndex = candidate;
    }
    setActiveIndex(nextIndex);
    const activeOptionId = `${listboxId}-option-${nextIndex}`;
    document
      .getElementById(activeOptionId)
      ?.scrollIntoView({ block: "nearest" });
  };

  const popup = open ? (
    <div
      ref={popupRef}
      id={listboxId}
      role="listbox"
      aria-label={ariaLabel}
      data-placement={placement.placement}
      className="fixed z-[90] overflow-y-auto rounded-md border border-white/10 bg-surface-800 shadow-xl [scrollbar-width:thin]"
      style={{
        left: placement.left,
        top: placement.top,
        width: placement.width,
        maxHeight: placement.maxHeight,
      }}
    >
      {filteredOptions.length === 0 ? (
        <p className="px-3 py-2 text-xs text-themed-dim">{noMatchesText}</p>
      ) : (
        filteredOptions.map((option, index) => (
          <button
            id={`${listboxId}-option-${index}`}
            key={option.value}
            type="button"
            role="option"
            aria-selected={option.value === value}
            disabled={option.disabled}
            onClick={() => choose(option)}
            className={`w-full px-3 py-2 text-left text-xs ${option.disabled ? "cursor-not-allowed opacity-50" : "hover:bg-surface-600"} ${index === activeIndex ? "bg-surface-600" : ""} ${option.value === value ? "text-accent-violet" : "text-themed-secondary"}`}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate">{option.label}</span>
              {option.badge ? (
                <span className="max-w-[45%] shrink-0 truncate rounded bg-accent-teal/10 px-1.5 py-0.5 text-[10px] text-accent-teal">
                  {option.badge}
                </span>
              ) : null}
            </span>
          </button>
        ))
      )}
    </div>
  ) : null;

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        value={open ? query : (selected?.label ?? value)}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-activedescendant={
          open && activeIndex >= 0
            ? `${listboxId}-option-${activeIndex}`
            : undefined
        }
        aria-invalid={ariaInvalid || undefined}
        aria-describedby={ariaDescribedBy}
        onFocus={openMenu}
        onClick={openMenu}
        onChange={(event) => {
          if (!open) setOpen(true);
          setQuery(event.target.value);
          setActiveIndex(
            getInitialActiveOptionIndex(
              filterComboboxOptions(options, event.target.value),
              value,
            ),
          );
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded-md border border-white/10 bg-surface-800 px-2.5 py-1.5 text-xs text-themed-secondary outline-none focus:border-accent-violet/50 disabled:cursor-not-allowed disabled:opacity-60"
      />
      {popup ? createPortal(popup, document.body) : null}
    </div>
  );
}
