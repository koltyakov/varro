import { Show, createEffect, onMount, onCleanup } from 'solid-js';
import { CompletionMenu, type CompletionItem } from './CompletionMenu';
import type { InlineChipData } from './InlineChip';

type ComposerClipboardEvent = ClipboardEvent & {
  __varroPasteText?: string;
};

const FOLDER_ICON_SVG =
  '<svg class="inline-chip-icon" viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M1.75 3h3.1c.31 0 .6.14.79.38l.86 1.12h7.75c.41 0 .75.34.75.75V6H1V3.75C1 3.34 1.34 3 1.75 3zM1 7h14v4.25c0 .97-.78 1.75-1.75 1.75H2.75A1.75 1.75 0 011 11.25V7z"/></svg>';

const CARET_SPACER = '\u200B';

export type RichComposerChip = InlineChipData & {
  textMarker: string;
};

export function RichComposerArea(props: {
  editorRef: (el: HTMLDivElement) => void;
  placeholder: string;
  value: string;
  cursorOffset?: number;
  chips: RichComposerChip[];
  isFocused: boolean;
  showCompletionMenu: boolean;
  completionItems: CompletionItem[];
  completionSelectedIndex: number;
  completionHeader?: string;
  onInput: (text: string, cursorOffset: number) => void;
  onKeyDown: (e: KeyboardEvent) => void;
  onPaste: (e: ClipboardEvent) => void;
  onFocus: () => void;
  onBlur: () => void;
  onClick: (cursorOffset: number) => void;
  onKeyUp: (cursorOffset: number) => void;
  onSelect: (cursorOffset: number) => void;
  onSelectCompletion: (item: CompletionItem) => void;
  onChipClick?: (chipId: string) => void;
  onRemoveChip?: (chipId: string) => void;
  onHistory?: (action: 'undo' | 'redo') => void;
}) {
  let editorEl: HTMLDivElement | undefined;
  let isComposing = false;
  let suppressNextInput = false;

  onMount(() => {
    if (editorEl) {
      props.editorRef(editorEl);
    }
  });

  function getChipMap(): Map<string, RichComposerChip> {
    const map = new Map<string, RichComposerChip>();
    for (const chip of props.chips) {
      map.set(chip.textMarker, chip);
    }
    return map;
  }

  function buildDom(text: string, chips: Map<string, RichComposerChip>): DocumentFragment {
    const frag = document.createDocumentFragment();
    if (!text) return frag;

    const sortedMarkers = Array.from(chips.keys()).toSorted((a, b) => b.length - a.length);
    if (sortedMarkers.length === 0) {
      appendTextWithLineBreaks(frag, text);
      return frag;
    }

    const pattern = new RegExp(`(${sortedMarkers.map((m) => escapeRegex(m)).join('|')})`, 'g');

    const parts = text.split(pattern);
    for (const part of parts) {
      const chip = chips.get(part);
      if (chip) {
        frag.appendChild(createChipElement(chip));
        frag.appendChild(document.createTextNode(CARET_SPACER));
      } else {
        appendTextWithLineBreaks(frag, part);
      }
    }
    return frag;
  }

  function createChipElement(chip: RichComposerChip): HTMLSpanElement {
    const span = document.createElement('span');
    span.className = `inline-chip${chip.disabled ? ' disabled' : ''}`;
    span.contentEditable = 'false';
    span.dataset.chipId = chip.id;
    span.dataset.chipType = chip.type;
    span.dataset.chipMarker = chip.textMarker;
    span.setAttribute('title', chip.title || chip.label);

    const iconSvg = getChipIconSvg(chip.icon);
    if (iconSvg) {
      const iconWrapper = document.createElement('span');
      iconWrapper.className = 'inline-chip-icon-wrap';
      iconWrapper.innerHTML = iconSvg;
      span.appendChild(iconWrapper);
    }

    const labelSpan = document.createElement('span');
    labelSpan.className = 'inline-chip-label';
    labelSpan.textContent = chip.label;
    span.appendChild(labelSpan);

    if (chip.detail) {
      const detailSpan = document.createElement('span');
      detailSpan.className = 'inline-chip-detail';
      detailSpan.textContent = chip.detail;
      span.appendChild(detailSpan);
    }

    return span;
  }

  function getCursorOffset(): number {
    const offsets = getSelectionOffsets();
    return offsets?.start ?? 0;
  }

  function getSelectionOffsets(): { start: number; end: number } | null {
    if (!editorEl) return null;
    const range = getSelectionRange();
    if (!range) return null;

    const preRange = document.createRange();
    const postRange = document.createRange();
    preRange.selectNodeContents(editorEl);
    preRange.setEnd(range.startContainer, range.startOffset);
    postRange.selectNodeContents(editorEl);
    postRange.setEnd(range.endContainer, range.endOffset);

    return {
      start: extractRangeTextLength(preRange),
      end: extractRangeTextLength(postRange),
    };
  }

  function getSelectionRange(): Range | null {
    if (!editorEl) return null;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;

    const range = sel.getRangeAt(0);
    if (!editorEl.contains(range.startContainer) || !editorEl.contains(range.endContainer)) {
      return null;
    }
    return range;
  }

  function extractRangeTextLength(range: Range): number {
    const tempDiv = document.createElement('div');
    tempDiv.appendChild(range.cloneContents());
    return extractText(tempDiv).length;
  }

  function setCursorOffset(offset: number) {
    if (!editorEl) return;
    const result = findNodeAtOffset(editorEl, offset);
    if (!result) return;

    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    range.setStart(result.node, result.offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function syncEmptyState() {
    if (!editorEl) return;
    editorEl.dataset.empty = isEditorEmpty(editorEl) ? 'true' : 'false';
  }

  let lastSyncedValue = '';

  createEffect(() => {
    const text = props.value;
    const requestedCursor = props.cursorOffset;
    void props.chips;
    if (!editorEl) return;

    const textChanged = text !== lastSyncedValue;
    const domNeedsResync = needsResync(editorEl, text);
    const isFocused = props.isFocused || document.activeElement === editorEl;

    if (!textChanged && !domNeedsResync) {
      if (isFocused && requestedCursor != null && getCursorOffset() !== requestedCursor) {
        setCursorOffset(Math.min(requestedCursor, text.length));
      }
      return;
    }

    lastSyncedValue = text;
    suppressNextInput = true;
    const cursorOff =
      textChanged && requestedCursor != null
        ? requestedCursor
        : isFocused
          ? getCursorOffset()
          : text.length;
    const chipMap = getChipMap();
    const frag = buildDom(text, chipMap);
    editorEl.textContent = '';
    editorEl.appendChild(frag);
    syncEmptyState();
    if (isFocused) {
      setCursorOffset(Math.min(cursorOff, text.length));
    }
    queueMicrotask(() => {
      suppressNextInput = false;
    });
  });

  function handleInput() {
    if (suppressNextInput || isComposing) return;
    if (!editorEl) return;
    syncEmptyState();
    const text = extractText(editorEl);
    const previousValue = props.value;
    const previousChips = props.chips.slice();
    lastSyncedValue = text;
    const offset = getCursorOffset();
    props.onInput(text, offset);

    if (!props.onRemoveChip) return;
    for (const chip of previousChips) {
      if (!previousValue.includes(chip.textMarker)) continue;
      if (text.includes(chip.textMarker)) continue;
      props.onRemoveChip(chip.id);
    }
  }

  function handlePaste(e: ClipboardEvent) {
    props.onPaste(e);
    if (e.defaultPrevented) return;

    const overrideText = (e as ComposerClipboardEvent).__varroPasteText;
    const text = overrideText ?? e.clipboardData?.getData('text/plain') ?? '';
    if (overrideText !== undefined) {
      e.preventDefault();
    }
    if (!text) return;
    const selection = getSelectionOffsets() || {
      start: props.value.length,
      end: props.value.length,
    };
    e.preventDefault();
    const nextValue = `${props.value.slice(0, selection.start)}${text}${props.value.slice(selection.end)}`;
    props.onInput(nextValue, selection.start + text.length);
  }

  function handleCopy(e: ClipboardEvent) {
    const range = getSelectionRange();
    if (!range || range.collapsed) return;
    if (!e.clipboardData) return;

    const fragment = document.createElement('div');
    fragment.appendChild(range.cloneContents());
    const text = extractText(fragment);
    if (!text) return;

    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  }

  onMount(() => {
    const handleSelectionChange = () => {
      if (!editorEl || document.activeElement !== editorEl) return;
      props.onSelect(getCursorOffset());
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    onCleanup(() => document.removeEventListener('selectionchange', handleSelectionChange));
  });

  return (
    <div class="chat-editor-container">
      <div
        ref={(el) => {
          editorEl = el;
          syncEmptyState();
          props.editorRef(el);
        }}
        class="rich-composer"
        contentEditable={true}
        role="textbox"
        aria-multiline="true"
        aria-placeholder={props.placeholder}
        data-placeholder={props.placeholder}
        onInput={handleInput}
        onBeforeInput={(e) => {
          // The editor DOM is rebuilt programmatically, so the browser's
          // native undo stack is unreliable; route history edits (context
          // menu / Edit menu undo) to the composer history instead.
          if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
            e.preventDefault();
            props.onHistory?.(e.inputType === 'historyUndo' ? 'undo' : 'redo');
          }
        }}
        onKeyDown={(e) => props.onKeyDown(e)}
        onPaste={handlePaste}
        onCopy={handleCopy}
        onFocus={() => props.onFocus()}
        onBlur={() => props.onBlur()}
        onClick={(e) => {
          const chipEl = (e.target as HTMLElement).closest?.('[data-chip-id]');
          if (chipEl instanceof HTMLElement && chipEl.dataset.chipId) {
            props.onChipClick?.(chipEl.dataset.chipId);
          }
          props.onClick(getCursorOffset());
        }}
        onKeyUp={() => props.onKeyUp(getCursorOffset())}
        onCompositionStart={() => {
          isComposing = true;
        }}
        onCompositionEnd={() => {
          isComposing = false;
          handleInput();
        }}
        spellcheck={false}
      />

      <Show when={props.isFocused && props.showCompletionMenu}>
        <CompletionMenu
          items={props.completionItems}
          selectedIndex={props.completionSelectedIndex}
          header={props.completionHeader}
          onSelect={props.onSelectCompletion}
        />
      </Show>
    </div>
  );
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function appendTextWithLineBreaks(parent: Node, text: string) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) parent.appendChild(document.createElement('br'));
    if (lines[i]) parent.appendChild(document.createTextNode(lines[i]));
  }
}

