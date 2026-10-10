// local patch (pi-app): keep UI frames and focus rings in this component at 1px.
"use client";

// local patch (pi-app): use the shared UI icon adapter.
import { ChevronsUpDown, Search } from "@/lib/icons";
import type {
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  Ref,
} from "react";
import { cn } from "@/lib/utils";
// local patch (pi-app): searchable fields share the sidebar filter style.
import { SINGLE_LINE_INPUT_PADDING, SINGLE_LINE_INPUT_TEXT } from "@/lib/input-style";
import { mergeRefs, useComboboxContext } from "./context";

export interface ComboboxTriggerProps {
  children: ReactNode;
  className?: string;
}

export function ComboboxTrigger({ children, className }: ComboboxTriggerProps) {
  const context = useComboboxContext("ComboboxTrigger");

  return (
    <div
      ref={context.triggerRef}
      id={context.triggerId}
      data-state={context.open ? "open" : "closed"}
      onPointerDown={(event) => {
        if (context.disabled || event.target === context.inputRef.current) return;
        event.preventDefault();
        context.inputRef.current?.focus({ preventScroll: true });
        context.setOpen(true);
      }}
      className={cn(
        // local patch (pi-app): a clickable picker fills on hover without a
        // painted or highlighted frame.
        // local patch (pi-app): share single-line field insets and grow with type.
        "relative z-20 flex w-full min-w-52 cursor-text items-center justify-between gap-3 rounded-xl border border-transparent bg-transparent text-foreground transition-colors hover:bg-muted",
        SINGLE_LINE_INPUT_TEXT,
        SINGLE_LINE_INPUT_PADDING,
        "focus-within:ring-1 focus-within:ring-foreground/20",
        context.disabled && "pointer-events-none opacity-50",
        className,
      )}
    >
      <span className="min-w-0 flex-1 text-left">{children}</span>
      <span aria-hidden className="shrink-0 text-muted-foreground">
        <ChevronsUpDown className="size-4" />
      </span>
    </div>
  );
}

export interface ComboboxValueProps {
  placeholder?: ReactNode;
  children?:
    | ReactNode
    | ((value: string | undefined, label: string | undefined) => ReactNode);
  className?: string;
}

export function ComboboxValue({
  placeholder = "Select an option",
  children,
  className,
}: ComboboxValueProps) {
  const context = useComboboxContext("ComboboxValue");
  const label = context.labelFor(context.value);
  const content =
    typeof children === "function"
      ? children(context.value, label)
      : children ?? label ?? placeholder;

  return (
    <span
      className={cn(
        "block truncate",
        context.value === undefined
          ? "text-muted-foreground"
          : "text-foreground",
        className,
      )}
    >
      {content}
    </span>
  );
}

export interface ComboboxInputProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    "defaultValue" | "value"
  > {
  ref?: Ref<HTMLInputElement>;
  wrapperClassName?: string;
}

export function ComboboxInput({
  ref,
  className,
  wrapperClassName,
  "aria-label": ariaLabel = "Search options",
  onChange,
  onClick,
  onFocus,
  onKeyDown,
  onPointerDown,
  placeholder = "Search…",
  ...props
}: ComboboxInputProps) {
  const context = useComboboxContext("ComboboxInput");
  const selectedLabel = context.labelFor(context.value);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      // Opening is the whole action. While closed the list is still filtering
      // by the query the last session left, so a step taken here would be
      // measured against rows the next render replaces — and stamped with a
      // query it no longer has, which discards it. Open onto the selection,
      // and let the next key step through the list the user can see.
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
      if (context.open) context.selectActive();
      else context.setOpen(true);
    } else if (event.key === "Escape" && context.open) {
      event.preventDefault();
      context.setOpen(false, true);
    }
  };

  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2",
        wrapperClassName,
      )}
    >
      <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
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
        value={context.open ? context.query : (selectedLabel ?? "")}
        placeholder={placeholder}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          if (event.defaultPrevented || context.open) return;
          event.preventDefault();
          context.inputRef.current?.focus({ preventScroll: true });
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
          // local patch (pi-app): the trigger supplies the shared vertical inset.
          "min-w-0 flex-1 bg-transparent py-0 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed",
          SINGLE_LINE_INPUT_TEXT,
          className,
        )}
      />
    </div>
  );
}
