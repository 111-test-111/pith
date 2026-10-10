import { useCallback, useImperativeHandle, useLayoutEffect, useRef, type MouseEvent, type Ref } from 'react'

/** Plain-text offsets only: the mode chip is a sibling, never part of the draft. */
export interface PromptEditorHandle {
  readonly value: string
  readonly selectionStart: number
  focus: (options?: FocusOptions) => void
  replaceRange: (start: number, end: number, text: string) => void
}

/** Chromium represents the final caret host as either BR or LF (notably
 * after native paste). innerText includes it in both cases; it isn't a draft
 * newline. An intentional trailing newline has a second, empty caret line. */
function readText(editor: HTMLElement): string {
  return editor.innerText.replace(/\n$/, '')
}

function selectionOffsets(editor: HTMLElement): [number, number] | null {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null
  const before = document.createRange()
  before.selectNodeContents(editor)
  before.setEnd(range.startContainer, range.startOffset)
  const start = before.toString().length
  return [start, start + range.toString().length]
}

function selectOffsets(editor: HTMLElement, start: number, end: number) {
  const point = (offset: number): [Node, number] => {
    const end: [Node, number] = [editor, Math.max(0, editor.childNodes.length - 1)]
    if (offset >= readText(editor).length && editor.lastChild?.nodeName === 'BR') return end
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let remaining = Math.max(0, offset)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) return [node, remaining]
      remaining -= length
    }
    // The final BR is the browser's empty-line caret host, not draft content.
    return end
  }
  const range = document.createRange()
  range.setStart(...point(start))
  range.setEnd(...point(end))
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/**
 * Native plaintext editing for beUI's PromptInput. React owns the chip/chrome;
 * Chromium owns the editable subtree, selection, IME and undo transactions.
 * A trailing BR gives even an empty draft/last line a real caret position.
 * No app sentinel characters, synthetic indent, measurement mirror or
 * per-input DOM rebuild. readText omits only the browser's final caret host.
 */
export function usePromptEditor({ value, onValueChange, inputRef, minRows, maxRows }: {
  value: string
  onValueChange: (value: string) => void
  inputRef?: Ref<PromptEditorHandle>
  minRows: number
  maxRows: number
}) {
  const editorRef = useRef<HTMLSpanElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const composing = useRef(false)

  useImperativeHandle(inputRef, () => ({
    get value() { return editorRef.current ? readText(editorRef.current) : '' },
    get selectionStart() {
      const editor = editorRef.current
      return editor ? Math.min(selectionOffsets(editor)?.[0] ?? readText(editor).length, readText(editor).length) : 0
    },
    focus: options => editorRef.current?.focus(options),
    replaceRange: (start, end, text) => {
      const editor = editorRef.current
      if (!editor?.isContentEditable) return
      editor.focus({ preventScroll: true })
      selectOffsets(editor, start, end)
      // Chromium's editing command commits text + selection + undo together
      // and emits the same input event as typing. A delayed React rewrite
      // followed by rAF selection would race the user's next keystroke.
      document.execCommand('insertText', false, text)
    }
  }), [])

  // Only an external reset (send/recall/attachment removal) replaces the DOM.
  // An echoed input must leave native undo and an active composition intact.
  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor || composing.current) return
    if (editor.childNodes.length && readText(editor) === value) return
    const selection = selectionOffsets(editor)
    editor.replaceChildren(...(value ? [document.createTextNode(value)] : []), document.createElement('br'))
    if (selection) selectOffsets(editor, Math.min(selection[0], value.length), Math.min(selection[1], value.length))
  }, [value])

  useLayoutEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    // At the draft boundary there is no character to delete. Chromium may
    // otherwise consume the caret-host BR itself. Keep this structural node
    // out of deletion transactions.
    const beforeInput = (event: InputEvent) => {
      if (event.isComposing || !event.inputType.startsWith('delete')) return
      const offsets = selectionOffsets(editor)
      if (!offsets || offsets[0] !== offsets[1]) return
      if ((event.inputType.endsWith('Backward') && offsets[0] === 0) ||
          (event.inputType.endsWith('Forward') && offsets[0] >= readText(editor).length)) event.preventDefault()
    }
    editor.addEventListener('beforeinput', beforeInput)
    return () => editor.removeEventListener('beforeinput', beforeInput)
  }, [])

  const resize = useCallback(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return
    const style = getComputedStyle(viewport)
    const line = Number.parseFloat(style.lineHeight)
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
    const height = `${Math.min(Math.max(content.offsetHeight, minRows * line), maxRows * line) + padding}px`
    if (viewport.style.height !== height) viewport.style.height = height
  }, [minRows, maxRows])

  useLayoutEffect(resize, [resize, value])
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    const observer = new ResizeObserver(resize)
    observer.observe(content)
    return () => observer.disconnect()
  }, [resize])

  const publish = () => onValueChange(editorRef.current ? readText(editorRef.current) : '')

  // The whole field remains clickable, including the empty minRows area
  // and the end of a short line.
  const onMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    const editor = editorRef.current
    if (!editor?.isContentEditable || event.defaultPrevented || event.button !== 0) return
    if (editor.contains(event.target as Node) || (event.target as Element).closest('button')) return
    event.preventDefault()
    editor.focus({ preventScroll: true })
    const point = document.caretPositionFromPoint(event.clientX, event.clientY)
    const selection = window.getSelection()
    if (point && editor.contains(point.offsetNode)) {
      if (event.shiftKey && selection?.anchorNode && editor.contains(selection.anchorNode)) {
        selection.extend(point.offsetNode, point.offset)
      } else selection?.setPosition(point.offsetNode, point.offset)
    } else {
      const first = editor.getClientRects()[0]
      const offset = first && event.clientY < first.bottom && event.clientX < first.left ? 0 : readText(editor).length
      const anchor = event.shiftKey && selection?.anchorNode && editor.contains(selection.anchorNode)
        ? [selection.anchorNode, selection.anchorOffset] as const : null
      selectOffsets(editor, offset, offset)
      if (anchor && selection?.focusNode) selection.setBaseAndExtent(...anchor, selection.focusNode, selection.focusOffset)
    }
  }

  return {
    editorRef, viewportRef, contentRef, onMouseDown,
    onInput: publish,
    onCompositionStart: () => { composing.current = true },
    onCompositionEnd: () => { composing.current = false; publish() }
  }
}
