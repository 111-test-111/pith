"use client";
// beui.dev/components/motion/range-slider

import {
  motion,
  useMotionValue,
  useSpring,
  useTransform,
} from "motion/react";
import { useEffect, useLayoutEffect, useState } from "react";

import { SPRING_GLIDE } from "@/lib/ease";
import { type SliderOptions, useSlider } from "@/lib/hooks/use-slider";
import { TOUCH_GESTURE_CLASS } from "@/lib/touch";
// local patch (pi-app): compose the app's live motion preference with the OS.
import { useReduceMotion, useSystemReducedMotion } from "@/lib/reduce-motion";
import { cn } from "@/lib/utils";

export interface RangeSliderProps extends SliderOptions {
  /** Render a tick dot at each step. */
  showTicks?: boolean;
  className?: string;
}

// local patch (pi-app): slim media rail — a 12px disc whose centre travels
// between the rail ends replaces the old filled track and capsule handle.
const THUMB = 12;

export function RangeSlider({ showTicks = true, className, ...options }: RangeSliderProps) {
  const appReduce = useReduceMotion();
  const systemReduce = useSystemReducedMotion();
  const reduce = appReduce || systemReduce;
  const { percent, min, max, step, dragging, trackProps, sliderProps } = useSlider(options);
  const [trackWidth, setTrackWidth] = useState(292);
  useLayoutEffect(() => {
    const track = trackProps.ref.current;
    if (!track) return;
    const measure = () => {
      const width = track.getBoundingClientRect().width;
      if (width > 0) setTrackWidth(width);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [trackProps.ref]);

  // Spring-smoothed position drives both the thumb and the fill.
  const target = useMotionValue(percent);
  useEffect(() => {
    target.set(percent);
  }, [percent, target]);
  const smooth = useSpring(target, SPRING_GLIDE);
  const pos = reduce ? target : smooth;
  const travel = Math.max(0, trackWidth - THUMB);
  const thumbX = useTransform(pos, (p) => (travel * p) / 100);
  // The fill is a full-width bar clipped by the rail, translated so its right
  // edge tracks the handle centre — the rounded cap never stretches.
  const fillX = useTransform(pos, (p) => (travel * p) / 100 + THUMB / 2 - trackWidth);

  // Floor rather than round, so a range the step does not divide (0 to 10 by 4)
  // stops its dots at the last whole step instead of drawing one past max.
  // toFixed comes first because 0.3/0.1 is 2.9999999999999996, which would
  // floor to 2 and drop the last dot.
  const steps = Math.floor(Number(((max - min) / step).toFixed(6)));
  const ticks =
    showTicks && steps > 0 && steps <= 50
      ? Array.from({ length: steps + 1 }, (_, i) => Number((min + i * step).toFixed(6)))
      : [];

  return (
    <div
      {...trackProps}
      className={cn(
        "group relative flex h-5 w-full touch-none items-center",
        TOUCH_GESTURE_CLASS,
        options.disabled
          ? "pointer-events-none opacity-50"
          : "cursor-pointer",
        className,
      )}
    >
      {/* The rail carries the clipped accent fill; both stay hairline-thin. */}
      <div aria-hidden="true" className="relative h-1 w-full overflow-hidden rounded-full bg-foreground/10">
        <motion.div className="absolute inset-0 rounded-full bg-primary" style={{ x: fillX }} />
      </div>

      {/* Tick centres follow the same travel path as the handle centre. */}
      <div className="pointer-events-none absolute inset-x-[6px] inset-y-0">
        {ticks.map((t) => {
          const tp = ((t - min) / (max - min)) * 100;
          return (
            <span
              key={t}
              className="absolute top-1/2 size-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/25"
              style={{ left: `${tp}%` }}
            />
          );
        })}
      </div>

      {/* The disc grows under the pointer and while dragged. The scale lives
          on an inner element: a native `scale` on the positioned element would
          multiply the motion translation and fling the disc sideways. */}
      <motion.div
        {...sliderProps}
        // local patch (pi-app): controls retain their geometry during dragging.
        className="absolute left-0 top-1/2 size-3 outline-none"
        style={{ x: thumbX, y: "-50%" }}
      >
        <div
          className={cn(
            "size-full rounded-full bg-primary shadow-sm ring-ring ring-offset-1 ring-offset-background group-focus-within:ring-1",
            !reduce && "transition-[scale] duration-150",
            dragging ? "scale-125" : !reduce && "group-hover:scale-110",
          )}
        />
      </motion.div>
    </div>
  );
}
