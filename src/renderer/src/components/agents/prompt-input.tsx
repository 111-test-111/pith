// local patch (pi-app): shared scalable typography for content and code.
// local patch (pi-app): keep UI frames and focus rings in this component at 1px.
"use client";
// beui.dev/components/agents/chat-app

// local patch (pi-app): use the shared Hugeicons icon adapter and size scale.
import { Ban, Plus, Send } from "@/lib/icons";
import { UI_ICON_SIZE } from "@/lib/icon-metrics";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type HTMLAttributes,
  type Ref,
  useState,
} from "react";
import { Button } from "@/components/motion/button";
import {
  MorphPopover,
  MorphPopoverContent,
  MorphPopoverTrigger,
} from "@/components/motion/popover-morph";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/motion/select";
import { SPRING_SWAP } from "@/lib/ease";
// local patch (pi-app): the height glide honours the app's own reduced motion
// switch (the vendored `useReducedMotion` above is the OS signal).
import { useReduceMotion } from "@/lib/reduce-motion";
// local patch (pi-app): native plaintext editing preserves selection and undo.
import { usePromptEditor, type PromptEditorHandle } from "@/lib/hooks/use-prompt-editor";
import { useScrollFade } from "@/lib/hooks/use-scroll-fade";
import { cn } from "@/lib/utils";

