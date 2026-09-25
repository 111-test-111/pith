// local patch (pi-app): keep UI frames and focus rings in this component at 1px.
"use client";
// beui.dev/components/motion/switch

import { animate, motion, MotionConfig, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

// Heavy, deliberate thumb — high mass keeps the travel weighty without wobble.
const THUMB_SPRING = { type: "spring", stiffness: 800, damping: 80, mass: 4 } as const;

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  ariaLabel?: string;
  className?: string;
  // local patch (pi-app): let a call site own the id so its own label element
  // can sit somewhere else in the row (the search filter orders info · text ·
  // switch) while still toggling the track on click.
  id?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  ariaLabel,
  className,
  id: idProp,
}: SwitchProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const thumbRef = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [isPressed, setIsPressed] = useState(false);
  const [isPointer, setIsPointer] = useState(false);

  // Disabled shake feedback when pressed.
  useEffect(() => {
    if (!thumbRef.current || reduce) return;
    if (disabled && isPressed) {
      animate(
        thumbRef.current,
        { x: [0, -2, 2, -1, 0] },
        { delay: 0.2, duration: 0.6 },
      );
    }
  }, [disabled, isPressed, reduce]);

  const squish = !disabled && isPointer && isPressed && !reduce;

  return (
    <MotionConfig transition={reduce ? { duration: 0 } : THUMB_SPRING}>
      <span className={cn("inline-flex items-center gap-3", className)}>
        <motion.button
          id={id}
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={ariaLabel}
          disabled={disabled}
          onClick={() => !disabled && onCheckedChange(!checked)}
          onPointerDown={(e) => {
            setIsPressed(true);
            setIsPointer(e.type.startsWith("pointer"));
          }}
          onPointerUp={() => setIsPressed(false)}
          onPointerLeave={() => setIsPressed(false)}
          initial={false}
          data-state={checked ? "checked" : "unchecked"}
          className={cn(
            // local patch (pi-app): compact track. The vendored 28×48 pill was
            // oversized for the app — it replaced a 20×20 checkbox that sits in
            // the same rows — so it is 20×32 with a 16px thumb: the 2px inset
            // and a 12px travel stay, and the two ends are square now.
            // local patch (pi-app): the app's square-style branch owns this
            // control's geometry, so the track keeps no radius at all.
            "group peer inline-flex h-5 w-8 shrink-0 cursor-pointer items-center rounded-control px-0.5 outline-none transition-colors duration-200",
            "focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            "disabled:cursor-not-allowed disabled:opacity-60",
            // local patch (pi-app): the state fill deepens on hover without
            // adding a track frame.
            checked ? "justify-end bg-primary hover:bg-primary/90" : "justify-start bg-muted-foreground/60 hover:bg-muted-foreground/80",
          )}
        >
          <motion.div
            ref={thumbRef}
            layout
            animate={{ scale: squish ? 0.9 : 1 }}
            className="pointer-events-none block size-4 rounded-control bg-background shadow-md"
          >
            {/* Stretch toward the destination while active. */}
            <div
              className={cn(
                "size-4",
                squish && (checked ? "ml-1" : "mr-1"),
              )}
            />
          </motion.div>
        </motion.button>
        {label ? (
          <label htmlFor={id} className="cursor-pointer text-sm text-foreground">
            {label}
          </label>
        ) : null}
      </span>
    </MotionConfig>
  );
}
