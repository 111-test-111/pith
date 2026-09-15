"use client";
// beui.dev/components/motion/tilt-card

import { motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import { useRef, type ReactNode } from "react";
import { SPRING_MOUSE } from "@/lib/ease";
import { useHoverCapable } from "@/lib/hooks/use-hover-capable";
import { cn } from "@/lib/utils";

export interface TiltCardProps {
  children: ReactNode;
  max?: number;
  glare?: boolean;
  /**
   * local patch (pi-app): glare strength. The registry painted every card's
   * radial wash at a fixed 15%, which reads as a dark smudge across the text
   * of a light-themed card; the new-chat starter cards use a lighter one.
   */
  glareOpacity?: number;
  /**
   * local patch (pi-app): glare color. The registry always lit the card with
   * `--foreground` (white in dark mode, near-black in light mode); the new-chat
   * starter cards wash in the app's accent instead.
   */
  glareColor?: string;
  className?: string;
}

export function TiltCard({
  children,
  max = 12,
  glare = true,
  glareOpacity = 0.15,
  glareColor = "var(--foreground)",
  className,
}: TiltCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const canHover = useHoverCapable();
  // Decorative cursor-follow: skip on touch (phantom hover) and reduced motion.
  const enabled = !reduce && canHover;
  const rx = useMotionValue(0);
  const ry = useMotionValue(0);
  const gx = useMotionValue(50);
  const gy = useMotionValue(50);

  const srx = useSpring(rx, SPRING_MOUSE);
  const sry = useSpring(ry, SPRING_MOUSE);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el || !enabled) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    ry.set((px - 0.5) * max);
    rx.set((0.5 - py) * max);
    gx.set(px * 100);
    gy.set(py * 100);
  };

  const onLeave = () => {
    rx.set(0);
    ry.set(0);
  };

  const transform = useMotionTemplate`perspective(1000px) rotateX(${srx}deg) rotateY(${sry}deg)`;
  const glareBg = useMotionTemplate`radial-gradient(circle at ${gx}% ${gy}%, ${glareColor}, transparent 50%)`;

  return (
    <motion.div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={{ transform, transformStyle: "preserve-3d" }}
      className={cn("relative overflow-hidden rounded-2xl will-change-transform", className)}
    >
      {children}
      {glare && enabled ? (
        <motion.div
          aria-hidden
          style={{ background: glareBg, opacity: glareOpacity }}
          className="pointer-events-none absolute inset-0"
        />
      ) : null}
    </motion.div>
  );
}