export interface PromptModel {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface PromptAction {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

// local patch (pi-app): events belong to the inline plaintext editing host.
export interface PromptInputProps extends Omit<
  HTMLAttributes<HTMLSpanElement>,
  "value" | "defaultValue" | "onChange" | "onSubmit" | "children"
> {
  // local patch (pi-app): the editable span exposes plain-text selection offsets.
  inputRef?: Ref<PromptEditorHandle>;
  disabled?: boolean;
  placeholder?: string;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  models?: PromptModel[];
  model?: string;
  defaultModel?: string;
  onModelChange?: (model: string) => void;
  actions?: PromptAction[];
  onAction?: (action: string) => void;
  onSubmit?: (value: string, model?: string) => void | Promise<void>;
  // local patch (pi-app): while `loading` (agent busy), submit routes here
  // instead of being dropped — Enter / the send button queue the message as a
  // steer or follow-up; the button then shows a queue arrow, not stop.
  onQueueSubmit?: (value: string, model?: string) => void | Promise<void>;
  loading?: boolean;
  // local patch (pi-app): wait for session tools without disabling draft editing.
  submitDisabled?: boolean;
  onStop?: () => void;
  minRows?: number;
  maxRows?: number;
  leadingAction?: ReactNode;
  // local patch (pi-app): contextIndicator slot so the app can mount its
  // context-usage ring immediately left of the send button (the controls
  // row's bottom-right cluster).
  contextIndicator?: ReactNode;
  // local patch (pi-app): attachment previews (images, file cards) render
  // INSIDE the frame, above the first text line — pasting grows the input
  // itself instead of stacking a strip above it.
  attachments?: ReactNode;
  className?: string;
}

export function PromptInput({
  inputRef,
  value,
  defaultValue = "",
  onValueChange,
  models = [],
  model,
  defaultModel,
  onModelChange,
  actions = [],
  onAction,
  onSubmit,
  onQueueSubmit,
  loading = false,
  submitDisabled = false,
  onStop,
  minRows = 2,
  maxRows = 8,
  leadingAction,
  contextIndicator,
  attachments,
  className,
  disabled,
  placeholder = "Ask the agent to do something…",
  "aria-label": ariaLabel = "Prompt",
  onKeyDown,
  ...editorProps
}: PromptInputProps) {
  const reduce = useReducedMotion() ?? false;
  // local patch (pi-app): the app-level reduced motion switch (not the OS signal
  // above) decides whether a draft's height change glides or lands instantly.
  const appReduceMotion = useReduceMotion();
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [internalModel, setInternalModel] = useState(
    defaultModel ?? models[0]?.value,
  );
  const [actionsOpen, setActionsOpen] = useState(false);
  const currentValue = value ?? internalValue;
  const currentModelValue = model ?? internalModel;
  const currentModel = models.find(
    (option) => option.value === currentModelValue,
  );
  const canSubmit = Boolean(currentValue.trim()) && !disabled && !submitDisabled && !loading;
  // local patch (pi-app): a non-empty draft can be queued while streaming.
  const canQueue = Boolean(onQueueSubmit) && Boolean(currentValue.trim()) && !disabled && !submitDisabled;

  const setValue = (next: string) => {
    if (value === undefined) setInternalValue(next);
    onValueChange?.(next);
  };
  // local patch (pi-app): Chromium owns editing/IME/undo.
  const editor = usePromptEditor({ value: currentValue, onValueChange: setValue, inputRef, minRows, maxRows });
  const { maskImage } = useScrollFade(editor.viewportRef, { contentRef: editor.contentRef });

  const setModel = (next: string) => {
    if (model === undefined) setInternalModel(next);
    onModelChange?.(next);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const prompt = currentValue.trim();
    if (!prompt || disabled || submitDisabled) return;
    if (loading) {
      if (!onQueueSubmit) return;
      onQueueSubmit(prompt, currentModelValue);
      editor.editorRef.current?.focus({ preventScroll: true });
      return;
    }

    onSubmit?.(prompt, currentModelValue);
    if (value === undefined) setInternalValue("");
    editor.editorRef.current?.focus({ preventScroll: true });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    onKeyDown?.(event);
    if (
      event.defaultPrevented ||
      event.key !== "Enter" ||
      event.shiftKey ||
      event.nativeEvent.isComposing
    ) {
      return;
    }
    event.preventDefault();
    submit();
  };

  return (
    <form
      onSubmit={submit}
      className={cn(
        "relative w-full rounded-2xl border border-border/80 bg-background p-2 transition-colors focus-within:border-foreground/25",
        disabled && "opacity-60",
        className,
      )}
    >
      {attachments ? (
        // local patch (pi-app): the tray sits in the frame's flow, so the
        // input grows by exactly the previews' height.
        <div className="mb-1 flex flex-wrap items-center gap-2 px-1 pt-0.5">
          {attachments}
        </div>
      ) : null}
      {/* local patch (pi-app): native inline flow replaces the textarea overlay. */}
      <div
        ref={editor.viewportRef}
        data-prompt-viewport=""
        onMouseDown={editor.onMouseDown}
        className="w-full overflow-y-auto bg-transparent px-2 pt-1.5 text-content text-foreground"
        style={{ maskImage, ...(appReduceMotion ? null : { transition: "height 120ms ease-out" }) }}
      >
        <div ref={editor.contentRef} className="whitespace-pre-wrap [overflow-wrap:anywhere]">
          {!currentValue ? <span aria-hidden="true" className="pointer-events-none absolute text-muted-foreground/55">{placeholder}</span> : null}
          <span
            {...editorProps}
            ref={editor.editorRef}
            data-prompt-editor=""
            // The stop-run Escape is the app dispatcher's only bare-key
            // command; it fires from THIS field (pi parity) but from no
            // other input (see shortcut-dispatcher).
            data-main-composer=""
            role="textbox"
            aria-multiline="true"
            aria-label={ariaLabel}
            aria-placeholder={placeholder}
            aria-disabled={disabled || undefined}
            contentEditable={disabled ? false : "plaintext-only"}
            suppressContentEditableWarning
            tabIndex={disabled ? -1 : 0}
            onInput={editor.onInput}
            onCompositionStart={editor.onCompositionStart}
            onCompositionEnd={editor.onCompositionEnd}
            onKeyDown={handleKeyDown}
            // local patch (pi-app): macOS Pinyin's English candidates can put
            // the selection past the preedit text. A block editing host keeps
            // Chromium from resolving that position into the next control.
            className="block pr-px outline-none"
          />
        </div>
      </div>

      <div className="mt-1 flex min-h-8 items-center gap-1">
        {actions.length ? (
          <MorphPopover open={actionsOpen} onOpenChange={setActionsOpen}>
            <MorphPopoverTrigger>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={disabled || loading}
                aria-label="Add to prompt"
                // local patch (pi-app): the icon control keeps the shared
                // control radius rather than a capsule; only the size is overridden.
                className="size-8"
              >
                <motion.span
                  aria-hidden="true"
                  animate={{ rotate: actionsOpen ? 45 : 0 }}
                  transition={reduce ? { duration: 0 } : SPRING_SWAP}
                >
                  <Plus className="size-4" />
                </motion.span>
              </Button>
            </MorphPopoverTrigger>

            <MorphPopoverContent
              side="top"
              align="start"
              sideOffset={8}
              // local patch (pi-app): the options surface consumes the theme scale.
              radius="var(--app-radius-card)"
              className="w-56 p-1.5"
            >
              {actions.map((action) => (
                <button
                  key={action.value}
                  type="button"
                  disabled={action.disabled}
                  onClick={() => {
                    onAction?.(action.value);
                    setActionsOpen(false);
                  }}
                  // local patch (pi-app): single-line rows — icon and entry
                  // name only, the second-line explanation is dropped.
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50"
                >
                  {action.icon ? (
                    <span className="grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                      {action.icon}
                    </span>
                  ) : null}
                  <span className="min-w-0 text-sm text-foreground">
                    {action.label}
                  </span>
                </button>
              ))}
            </MorphPopoverContent>
          </MorphPopover>
        ) : null}
        {leadingAction}
        {models.length ? (
          <Select
            value={currentModelValue}
            onValueChange={setModel}
            disabled={disabled || loading}
            className="min-w-0"
          >
            <SelectTrigger className="h-8 w-auto max-w-52 rounded-xl border-0 bg-transparent px-2 py-0 text-xs hover:bg-muted focus-visible:ring-1">
              <span className="flex min-w-0 items-center gap-1.5">
                {currentModel?.icon ? (
                  <span className="grid size-4 shrink-0 place-items-center text-muted-foreground [&_svg]:size-3.5">
                    {currentModel.icon}
                  </span>
                ) : null}
                <span className="truncate text-muted-foreground">
                  {currentModel?.label ?? "Choose model"}
                </span>
              </span>
            </SelectTrigger>
            <SelectContent className="right-auto w-52 shadow-none">
              {models.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  disabled={option.disabled}
                  className="py-2"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {option.icon ? (
                      <span className="grid size-5 shrink-0 place-items-center text-muted-foreground [&_svg]:size-4">
                        {option.icon}
                      </span>
                    ) : null}
                    <span className="min-w-0 truncate text-sm text-foreground">
                      {option.label}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        {/* local patch (pi-app): contextIndicator joins the send button in a
            right-aligned cluster — the ring sits immediately left of send at
            the controls row's bottom-right corner. */}
        <div className="ml-auto flex items-center gap-1.5">
          {contextIndicator}
          {/* local patch (pi-app): while loading, the button queues a non-empty
              draft (submit path) and only falls back to stop when it is empty —
              send doubles as queue-while-busy, like pi's TUI. */}
          {/* local patch (pi-app): the send control is a quiet glyph button, not
              a filled primary square — the shape only appears as a faded wash on
              hover, so the composer's corner stays calm. Send uses an accent
              glyph on the neutral button fill; stop uses the error red for both.
              It keeps the shared icon-control radius, not a capsule. */}
          <Button
            type={loading && !canQueue ? "button" : "submit"}
            variant="ghost"
            size="icon"
            disabled={loading && !canQueue ? !onStop : !canQueue && !canSubmit}
            aria-label={loading ? (canQueue ? "Queue message" : "Stop generating") : "Send prompt"}
            onClick={loading && !canQueue ? onStop : undefined}
            className={cn(
              "size-8 disabled:opacity-40",
              // local patch (pi-app): the stop state wears the error red —
              // glyph and frame wash alike — so the control never flashes the
              // accent under a red glyph, in either theme.
              loading && !canQueue
                ? "text-destructive hover:bg-destructive/10 hover:text-destructive"
                : "text-primary hover:bg-muted hover:text-primary",
            )}
          >
            <AnimatePresence initial={false} mode="popLayout">
              <motion.span
                key={loading ? (canQueue ? "queue" : "stop") : "send"}
                initial={reduce ? { opacity: 1 } : { opacity: 0, y: 3, scale: 0.8 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, y: -3, scale: 0.8 }}
                transition={reduce ? { duration: 0 } : SPRING_SWAP}
                className="grid place-items-center"
              >
                {loading && !canQueue ? (
                  // local patch (pi-app): send/stop share the 20px primary-action
                  // canvas. The stop wears the ban mark, stroked so it stays
                  // legible in the error red.
                  <Ban size={UI_ICON_SIZE.primary} />
                ) : (
                  <Send size={UI_ICON_SIZE.primary} />
                )}
              </motion.span>
            </AnimatePresence>
          </Button>
        </div>
      </div>
    </form>
  );
}
