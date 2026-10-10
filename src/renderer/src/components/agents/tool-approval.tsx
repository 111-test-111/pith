// local patch (pi-app): shared scalable typography for UI annotations.
// local patch (pi-app): keep UI frames and focus rings in this component at 1px.
"use client";
// local patch (pi-app): approval status badges use the semantic item radius.
// beui.dev/components/agents/chat-app

// local patch (pi-app): use the shared UI icon adapter.
import {
  Check,
  ChevronDown,
  CircleAlert,
  LoaderCircle,
  ShieldCheck,
  X,
} from "@/lib/icons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  AgentCode,
  type AgentCodeLanguage,
} from "@/components/agents/agent-code";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
// local patch (pi-app): approval controls share beUI's standard button geometry.
import { Button } from "@/components/motion/button";
import { EASE_OUT, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type ToolApprovalStatus =
  | "pending"
  | "approving"
  | "approved"
  | "denied"
  | "running"
  | "complete"
  | "error";

export interface ToolApprovalParameter {
  id: string;
  label: ReactNode;
  value: ReactNode;
}

export interface ToolApprovalCodeProps {
  code: string;
  language?: AgentCodeLanguage;
  className?: string;
}

export interface ToolApprovalProps {
  // local patch (pi-app): wrappers may include the tool name in the title.
  tool?: ReactNode;
  // local patch (pi-app): app wrappers supply artwork, full details and copy.
  icon?: ReactNode;
  iconClassName?: string;
  children?: ReactNode;
  labels?: {
    status?: ReactNode;
    details?: ReactNode;
    approve?: ReactNode;
    alwaysAllow?: ReactNode;
    deny?: ReactNode;
  };
  title?: ReactNode;
  description?: ReactNode;
  parameters?: ToolApprovalParameter[];
  status?: ToolApprovalStatus;
  // local patch (pi-app): permission wrappers can keep full details visible.
  collapsible?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onApprove?: () => void;
  onAlwaysAllow?: () => void;
  onDeny?: () => void;
  className?: string;
}

function getStatusCopy(status: ToolApprovalStatus) {
  if (status === "approving") return "Approving";
  if (status === "approved") return "Approved";
  if (status === "denied") return "Denied";
  if (status === "running") return "Running";
  if (status === "complete") return "Completed";
  if (status === "error") return "Failed";
  return "Approval required";
}

function getStatusBadgeClass(status: ToolApprovalStatus) {
  if (status === "pending") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
  }
  if (status === "approving" || status === "running") {
    return "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400";
  }
  if (status === "approved" || status === "complete") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  }
  return "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400";
}

export function ToolApprovalCode({
  code,
  language = "bash",
  className,
}: ToolApprovalCodeProps) {
  return (
    <AgentCode
      code={code}
      language={language}
      className={cn(
        // Parameter values sit in a narrow grid column with nowhere to scroll
        // on touch, so they wrap instead of clipping (as ToolResultOutput does).
        "whitespace-pre-wrap break-words rounded-lg border border-border/50 bg-muted/30 px-2.5 py-2",
        className,
      )}
    />
  );
}

export function ToolApproval({
  tool,
  icon,
  iconClassName,
  children,
  labels,
  title = "Allow this tool to run?",
  description,
  parameters = [],
  status = "pending",
  collapsible = true,
  open,
  defaultOpen = false,
  onOpenChange,
  onApprove,
  onAlwaysAllow,
  onDeny,
  className,
}: ToolApprovalProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const detailsId = `${baseId}-details`;
  const previousStatus = useRef(status);
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const currentOpen = !collapsible || (open ?? internalOpen);
  const setOpen = useCallback(
    (next: boolean) => {
      if (open === undefined) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange, open],
  );
  const busy = status === "approving" || status === "running";
  const pending = status === "pending";
  const error = status === "error";

  useEffect(() => {
    if (previousStatus.current === "pending" && status !== "pending") {
      setOpen(false);
    }
    previousStatus.current = status;
  }, [setOpen, status]);

  return (
    <div
      data-state={status}
      aria-busy={busy}
      className={cn(
        "w-full overflow-hidden rounded-2xl border border-border/60 bg-muted/20 text-sm",
        className,
      )}
    >
      <div className="p-4">
        {/* local patch (pi-app): only the title shares the icon's row. */}
        <div className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden="true"
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-xl border border-border/60 bg-background text-muted-foreground",
              error && "text-destructive",
              iconClassName,
            )}
          >
            {busy ? (
              <LoaderCircle className={cn("size-4", !reduce && "animate-spin")} />
            ) : error ? (
              <CircleAlert className="size-4" />
            ) : status === "denied" ? (
              <X className="size-4" />
            ) : status === "approved" || status === "complete" ? (
              <Check className="size-4" />
            ) : (
              icon ?? <ShieldCheck className="size-4" />
            )}
          </span>

          <div className="min-w-0 flex-1 font-medium text-foreground">{title}</div>
          <span
            className={cn(
              "shrink-0 rounded-item border px-2 py-0.5 text-caption font-medium transition-colors",
              getStatusBadgeClass(status),
            )}
          >
            {labels?.status ?? getStatusCopy(status)}
          </span>
        </div>
        {tool ? (
          <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {tool}
          </div>
        ) : null}
        {description ? (
          <p className="mt-2 leading-ui text-muted-foreground">{description}</p>
        ) : null}

        {collapsible && (parameters.length || children) ? (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            aria-expanded={currentOpen}
            aria-controls={detailsId}
            onClick={() => setOpen(!currentOpen)}
            className="mt-2"
          >
            {labels?.details ?? "View details"}
            <motion.span
              aria-hidden="true"
              animate={{ rotate: currentOpen ? 180 : 0 }}
              transition={reduce ? { duration: 0 } : SPRING_SWAP}
            >
              <ChevronDown className="size-3.5" />
            </motion.span>
          </Button>
        ) : null}
      </div>

      <AgentDisclosure
        id={detailsId}
        open={currentOpen}
      >
        {children ?? <dl className="mx-4 mb-4 grid gap-2 rounded-xl border border-border/50 bg-background/70 p-3">
          {parameters.map((parameter) => (
            <div
              key={parameter.id}
              className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-3 text-xs"
            >
              <dt className="text-muted-foreground">{parameter.label}</dt>
              <dd className="min-w-0 break-words font-mono text-foreground/85">
                {parameter.value}
              </dd>
            </div>
          ))}
        </dl>}
      </AgentDisclosure>

      <AnimatePresence initial={false}>
        {pending ? (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0.12 : 0.22, ease: EASE_OUT }}
            className="flex flex-wrap items-center gap-2 border-t border-border/60 px-4 py-3"
          >
            <Button
              size="sm"
              type="button"
              onClick={onApprove}
            >
              {labels?.approve ?? "Allow once"}
            </Button>
            {onAlwaysAllow ? (
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={onAlwaysAllow}
              >
                {labels?.alwaysAllow ?? "Always allow"}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={onDeny}
            >
              {labels?.deny ?? "Deny"}
            </Button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
