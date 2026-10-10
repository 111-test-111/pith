// local patch (pi-app): shared scalable typography for UI line metrics.
"use client";

// local patch (pi-app): animate shared UI artwork through the SVG adapter.
import { AnimatedIcon } from "@/lib/animated-icons";

import {
  AnimatePresence,
  animate,
  motion,
  useReducedMotion,
} from "motion/react";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";
// local patch (pi-app): all single-line fields share the sidebar filter style.
import { SINGLE_LINE_INPUT_PADDING, SINGLE_LINE_INPUT_TEXT } from "@/lib/input-style";

export type InputClassNames = {
  root?: string;
  label?: string;
  field?: string;
  input?: string;
  leftIcon?: string;
  rightIcon?: string;
  successIcon?: string;
  errorMessage?: string;
};

export interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "defaultValue" | "onChange"
> {
  label?: string;
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /** Truthy error triggers a shake, red border and (if a string) a message. */
  error?: string | boolean;
  /** Reserve one message line so validation does not shift nearby content. */
  reserveErrorLine?: boolean;
  success?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  className?: string;
  classNames?: InputClassNames;
  // local patch (pi-app): render a multiline <textarea> with the same field
  // chrome instead of an <input> (beUI ships no textarea component).
  multiline?: boolean;
  // local patch (pi-app): visible rows for the multiline variant.
  rows?: number;
  // local patch (pi-app): attachment previews (images, file cards) render
  // INSIDE the multiline field's frame, above the first text line — pasting
  // grows the field itself instead of stacking a strip below it.
  attachments?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    value: valueProp,
    defaultValue,
    onChange,
    onFocus,
    onBlur,
    error,
    reserveErrorLine = false,
    success,
    leftIcon,
    rightIcon,
    className,
    classNames,
    disabled,
    id: idProp,
    type,
    multiline = false,
    rows = 6,
    attachments,
    ...rest
  },
  ref,
) {
  const reactId = useId();
  const id = idProp ?? reactId;
  const reduce = useReducedMotion();

  const controlled = valueProp !== undefined;
  const [internal, setInternal] = useState(defaultValue ?? "");
  const value = controlled ? (valueProp ?? "") : internal;

  const [focused, setFocused] = useState(false);

  const fieldRef = useRef<HTMLDivElement>(null);

  const hasError = Boolean(error);
  const errorMessage = typeof error === "string" ? error : null;

  // Right edge shows the success check, otherwise the caller's right icon.
  const rightSlot = success ? null : rightIcon;
  // local patch (pi-app): use the textarea's own computed line box. Message
  // editing follows content size, while record fields follow interface size.
  const multilineHeight = `calc(${rows} * 1lh)`;

  // Shake the field when an error appears.
  useEffect(() => {
    if (!fieldRef.current || reduce || !hasError) return;
    animate(
      fieldRef.current,
      { x: [0, -6, 6, -4, 4, -2, 0] },
      { duration: 0.45 },
    );
  }, [hasError, reduce]);

  const handleChange = (next: string) => {
    if (!controlled) setInternal(next);
    onChange?.(next);
  };

  return (
    <div
      className={cn("flex flex-col gap-1.5", className, classNames?.root)}
    >
      {label ? (
        <label
          htmlFor={id}
          className={cn(
            "px-1 text-sm font-medium text-foreground",
            classNames?.label,
          )}
        >
          {label}
        </label>
      ) : null}

      <div
        ref={fieldRef}
        data-state={
          hasError
            ? "error"
            : success
              ? "success"
              : focused
                ? "focused"
                : "idle"
        }
        className={cn(
          "relative border transition-colors duration-200",
          // local patch (pi-app): the multiline variant grows with its rows
          // instead of keeping the pill's fixed height and rounding, and its
          // vertical padding lives on the field so the <textarea> box itself
          // is exactly `rows` lines tall and clips at a line boundary.
          // local patch (pi-app): fields use the shared continuous control corner.
          // local patch (pi-app): single-line height comes from the text and
          // shared vertical inset, so compact and enlarged type both fit.
          multiline ? "rounded-card py-3" : "overflow-hidden rounded-control",
          // local patch (pi-app): hover/focus share one thin outer highlight;
          // its transparent border preserves the field's size without doubling.
          focused && !hasError ? "field-highlight" : "border-border",
          !disabled && !hasError && "hover:field-highlight",
          hasError && "border-transparent ring-1 ring-destructive",
          disabled && "opacity-60",
          classNames?.field,
        )}
      >
        {leftIcon ? (
          <span
            className={cn(
              "pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center text-muted-foreground [&_svg]:h-4 [&_svg]:w-4",
              // local patch (pi-app): single-line icons follow the shared inset.
              multiline ? "left-3" : "left-3.5",
              classNames?.leftIcon,
            )}
          >
            {leftIcon}
          </span>
        ) : null}

        {multiline && attachments ? (
          // local patch (pi-app): the tray sits in the field's flow, so the
          // field grows by exactly the previews' height. px-3.5 matches the
          // textarea's own inset, so cards align with the text below.
          <div className="mb-2 flex flex-wrap items-center gap-2 px-3.5">
            {attachments}
          </div>
        ) : null}

        {multiline ? (
          <textarea
            ref={ref as unknown as Ref<HTMLTextAreaElement>}
            id={id}
            rows={rows}
            value={value}
            disabled={disabled}
            aria-invalid={hasError || undefined}
            aria-describedby={errorMessage ? `${id}-error` : undefined}
            {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)}
            style={{ height: multilineHeight }}
            onChange={(e) => handleChange(e.target.value)}
            onFocus={(event) => {
              setFocused(true);
              onFocus?.(event as unknown as FocusEvent<HTMLInputElement>);
            }}
            onBlur={(event) => {
              setFocused(false);
              onBlur?.(event as unknown as FocusEvent<HTMLInputElement>);
            }}
            className={cn(
              // local patch (pi-app): use the surrounding body size by default;
              // compact surfaces can still pass text-xs through classNames.input.
              "peer block w-full resize-none bg-transparent py-0 text-sm leading-ui-loose text-foreground caret-foreground outline-none",
              "placeholder:text-muted-foreground/60",
              leftIcon ? "pl-10" : "pl-3.5",
              rightSlot || success ? "pr-10" : "pr-3.5",
              disabled && "cursor-not-allowed",
              classNames?.input,
            )}
          />
        ) : (
          <input
            ref={ref}
            id={id}
            type={type}
            value={value}
            disabled={disabled}
            aria-invalid={hasError || undefined}
            aria-describedby={errorMessage ? `${id}-error` : undefined}
            {...rest}
            onChange={(e) => handleChange(e.target.value)}
            onFocus={(event) => {
              setFocused(true);
              onFocus?.(event);
            }}
            onBlur={(event) => {
              setFocused(false);
              onBlur?.(event);
            }}
            className={cn(
              // local patch (pi-app): text and numeric fields use the same
              // sidebar-sized text and padding, with room for optional icons.
              "peer block w-full bg-transparent text-foreground caret-foreground outline-none",
              SINGLE_LINE_INPUT_TEXT,
              SINGLE_LINE_INPUT_PADDING,
              "placeholder:text-muted-foreground/60",
              leftIcon && "pl-10",
              (rightSlot || success) && "pr-10",
              disabled && "cursor-not-allowed",
              classNames?.input,
            )}
          />
        )}

        {success ? (
          <AnimatedIcon
            icon="check"
            draw={{
              initial: reduce ? { pathLength: 1 } : { pathLength: 0 },
              animate: { pathLength: 1 },
              transition: { duration: 0.35, ease: "easeOut" },
            }}
            viewBox="0 0 24 24"
            fill="none"
            className={cn(
              "absolute right-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-(--color-success)",
              classNames?.successIcon,
            )}
          />
        ) : rightSlot ? (
          <span
            className={cn(
              "absolute right-0 top-0 flex h-full items-center text-muted-foreground [&_button]:grid [&_button]:place-items-center [&_svg]:h-4 [&_svg]:w-4",
              // local patch (pi-app): single-line actions fit the text-driven
              // field height; multiline actions retain their existing canvas.
              multiline ? "[&_button]:size-11" : "[&_button]:h-full [&_button]:w-9",
              classNames?.rightIcon,
            )}
          >
            {rightSlot}
          </span>
        ) : null}
      </div>

      <div className={reserveErrorLine ? "min-h-4" : "contents"}>
        <AnimatePresence initial={false}>
          {errorMessage ? (
            <motion.p
              id={`${id}-error`}
              role="alert"
              initial={
                reduce
                  ? { opacity: 0 }
                  : { opacity: 0, y: -4, filter: "blur(4px)" }
              }
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={
                reduce
                  ? { opacity: 0 }
                  : { opacity: 0, y: -4, filter: "blur(4px)" }
              }
              transition={{ duration: 0.2 }}
              className={cn(
                "px-1 text-xs text-destructive",
                classNames?.errorMessage,
              )}
            >
              {errorMessage}
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
});