export function extractText(el: HTMLElement): string {
  const topLevelNodes = Array.from(el.childNodes);
  let result = '';
  for (const [index, node] of topLevelNodes.entries()) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += (node.textContent || '').split(CARET_SPACER).join('');
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      if (element.tagName === 'BR') {
        if (topLevelNodes.length === 1 && index === 0) continue;
        result += '\n';
      } else if (element.dataset.chipMarker) {
        result += element.dataset.chipMarker;
      } else {
        result += extractText(element);
      }
    }
  }
  return result;
}

function getChipIconSvg(icon?: string): string {
  if (icon === 'image')
    return '<svg class="inline-chip-icon" viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M14.5 2h-13a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h13a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5zM2 3h12v7.3l-2.6-2.6a.5.5 0 00-.7 0L7.5 11 5.9 9.4a.5.5 0 00-.7 0L2 12.6V3zm3.5 4a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/></svg>';
  if (icon === 'folder') return FOLDER_ICON_SVG;
  if (icon === 'agent')
    return '<svg class="inline-chip-icon" viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M8 1a3 3 0 00-3 3v1H4a2 2 0 00-2 2v6a2 2 0 002 2h8a2 2 0 002-2V7a2 2 0 00-2-2h-1V4a3 3 0 00-3-3zm1 4V4a1 1 0 10-2 0v1h2zM6 9a1 1 0 11-2 0 1 1 0 012 0zm5 1a1 1 0 100-2 1 1 0 000 2z"/></svg>';
  if (icon === 'terminal')
    return '<svg class="inline-chip-icon" viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M1.75 2h12.5c.97 0 1.75.78 1.75 1.75v8.5c0 .97-.78 1.75-1.75 1.75H1.75A1.75 1.75 0 010 12.25v-8.5C0 2.78.78 2 1.75 2zm0 1a.75.75 0 00-.75.75v8.5c0 .41.34.75.75.75h12.5a.75.75 0 00.75-.75v-8.5a.75.75 0 00-.75-.75H1.75zm2.03 2.22a.75.75 0 011.06 0L6.56 6.94 4.84 8.66a.75.75 0 11-1.06-1.06L4.44 7 3.78 6.28a.75.75 0 010-1.06zM8 8.25h4a.75.75 0 010 1.5H8a.75.75 0 010-1.5z"/></svg>';
  return '<svg class="inline-chip-icon" viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M3.5 2A1.5 1.5 0 002 3.5v9A1.5 1.5 0 003.5 14h9a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0012.5 2h-9zM4 4h8v1H4V4zm0 2.5h8v1H4v-1zm0 2.5h5v1H4V9z"/></svg>';
}

