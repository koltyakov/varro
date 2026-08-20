import { Show, createEffect, createSignal, onMount, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { splitExternalLinkText } from '../../lib/external-link';
import { getFileTypeIcon } from '../FileTypeIcon';
import { createMaterialChipIconElement, type MaterialChipIconKind } from '../MaterialChipIcon';
import { CompletionMenu, type CompletionItem } from './CompletionMenu';

type ComposerClipboardEvent = ClipboardEvent & {
  __varroPasteText?: string;
};

const FOLDER_ICON_SVG =
  '<svg class="inline-chip-icon" viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M1.75 3h3.1c.31 0 .6.14.79.38l.86 1.12h7.75c.41 0 .75.34.75.75V6H1V3.75C1 3.34 1.34 3 1.75 3zM1 7h14v4.25c0 .97-.78 1.75-1.75 1.75H2.75A1.75 1.75 0 011 11.25V7z"/></svg>';

const CARET_SPACER = '\u200B';

export type RichComposerChip = {
  id: string;
  type: 'mention-file' | 'mention-agent' | 'mention-session' | 'external-link' | 'image';
  label: string;
  path?: string;
  title?: string;
  detail?: string;
  icon?: 'file' | 'folder' | 'image' | 'terminal' | 'agent' | 'session' | 'external-link' | 'git';
  disabled?: boolean;
  previewImage?: { url: string; alt: string };
  textMarker: string;
};

export type RichComposerPasteInsertion = {
  start: number;
  end: number;
  text: string;
  value: string;
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
  onPasteInsertion?: (e: ClipboardEvent, insertion: RichComposerPasteInsertion | null) => void;
  onFocus: () => void;
  onBlur: () => void;
  onClick: (cursorOffset: number, selectionEnd: number) => void;
  onKeyUp: (cursorOffset: number, selectionEnd: number) => void;
  onSelect: (cursorOffset: number, selectionEnd: number) => void;
  onSelectCompletion: (item: CompletionItem) => void;
  onChipClick?: (chipId: string) => void;
  onRemoveChip?: (chipId: string) => void;
  onHistory?: (action: 'undo' | 'redo') => void;
}) {
  let editorEl: HTMLDivElement | undefined;
  let isComposing = false;
  let historyHandledByKeydown = false;
  const [preview, setPreview] = createSignal<{
    chipId: string;
    image: { url: string; alt: string };
    style: Record<string, string>;
  } | null>(null);

  createEffect(() => {
    const current = preview();
    if (current && !props.chips.some((chip) => chip.id === current.chipId && chip.previewImage)) {
      setPreview(null);
    }
  });

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
    for (const [index, part] of parts.entries()) {
      const chip = chips.get(part);
      if (chip) {
        const previousNode = frag.lastChild;
        const isAtomicChip = chip.type !== 'external-link' && chip.type !== 'mention-session';
        if (isAtomicChip && previousNode instanceof HTMLBRElement) {
          frag.appendChild(document.createTextNode(CARET_SPACER));
        }
        frag.appendChild(createChipElement(chip));
        if (chip.type !== 'external-link') {
          frag.appendChild(document.createTextNode(CARET_SPACER));
        }
      } else {
        appendTextWithLineBreaks(frag, part, index === parts.length - 1);
      }
    }
    return frag;
  }

  function createChipElement(chip: RichComposerChip): HTMLSpanElement {
    const span = document.createElement('span');
    const isInlineReference = chip.type === 'mention-session' || chip.type === 'external-link';
    span.className = isInlineReference
      ? chip.type === 'mention-session'
        ? 'composer-session-reference'
        : 'composer-external-link'
      : `inline-chip${chip.disabled ? ' disabled' : ''}`;
    if (chip.type !== 'external-link' && chip.type !== 'mention-session') {
      span.contentEditable = 'false';
    }
    if (chip.type !== 'external-link') {
      span.dataset.chipMarker = chip.textMarker;
    }
    if (!isInlineReference) span.dataset.chipId = chip.id;
    span.dataset.chipType = chip.type;
    if (chip.previewImage) span.dataset.previewImage = 'true';
    span.setAttribute('title', chip.title || chip.label);

    const hasFormatIcon =
      chip.icon === 'file' || (chip.icon === 'image' && /\.[^./]+$/.test(chip.path || chip.label));
    const materialIconKind = getMaterialIconKind(chip.icon);
    const icon = hasFormatIcon || materialIconKind ? null : getChipIcon(chip.icon);
    if (icon || hasFormatIcon || materialIconKind) {
      const iconWrapper = document.createElement('span');
      iconWrapper.className = 'inline-chip-icon-wrap';
      if (chip.type === 'external-link' || chip.type === 'mention-session') {
        iconWrapper.contentEditable = 'false';
      }
      if (hasFormatIcon) {
        const image = document.createElement('img');
        image.className = 'file-type-icon inline-chip-icon';
        image.src = getFileTypeIcon(chip.path || chip.label);
        image.alt = '';
        image.setAttribute('aria-hidden', 'true');
        image.draggable = false;
        iconWrapper.appendChild(image);
      } else if (materialIconKind) {
        iconWrapper.appendChild(
          createMaterialChipIconElement(
            materialIconKind,
            `inline-chip-icon${chip.type === 'external-link' ? ' composer-external-link-icon' : ''}`
          )
        );
      } else if (icon) {
        iconWrapper.innerHTML = icon;
      }
      span.appendChild(iconWrapper);
    }

    if (chip.type === 'external-link') {
      span.appendChild(document.createTextNode(chip.label));
    } else {
      const labelSpan = document.createElement('span');
      labelSpan.className = 'inline-chip-label';
      labelSpan.textContent = chip.label;
      span.appendChild(labelSpan);
    }

    if (chip.detail) {
      const detailSpan = document.createElement('span');
      detailSpan.className = 'inline-chip-detail';
      detailSpan.textContent = chip.detail;
      span.appendChild(detailSpan);
    }

    return span;
  }

  function removeAtomicReference(event: KeyboardEvent) {
    if (
      (event.key !== 'Backspace' && event.key !== 'Delete') ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.isComposing
    ) {
      return false;
    }

    const selection = getSelectionOffsets();
    if (!selection || selection.start !== selection.end) return false;

    if (
      event.key === 'Backspace' &&
      props.value[selection.start - 1] === '\n' &&
      props.chips.some(
        (chip) =>
          chip.type !== 'external-link' &&
          chip.type !== 'mention-session' &&
          props.value.startsWith(chip.textMarker, selection.start)
      )
    ) {
      event.preventDefault();
      props.onInput(
        `${props.value.slice(0, selection.start - 1)}${props.value.slice(selection.start)}`,
        selection.start - 1
      );
      return true;
    }

    for (const chip of props.chips) {
      if (chip.type === 'external-link' || chip.type === 'mention-session') continue;
      let markerStart = props.value.indexOf(chip.textMarker);
      while (markerStart !== -1) {
        const markerEnd = markerStart + chip.textMarker.length;
        const shouldRemove =
          (event.key === 'Backspace' && selection.start === markerEnd) ||
          (event.key === 'Delete' && selection.start === markerStart);
        if (shouldRemove) {
          event.preventDefault();
          props.onInput(
            `${props.value.slice(0, markerStart)}${props.value.slice(markerEnd)}`,
            markerStart
          );
          props.onRemoveChip?.(chip.id);
          return true;
        }
        markerStart = props.value.indexOf(chip.textMarker, markerEnd);
      }
    }

    if (removeSessionReferenceAtSelection()) {
      event.preventDefault();
      return true;
    }

    for (const chip of props.chips) {
      if (chip.type !== 'mention-session') continue;
      let markerStart = props.value.indexOf(chip.textMarker);
      while (markerStart !== -1) {
        const markerEnd = markerStart + chip.textMarker.length;
        const shouldRemove =
          (event.key === 'Backspace' && selection.start === markerEnd) ||
          (event.key === 'Delete' && selection.start === markerStart);
        if (shouldRemove) {
          event.preventDefault();
          props.onInput(
            `${props.value.slice(0, markerStart)}${props.value.slice(markerEnd)}`,
            markerStart
          );
          props.onRemoveChip?.(chip.id);
          return true;
        }
        markerStart = props.value.indexOf(chip.textMarker, markerEnd);
      }
    }
    return false;
  }

  function getSessionReferenceAtSelection(): HTMLElement | null {
    const range = getSelectionRange();
    if (!range || !range.collapsed) return null;

    const container =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    const reference = container?.closest<HTMLElement>('.composer-session-reference') ?? null;
    return reference && editorEl?.contains(reference) ? reference : null;
  }

  function removeSessionReferenceAtSelection(insertedText = ''): boolean {
    const reference = getSessionReferenceAtSelection();
    const marker = reference?.dataset.chipMarker;
    if (!reference || !marker || !editorEl) return false;

    const prefixRange = document.createRange();
    prefixRange.selectNodeContents(editorEl);
    prefixRange.setEndBefore(reference);
    const markerStart = extractRangeTextLength(prefixRange);
    props.onInput(
      `${props.value.slice(0, markerStart)}${insertedText}${props.value.slice(markerStart + marker.length)}`,
      markerStart + insertedText.length
    );
    const chip = props.chips.find(
      (item) => item.type === 'mention-session' && item.textMarker === marker
    );
    if (chip) props.onRemoveChip?.(chip.id);
    return true;
  }

  function replaceSelectionContainingSession(insertedText = ''): boolean {
    const selection = getSelectionOffsets();
    if (!selection || selection.start === selection.end) return false;

    const selectedSessionIds = new Set<string>();
    for (const chip of props.chips) {
      if (chip.type !== 'mention-session') continue;
      let markerStart = props.value.indexOf(chip.textMarker);
      while (markerStart !== -1) {
        const markerEnd = markerStart + chip.textMarker.length;
        if (markerStart < selection.end && markerEnd > selection.start) {
          selectedSessionIds.add(chip.id);
          break;
        }
        markerStart = props.value.indexOf(chip.textMarker, markerEnd);
      }
    }
    if (selectedSessionIds.size === 0) return false;

    props.onInput(
      `${props.value.slice(0, selection.start)}${insertedText}${props.value.slice(selection.end)}`,
      selection.start + insertedText.length
    );
    for (const id of selectedSessionIds) props.onRemoveChip?.(id);
    return true;
  }

  function insertSpaceAfterExternalLink(): boolean {
    const range = getSelectionRange();
    if (!range || !range.collapsed) return false;
    const container =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    const reference = container?.closest<HTMLElement>('.composer-external-link') ?? null;
    if (!reference || !editorEl?.contains(reference)) return false;

    const localRange = document.createRange();
    localRange.selectNodeContents(reference);
    localRange.setEnd(range.startContainer, range.startOffset);
    if (extractRangeTextLength(localRange) !== extractText(reference).length) return false;

    const offset = getCursorOffset();
    props.onInput(`${props.value.slice(0, offset)} ${props.value.slice(offset)}`, offset + 1);
    return true;
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

    let start = extractRangeTextLength(preRange);
    let end = extractRangeTextLength(postRange);
    if (!range.collapsed) {
      const startBoundary = getSessionReferenceBoundary(range.startContainer);
      const endBoundary = getSessionReferenceBoundary(range.endContainer);
      if (startBoundary) start = startBoundary.start;
      if (endBoundary) end = endBoundary.end;
    }
    return { start, end };
  }

  function getSessionReferenceBoundary(node: Node): { start: number; end: number } | null {
    if (!editorEl) return null;
    const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const reference = element?.closest<HTMLElement>('.composer-session-reference') ?? null;
    const marker = reference?.dataset.chipMarker;
    if (!reference || !marker || !editorEl.contains(reference)) return null;

    const prefixRange = document.createRange();
    prefixRange.selectNodeContents(editorEl);
    prefixRange.setEndBefore(reference);
    const start = extractRangeTextLength(prefixRange);
    return { start, end: start + marker.length };
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
  let lastSyncedChips = '';

  createEffect(() => {
    const text = props.value;
    const requestedCursor = props.cursorOffset;
    const chips = JSON.stringify(
      props.chips
        .filter((chip) => chip.type !== 'external-link')
        .map((chip) => [
          chip.id,
          chip.label,
          chip.title,
          chip.detail,
          chip.icon,
          chip.disabled,
          chip.textMarker,
        ])
    );
    if (!editorEl) return;

    const textChanged = text !== lastSyncedValue;
    const chipsChanged = chips !== lastSyncedChips;
    const isFocused = props.isFocused || document.activeElement === editorEl;
    const textNeedsResync = needsResync(editorEl, text);
    const externalLinksOutOfSync = externalLinksNeedResync(editorEl, text, props.chips);
    const preserveEditedExternalLinks =
      isFocused && editorEl.querySelector('.composer-external-link') !== null;
    const domNeedsResync =
      textNeedsResync || (externalLinksOutOfSync && !preserveEditedExternalLinks);

    if (!textChanged && !chipsChanged && !domNeedsResync) {
      if (isFocused && requestedCursor != null && getCursorOffset() !== requestedCursor) {
        setCursorOffset(Math.min(requestedCursor, text.length));
      }
      return;
    }

    lastSyncedValue = text;
    lastSyncedChips = chips;
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
  });

  function handleInput(event?: InputEvent) {
    if (isComposing) return;
    if (!editorEl) return;
    if (event?.inputType === 'historyUndo' || event?.inputType === 'historyRedo') {
      const frag = buildDom(props.value, getChipMap());
      editorEl.textContent = '';
      editorEl.appendChild(frag);
      lastSyncedValue = props.value;
      syncEmptyState();
      setCursorOffset(Math.min(props.cursorOffset ?? props.value.length, props.value.length));
      return;
    }
    syncEmptyState();
    const offset = getCursorOffset();
    normalizeEditableExternalLinks(editorEl);
    setCursorOffset(offset);
    const text = extractText(editorEl);
    const previousValue = props.value;
    const previousChips = props.chips.slice();
    lastSyncedValue = text;
    props.onInput(text, offset);

    if (!props.onRemoveChip) return;
    for (const chip of previousChips) {
      if (chip.type === 'external-link') continue;
      if (!previousValue.includes(chip.textMarker)) continue;
      if (text.includes(chip.textMarker)) continue;
      props.onRemoveChip(chip.id);
    }
  }

  function handlePaste(e: ClipboardEvent) {
    props.onPaste(e);
    if (e.defaultPrevented) {
      props.onPasteInsertion?.(e, null);
      return;
    }

    const overrideText = (e as ComposerClipboardEvent).__varroPasteText;
    const text = overrideText ?? e.clipboardData?.getData('text/plain') ?? '';
    if (overrideText !== undefined) {
      e.preventDefault();
    }
    if (!text) {
      props.onPasteInsertion?.(e, null);
      return;
    }
    const selection = getSelectionOffsets() || {
      start: props.value.length,
      end: props.value.length,
    };
    e.preventDefault();
    const nextValue = `${props.value.slice(0, selection.start)}${text}${props.value.slice(selection.end)}`;
    props.onInput(nextValue, selection.start + text.length);
    props.onPasteInsertion?.(e, {
      start: selection.start,
      end: selection.start + text.length,
      text,
      value: nextValue,
    });
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

  function handleLineBreak(e: KeyboardEvent): boolean {
    if (e.key !== 'Enter' || !e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) {
      return false;
    }

    const selection = getSelectionOffsets();
    if (!selection) return false;

    const lineStart = props.value.lastIndexOf('\n', selection.start - 1) + 1;
    const nextLineBreak = props.value.indexOf('\n', selection.end);
    const lineEnd = nextLineBreak === -1 ? props.value.length : nextLineBreak;
    const line = props.value.slice(lineStart, lineEnd);
    const emptyBullet = line.match(/^\s*-\s*$/);

    if (emptyBullet) {
      e.preventDefault();
      const nextValue = `${props.value.slice(0, lineStart)}${props.value.slice(lineEnd)}`;
      props.onInput(nextValue, lineStart);
      return true;
    }

    const bulletPrefix = line.match(/^(\s*-\s+)/)?.[1];
    if (!bulletPrefix || selection.start < lineStart + bulletPrefix.length) {
      e.preventDefault();
      const nextValue = `${props.value.slice(0, selection.start)}\n${props.value.slice(selection.end)}`;
      props.onInput(nextValue, selection.start + 1);
      return true;
    }

    e.preventDefault();
    const insertion = `\n${bulletPrefix}`;
    const nextValue = `${props.value.slice(0, selection.start)}${insertion}${props.value.slice(selection.end)}`;
    props.onInput(nextValue, selection.start + insertion.length);
    return true;
  }

  function showImagePreview(target: EventTarget | null) {
    const chipElement = (target as HTMLElement | null)?.closest?.<HTMLElement>(
      '.inline-chip[data-preview-image]'
    );
    if (!chipElement?.dataset.chipId) return;
    const chip = props.chips.find((item) => item.id === chipElement.dataset.chipId);
    if (!chip?.previewImage) return;

    const chipRect = chipElement.getBoundingClientRect();
    const frameRect =
      editorEl?.closest<HTMLElement>('.chat-input-container')?.getBoundingClientRect() ??
      editorEl?.getBoundingClientRect();
    const chatRect = editorEl?.closest<HTMLElement>('.chat-input-shell')?.getBoundingClientRect();
    if (!frameRect) return;

    const edgeGap = 10;
    const anchorGap = 22;
    const chatLeft = Math.max(chatRect?.left ?? 0, edgeGap);
    const chatRight = Math.min(chatRect?.right ?? window.innerWidth, window.innerWidth - edgeGap);
    const maxWidth = Math.max(120, (chatRect?.width ?? window.innerWidth) * 0.8);
    const constrainedWidth = Math.min(maxWidth, chatRight - chatLeft);
    const chipCenter = chipRect.left + chipRect.width / 2;
    const center = Math.min(
      Math.max(chipCenter, chatLeft + constrainedWidth / 2),
      chatRight - constrainedWidth / 2
    );

    setPreview({
      chipId: chip.id,
      image: chip.previewImage,
      style: {
        left: `${center}px`,
        bottom: `${window.innerHeight - frameRect.top + anchorGap}px`,
        '--attachment-preview-max-width': `${constrainedWidth}px`,
        '--attachment-preview-max-height': `${Math.max(80, Math.min(300, frameRect.top - anchorGap - edgeGap))}px`,
        '--attachment-preview-tail-offset': `${chipCenter - center}px`,
      },
    });
  }

  onMount(() => {
    const handleSelectionChange = () => {
      if (!editorEl || document.activeElement !== editorEl) return;
      const selection = getSelectionOffsets();
      if (selection) props.onSelect(selection.start, selection.end);
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
        aria-label="Message composer"
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
            if (historyHandledByKeydown) {
              historyHandledByKeydown = false;
            } else {
              props.onHistory?.(e.inputType === 'historyUndo' ? 'undo' : 'redo');
            }
            return;
          }

          if (e.inputType.startsWith('delete')) {
            if (replaceSelectionContainingSession() || removeSessionReferenceAtSelection()) {
              e.preventDefault();
            }
            return;
          }

          if (
            e.inputType === 'insertText' ||
            e.inputType === 'insertCompositionText' ||
            e.inputType === 'insertReplacementText'
          ) {
            if (e.data === ' ' && insertSpaceAfterExternalLink()) {
              e.preventDefault();
              return;
            }
            if (
              replaceSelectionContainingSession(e.data ?? '') ||
              removeSessionReferenceAtSelection(e.data ?? '')
            ) {
              e.preventDefault();
            }
            return;
          }

          if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
            if (
              replaceSelectionContainingSession('\n') ||
              removeSessionReferenceAtSelection('\n')
            ) {
              e.preventDefault();
            }
          }
        }}
        onKeyDown={(e) => {
          if (!removeAtomicReference(e)) {
            props.onKeyDown(e);
            if (!e.defaultPrevented) handleLineBreak(e);
            const key = e.key.toLowerCase();
            historyHandledByKeydown =
              e.defaultPrevented &&
              ((key === 'z' && (e.metaKey || e.ctrlKey)) ||
                (key === 'y' && e.ctrlKey && !e.metaKey));
          }
        }}
        onPaste={handlePaste}
        onCopy={handleCopy}
        onMouseOver={(event) => showImagePreview(event.target)}
        onMouseOut={(event) => {
          const sourceChip = (event.target as HTMLElement).closest?.('[data-preview-image]');
          const relatedChip =
            event.relatedTarget instanceof HTMLElement
              ? event.relatedTarget.closest('[data-preview-image]')
              : null;
          if (sourceChip === relatedChip) return;
          setPreview(null);
        }}
        onFocus={() => props.onFocus()}
        onBlur={() => props.onBlur()}
        onClick={(e) => {
          const chipEl = (e.target as HTMLElement).closest?.('[data-chip-id]');
          if (chipEl instanceof HTMLElement && chipEl.dataset.chipId) {
            props.onChipClick?.(chipEl.dataset.chipId);
          }
          const selection = getSelectionOffsets();
          if (selection) props.onClick(selection.start, selection.end);
        }}
        onKeyUp={() => {
          historyHandledByKeydown = false;
          const selection = getSelectionOffsets();
          if (selection) props.onKeyUp(selection.start, selection.end);
        }}
        onCompositionStart={() => {
          isComposing = true;
        }}
        onCompositionEnd={() => {
          isComposing = false;
          handleInput();
        }}
        spellcheck={false}
      />

      <Portal>
        <Show when={preview()}>
          {(current) => (
            <div class="chat-attachment-image-preview" style={current().style}>
              <img src={current().image.url} alt={current().image.alt} />
            </div>
          )}
        </Show>
      </Portal>

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

function appendTextWithLineBreaks(parent: Node, text: string, addTrailingPlaceholder = true) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) parent.appendChild(document.createElement('br'));
    if (lines[i]) {
      const previousNode = parent.lastChild;
      if (previousNode?.nodeType === Node.TEXT_NODE) {
        previousNode.textContent = `${previousNode.textContent || ''}${lines[i]}`;
      } else {
        parent.appendChild(document.createTextNode(lines[i]!));
      }
    }
  }
  if (addTrailingPlaceholder && text.endsWith('\n')) {
    const placeholder = document.createElement('br');
    placeholder.dataset.caretPlaceholder = 'true';
    parent.appendChild(placeholder);
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
        if (element.dataset.caretPlaceholder) continue;
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

function getChipIcon(icon?: string): string {
  if (icon === 'folder') return FOLDER_ICON_SVG;
  return '<svg class="inline-chip-icon" viewBox="0 0 16 16" fill="currentColor" width="11" height="11"><path d="M3.5 2A1.5 1.5 0 002 3.5v9A1.5 1.5 0 003.5 14h9a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0012.5 2h-9zM4 4h8v1H4V4zm0 2.5h8v1H4v-1zm0 2.5h5v1H4V9z"/></svg>';
}

function getMaterialIconKind(icon?: string): MaterialChipIconKind | null {
  if (
    icon === 'agent' ||
    icon === 'image' ||
    icon === 'terminal' ||
    icon === 'session' ||
    icon === 'external-link' ||
    icon === 'git'
  ) {
    return icon;
  }
  return null;
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
        if (el.dataset.caretPlaceholder) {
          if (remaining === 0) {
            const idx = Array.from(root.childNodes).indexOf(child);
            return { node: root, offset: idx };
          }
          continue;
        }
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
        const childLength = getNodeTextLength(child);
        if (remaining <= childLength) return findNodeAtOffset(child, remaining);
        remaining -= childLength;
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
  if (el.dataset.caretPlaceholder) return 0;
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

function externalLinksNeedResync(
  editor: HTMLElement,
  text: string,
  chips: RichComposerChip[]
): boolean {
  const externalLinks = new Map(
    chips
      .filter((chip) => chip.type === 'external-link')
      .map((chip) => [chip.textMarker, chip] as const)
  );
  const actualMarkers = Array.from(
    editor.querySelectorAll<HTMLElement>('.composer-external-link'),
    (element) => element.textContent ?? ''
  );
  if (externalLinks.size === 0) return actualMarkers.length > 0;

  const sortedMarkers = Array.from(externalLinks.keys()).toSorted((a, b) => b.length - a.length);
  const pattern = new RegExp(
    `(${sortedMarkers.map((marker) => escapeRegex(marker)).join('|')})`,
    'g'
  );
  const expectedMarkers = text.split(pattern).filter((part) => externalLinks.has(part));
  return (
    actualMarkers.length !== expectedMarkers.length ||
    actualMarkers.some((marker, index) => marker !== expectedMarkers[index])
  );
}

function normalizeEditableExternalLinks(editor: HTMLElement) {
  for (const element of Array.from(
    editor.querySelectorAll<HTMLElement>('.composer-external-link')
  )) {
    const content = element.textContent ?? '';
    const segments = splitExternalLinkText(content);
    const linkIndex = segments.findIndex((segment) => segment.type === 'external-link');
    if (linkIndex === -1) {
      element.replaceWith(document.createTextNode(content));
      continue;
    }

    const link = segments[linkIndex]!;
    if (link.type !== 'external-link') continue;
    const prefix = segments
      .slice(0, linkIndex)
      .map((segment) => (segment.type === 'text' ? segment.content : segment.href))
      .join('');
    const linkStart = content.indexOf(link.href, prefix.length);
    const suffix = content.slice(linkStart + link.href.length);
    if (!prefix && !suffix) continue;

    if (prefix) element.before(document.createTextNode(prefix));
    element.textContent = link.href;
    if (suffix) element.after(document.createTextNode(suffix));
  }
}
