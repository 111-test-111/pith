// local patch (pi-app): keep UI frames and focus rings in this component at 1px.
"use client";
// beui.dev/components/motion/multi-select

// local patch (pi-app): glyphs come from the app's icon adapter
// (lib/icons.tsx), which uses Hugeicons Stroke Rounded in both interface styles.
import { ChevronsUpDown, Search, X } from "@/lib/icons";
import { AnimatePresence, motion } from "motion/react";
import type {
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  Ref,
} from "react";
import { EASE_OUT, SPRING_LAYOUT, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";
// local patch (pi-app): searchable fields share the sidebar filter style.
import { SINGLE_LINE_INPUT_PADDING, SINGLE_LINE_INPUT_TEXT } from "@/lib/input-style";
import { mergeRefs, useMultiSelectContext } from "./context";

export interface MultiSelectTriggerProps {
  children: ReactNode;
  className?: string;
}

export function MultiSelectTrigger({
  children,
  className,
}: MultiSelectTriggerProps) {
  const context = useMultiSelectContext("MultiSelectTrigger");

  return (
    <div
      ref={context.triggerRef}
      id={context.triggerId}
      data-state={context.open ? "open" : "closed"}
      onPointerDown={(event) => {
        const target = event.target as HTMLElement;
        if (
          context.disabled ||
          target === context.inputRef.current ||
          target.closest("[data-multi-select-remove]")
        ) {
          return;
        }
        event.preventDefault();
        context.inputRef.current?.focus({ preventScroll: true });
        context.setOpen(true);
      }}
      className={cn(
        // local patch (pi-app): pointer hover fills the picker without a
        // highlighted frame; focus remains visible for keyboard entry.
        // local patch (pi-app): match single-line field insets, including empty pickers.
        "relative z-20 flex w-full min-w-52 cursor-text items-center gap-2 rounded-xl border border-transparent bg-transparent text-foreground transition-colors",
        SINGLE_LINE_INPUT_TEXT,
        SINGLE_LINE_INPUT_PADDING,
        "hover:bg-muted focus-within:ring-1 focus-within:ring-ring",
        context.disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
        {children}
      </div>
      <ChevronsUpDown
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
      />
    </div>
  );
}

export interface MultiSelectValueProps {
  placeholder?: ReactNode;
  children?: (value: string, label: string) => ReactNode;
  className?: string;
  chipClassName?: string;
}

export function MultiSelectValue({
  placeholder = "Select options",
  children,
  className,
  chipClassName,
}: MultiSelectValueProps) {
  const context = useMultiSelectContext("MultiSelectValue");
  const showPlaceholder = context.values.length === 0 && !context.open;

  return (
    <div className={cn("contents", className)}>
      <AnimatePresence initial={false} mode="popLayout">
        {showPlaceholder ? (
          <span key="multi-select-placeholder" className="text-muted-foreground">
            {placeholder}
          </span>
        ) : null}
        {context.values.map((value) => {
          const label = context.labelFor(value);
          return (
            <motion.span
              layout={context.reduce ? false : "position"}
              key={`multi-select-value-${value}`}
              // local patch (pi-app): the chip is a continuous surface, so it
              // animates opacity + transform only. The vendored circular clip
              // reveal cut the squircle off and is banned by the corner policy;
              // the chip's own `rounded-lg` carries the corner.
              initial={{
                opacity: 0,
                transform: context.reduce
                  ? "translateY(0px) scale(1)"
                  : "translateY(6px) scale(0.92)",
              }}
              animate={{
                opacity: 1,
                transform: "translateY(0px) scale(1)",
              }}
              exit={{
                opacity: 0,
                transform: context.reduce
                  ? "translateY(0px) scale(1)"
                  : "translateY(-4px) scale(0.96)",
                transition: { duration: 0.14, ease: EASE_OUT },
              }}
              transition={
                context.reduce
                  ? {
                      layout: { duration: 0 },
                      opacity: { duration: 0.15, ease: EASE_OUT },
                      transform: { duration: 0 },
                    }
                  : {
                      layout: SPRING_LAYOUT,
                      opacity: { duration: 0.18, ease: EASE_OUT },
                      transform: SPRING_SWAP,
                    }
              }
              className={cn(
                "inline-flex h-7 max-w-full items-center gap-1 rounded-lg bg-muted px-2 text-xs font-medium text-foreground",
                chipClassName,
              )}
            >
              <span className="truncate">
                {children ? children(value, label) : label}
              </span>
              <button
                type="button"
                data-multi-select-remove=""
                aria-label={`Remove ${label}`}
                disabled={context.disabled}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  context.remove(value);
                  context.inputRef.current?.focus({ preventScroll: true });
                }}
                className="-mr-1 grid size-5 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </motion.span>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

export interface MultiSelectInputProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "defaultValue" | "value"
  > {
  ref?: Ref<HTMLInputElement>;
  showIcon?: boolean;
}

export function MultiSelectInput({
  ref,
  className,
  "aria-label": ariaLabel = "Search options",
  onChange,
  onClick,
  onFocus,
  onKeyDown,
  onPointerDown,
  placeholder = "Search…",
  showIcon = false,
  ...props
}: MultiSelectInputProps) {
  const context = useMultiSelectContext("MultiSelectInput");

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    if (event.key === "Backspace" && !context.query && context.values.length) {
      event.preventDefault();
      context.remove(context.values.at(-1) ?? "");
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!context.open) {
        context.setOpen(true);
        return;
      }
      context.moveActive(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" && context.open) {
      event.preventDefault();
      context.moveActive("first");
    } else if (event.key === "End" && context.open) {
      event.preventDefault();
      context.moveActive("last");
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (context.open) context.toggleActive();
      else context.setOpen(true);
    } else if (event.key === "Escape" && context.open) {
      event.preventDefault();
      context.setOpen(false, true);
    }
  };

  return (
    <div className="flex min-w-20 flex-1 items-center gap-1.5">
      {showIcon ? (
        <Search aria-hidden="true" className="size-3.5 text-muted-foreground" />
      ) : null}
      <input
        {...props}
        ref={mergeRefs(ref, context.inputRef)}
        id={context.inputId}
        role="combobox"
        aria-label={ariaLabel}
        aria-autocomplete="list"
        aria-expanded={context.open}
        aria-controls={context.listId}
        aria-activedescendant={
          context.open ? context.activeItemId : undefined
        }
        autoComplete="off"
        disabled={context.disabled}
        value={context.query}
        placeholder={context.values.length ? "" : placeholder}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          if (event.defaultPrevented || context.open) return;
          context.setOpen(true);
        }}
        onFocus={(event) => {
          context.setOpen(true);
          onFocus?.(event);
        }}
        onClick={(event) => {
          context.setOpen(true);
          onClick?.(event);
        }}
        onChange={(event) => {
          context.setOpen(true);
          context.setQuery(event.target.value);
          onChange?.(event);
        }}
        onKeyDown={handleKeyDown}
        className={cn(
          // local patch (pi-app): chips may wrap; the input itself keeps one natural line.
          "min-w-12 flex-1 bg-transparent py-0 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
          SINGLE_LINE_INPUT_TEXT,
          className,
        )}
      />
    </div>
  );
}