export function findNodeAtOffset(
  root: Node,
  targetOffset: number
): { node: Node; offset: number } | null {
  let remaining = targetOffset;

  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      const textContent = child.textContent || '';
      const len = getTextNodeLogicalLength(textContent);
      if (remaining <= len) {
        return { node: child, offset: getTextNodeDomOffset(textContent, remaining) };
      }
      remaining -= len;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      if (el.tagName === 'BR') {
        if (remaining === 0) {
          const idx = Array.from(root.childNodes).indexOf(child);
          return { node: root, offset: idx + 1 };
        }
        remaining -= 1;
      } else if (el.dataset.chipMarker) {
        const markerLen = el.dataset.chipMarker.length;
        if (remaining <= markerLen) {
          const idx = Array.from(root.childNodes).indexOf(child);
          if (remaining === 0) {
            return { node: root, offset: idx };
          }
          const nextSibling = root.childNodes[idx + 1];
          if (
            nextSibling?.nodeType === Node.TEXT_NODE &&
            (nextSibling.textContent || '').startsWith(CARET_SPACER)
          ) {
            return { node: nextSibling, offset: Math.min(1, nextSibling.textContent?.length || 0) };
          }
          return { node: root, offset: idx + 1 };
        }
        remaining -= markerLen;
      } else {
        const result = findNodeAtOffset(child, remaining);
        if (result) return result;
        remaining -= getNodeTextLength(child);
      }
    }
  }

  return { node: root, offset: root.childNodes.length };
}

function getTextNodeLogicalLength(text: string): number {
  return text.split(CARET_SPACER).join('').length;
}

function getTextNodeDomOffset(text: string, logicalOffset: number): number {
  if (logicalOffset <= 0) {
    return text.startsWith(CARET_SPACER) ? 1 : 0;
  }

  let visibleCount = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === CARET_SPACER) continue;
    visibleCount += 1;
    if (visibleCount === logicalOffset) return index + 1;
  }

  return text.length;
}

function isEditorEmpty(el: HTMLElement): boolean {
  return extractText(el).length === 0;
}

function getNodeTextLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent || '').split(CARET_SPACER).join('').length;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return 0;
  const el = node as HTMLElement;
  if (el.tagName === 'BR') return 1;
  if (el.dataset.chipMarker) return el.dataset.chipMarker.length;
  let len = 0;
  for (const child of Array.from(el.childNodes)) {
    len += getNodeTextLength(child);
  }
  return len;
}

function needsResync(el: HTMLElement, text: string): boolean {
  return extractText(el) !== text;
}
