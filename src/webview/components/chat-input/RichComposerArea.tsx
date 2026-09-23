import { For, Show, batch, createEffect, createSignal, onMount, onCleanup } from 'solid-js';
import { Portal } from 'solid-js/web';
import { splitExternalLinkText } from '../../lib/external-link';
import { emptyPageIcon, folderIcon } from '../../lib/ui-icons';
import { getFileTypeIcon } from '../FileTypeIcon';
import {
  createMaterialChipIconElement,
  getMaterialChipIcon,
  type MaterialChipIconKind,
} from '../MaterialChipIcon';
import { createUiIconElement } from '../UiIcon';
import { clampPopupToViewport } from '../../lib/popup-position';
import { CompletionMenu, type CompletionItem } from './CompletionMenu';
import { registerComposerOverlayDismiss } from './composer-overlay-dismiss';
import type { EditorDiagnostic } from '../../../shared/protocol';
import { getProblemsIconSource } from '../ProblemsIcon';
import { ProblemsTooltip } from '../ProblemsTooltip';

type ComposerClipboardEvent = ClipboardEvent & {
  __varroPasteText?: string;
};

const CARET_SPACER = '\u200B';

export type RichComposerChip = {
  id: string;
  type:
    | 'mention-file'
    | 'mention-terminal'
    | 'mention-agent'
    | 'mention-skill'
    | 'mention-problems'
    | 'mention-session'
    | 'external-link'
    | 'image';
  label: string;
  path?: string;
  title?: string;
  detail?: string;
  icon?:
    | 'file'
    | 'table'
    | 'folder'
    | 'image'
    | 'terminal'
    | 'agent'
    | 'skill'
    | 'session'
    | 'external-link'
    | 'git'
    | 'problems';
  severity?: EditorDiagnostic['severity'];
  problemDetails?: string;
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
  pendingPaste?: RichComposerPasteInsertion;
  cursorOffset?: number;
  chips: RichComposerChip[];
  isFocused: boolean;
  showCompletionMenu: boolean;
  completionItems: CompletionItem[];
  completionSelectedIndex: number;
  completionHeader?: string;
  completionEmptyMessage?: string;
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
  isChipExpandable?: (chipId: string) => boolean;
  onExpandChip?: (chipId: string) => void;
  onHistory?: (action: 'undo' | 'redo') => void;
}) {
  let editorEl: HTMLDivElement | undefined;
  let isComposing = false;
  let historyHandledByKeydown = false;
  let revealCaretAfterControlledInput = false;
  let pendingControlledCursorReveal = false;
  let nativeInputSync: { value: string; cursorOffset: number } | undefined;
  let unregisterComposerDismiss: (() => void) | undefined;
  const [problemTooltipTargets, setProblemTooltipTargets] = createSignal<
    Array<{ element: HTMLElement; text: string }>
  >([]);
  const [preview, setPreview] = createSignal<{
    chipId: string;
    image: { url: string; alt: string };
    style: Record<string, string>;
  } | null>(null);

  const [chipMenu, setChipMenu] = createSignal<{ chipId: string; x: number; y: number } | null>(
    null
  );
  let chipMenuRef: HTMLDivElement | undefined;
  const closeChipMenu = () => setChipMenu(null);

  createEffect(() => {
    const menu = chipMenu();
    if (!menu) return;
    if (!props.chips.some((chip) => chip.id === menu.chipId)) {
      closeChipMenu();
      return;
    }
    const closeIfOutside = (event: Event) => {
      if (event.target instanceof Node && chipMenuRef?.contains(event.target)) return;
      closeChipMenu();
    };
    window.addEventListener('contextmenu', closeIfOutside, true);
    window.addEventListener('pointerdown', closeIfOutside, true);
    window.addEventListener('focusin', closeIfOutside);
    const unregisterDismiss = registerComposerOverlayDismiss(closeChipMenu);
    onCleanup(() => {
      window.removeEventListener('contextmenu', closeIfOutside, true);
      window.removeEventListener('pointerdown', closeIfOutside, true);
      window.removeEventListener('focusin', closeIfOutside);
      unregisterDismiss();
    });
    queueMicrotask(() => {
      if (!chipMenuRef) return;
      clampPopupToViewport(chipMenuRef);
      chipMenuRef.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    });
  });

  function handleContextMenu(event: MouseEvent) {
    const chipId =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('.inline-chip[data-chip-id]')?.dataset.chipId
        : undefined;
    if (!chipId || !props.isChipExpandable?.(chipId)) return;
    event.preventDefault();
    setChipMenu({ chipId, x: event.clientX, y: event.clientY });
  }

  const hidePreview = () => {
    unregisterComposerDismiss?.();
    unregisterComposerDismiss = undefined;
    setPreview(null);
  };
  onCleanup(hidePreview);

  createEffect(() => {
    const current = preview();
    if (current && !props.chips.some((chip) => chip.id === current.chipId && chip.previewImage)) {
      hidePreview();
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
    const tooltipTargets: Array<{ element: HTMLElement; text: string }> = [];
    setProblemTooltipTargets([]);
    if (!text) return frag;

    const sortedMarkers = Array.from(chips.keys()).toSorted((a, b) => b.length - a.length);
    const pattern = sortedMarkers.length
      ? new RegExp(`(${sortedMarkers.map((m) => escapeRegex(m)).join('|')})`, 'g')
      : null;
    const pending = props.pendingPaste;
    const segments =
      pending?.value === text ? [text.slice(0, pending.start), text.slice(pending.end)] : [text];
    for (const [segmentIndex, segment] of segments.entries()) {
      const parts = pattern ? segment.split(pattern) : [segment];
      for (const [index, part] of parts.entries()) {
        const chip = chips.get(part);
        if (chip) {
          const previousNode = frag.lastChild;
          const isAtomicChip = chip.type !== 'external-link' && chip.type !== 'mention-session';
          if (isAtomicChip && previousNode instanceof HTMLBRElement) {
            frag.appendChild(document.createTextNode(CARET_SPACER));
          }
          const element = createChipElement(chip);
          frag.appendChild(element);
          if (chip.problemDetails) tooltipTargets.push({ element, text: chip.problemDetails });
          if (chip.type !== 'external-link') {
            frag.appendChild(document.createTextNode(CARET_SPACER));
          }
        } else {
          appendTextWithLineBreaks(
            frag,
            part,
            index === parts.length - 1 && segmentIndex === segments.length - 1
          );
        }
      }
      if (segments.length === 2 && segmentIndex === 0 && pending) {
        // Keep the text in logical offsets and clipboard extraction without
        // painting it or expanding the editor while its source is resolved.
        const placeholder = document.createElement('span');
        placeholder.contentEditable = 'false';
        placeholder.dataset.chipMarker = text.slice(pending.start, pending.end);
        placeholder.dataset.pendingPaste = 'true';
        placeholder.setAttribute('aria-hidden', 'true');
        if (frag.lastChild instanceof HTMLBRElement) {
          frag.appendChild(document.createTextNode(CARET_SPACER));
        }
        frag.appendChild(placeholder);
        frag.appendChild(document.createTextNode(CARET_SPACER));
      }
    }
    setProblemTooltipTargets(tooltipTargets);
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
    if (!chip.problemDetails) span.setAttribute('title', chip.title || chip.label);

    const hasFormatIcon =
      chip.icon === 'file' || (chip.icon === 'image' && /\.[^./]+$/.test(chip.path || chip.label));
    const materialIconKind = getMaterialIconKind(chip.icon);
    const icon =
      chip.icon === 'problems'
        ? createUiIconElement(getProblemsIconSource(chip.severity), {
            className: 'inline-chip-icon problems-icon',
            width: 12,
            height: 12,
          })
        : hasFormatIcon || materialIconKind
          ? null
          : getChipIcon(chip.icon);
    if (icon && chip.icon === 'problems') icon.dataset.severity = chip.severity ?? 'warning';
    let iconWrapper: HTMLSpanElement | undefined;
    if (icon || hasFormatIcon || materialIconKind) {
      iconWrapper = document.createElement('span');
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
        iconWrapper.appendChild(icon);
      }
      if (chip.type !== 'external-link') span.appendChild(iconWrapper);
    }

    if (chip.type === 'external-link') {
      const firstCharacter = Array.from(chip.label)[0] ?? '';
      if (iconWrapper && firstCharacter) {
        const leadingContent = document.createElement('span');
        leadingContent.className = 'link-leading-content';
        const leadingLabel = document.createElement('span');
        leadingLabel.className = 'link-leading-label';
        leadingLabel.textContent = firstCharacter;
        leadingContent.append(iconWrapper, leadingLabel);
        span.appendChild(leadingContent);
        span.appendChild(document.createTextNode(chip.label.slice(firstCharacter.length)));
      } else {
        if (iconWrapper) span.appendChild(iconWrapper);
        span.appendChild(document.createTextNode(chip.label));
      }
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
    if (!props.chips.some((chip) => chip.type !== 'external-link')) return false;

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

  function removeTrailingLineBreak(): boolean {
    if (!props.value.endsWith('\n')) return false;
    const selection = getSelectionOffsets();
    if (!selection || selection.start !== selection.end || selection.start !== props.value.length) {
      return false;
    }

    const nextValue = props.value.slice(0, -1);
    revealCaretAfterControlledInput = true;
    props.onInput(nextValue, nextValue.length);
    return true;
  }

  function moveAcrossAtomicReference(event: KeyboardEvent): boolean {
    if (
      (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.isComposing
    ) {
      return false;
    }

    if (!editorEl) return false;
    const selection = getSelectionOffsets();
    if (!selection || selection.start !== selection.end) return false;

    for (const chip of props.chips) {
      if (chip.type === 'external-link' || chip.type === 'mention-session') continue;
      let markerStart = props.value.indexOf(chip.textMarker);
      while (markerStart !== -1) {
        const markerEnd = markerStart + chip.textMarker.length;
        const trailingEdge = props.value[markerEnd] === ' ' ? markerEnd + 1 : markerEnd;
        const nextOffset =
          event.key === 'ArrowLeft' && selection.start === trailingEdge
            ? markerStart
            : event.key === 'ArrowRight' && selection.start === markerStart
              ? trailingEdge
              : null;
        if (nextOffset !== null) {
          event.preventDefault();
          const target = findNodeAtOffset(editorEl, nextOffset);
          if (
            event.key === 'ArrowRight' &&
            target?.node.nodeType === Node.TEXT_NODE &&
            target.node.textContent === CARET_SPACER &&
            target.node.parentNode
          ) {
            const range = document.createRange();
            range.setStart(
              target.node.parentNode,
              Array.from(target.node.parentNode.childNodes).findIndex(
                (child) => child === target.node
              ) + 1
            );
            range.collapse(true);
            const browserSelection = window.getSelection();
            browserSelection?.removeAllRanges();
            browserSelection?.addRange(range);
          } else {
            setCursorOffset(nextOffset);
          }
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
      // SAFETY: The surrounding shape or discriminator check establishes the Element contract used below.
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    const reference = container?.closest<HTMLElement>('.composer-session-reference') ?? null;
    return reference && editorEl?.contains(reference) ? reference : null;
  }

  function removeSessionReferenceAtSelection(insertedText = ''): boolean {
    if (!props.chips.some((chip) => chip.type === 'mention-session')) return false;
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
    if (!props.chips.some((chip) => chip.type === 'mention-session')) return false;
    const range = getSelectionRange();
    if (!range || range.collapsed) return false;
    const selection = getSelectionOffsets(range);
    if (!selection) return false;

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
      // SAFETY: The surrounding shape or discriminator check establishes the Element contract used below.
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

  function getSelectionOffsets(selectionRange?: Range): { start: number; end: number } | null {
    if (!editorEl) return null;
    const range = selectionRange ?? getSelectionRange();
    if (!range) return null;

    const preRange = document.createRange();
    preRange.selectNodeContents(editorEl);
    preRange.setEnd(range.startContainer, range.startOffset);

    let start = extractRangeTextLength(preRange);
    let end = start;
    if (!range.collapsed) {
      const postRange = document.createRange();
      postRange.selectNodeContents(editorEl);
      postRange.setEnd(range.endContainer, range.endOffset);
      end = extractRangeTextLength(postRange);
      const startBoundary = getSessionReferenceBoundary(range.startContainer);
      const endBoundary = getSessionReferenceBoundary(range.endContainer);
      if (startBoundary) start = startBoundary.start;
      if (endBoundary) end = endBoundary.end;
    }
    return { start, end };
  }

  function updateSelectedChips(selection: { start: number; end: number } | null) {
    if (!editorEl) return;
    for (const chip of editorEl.querySelectorAll<HTMLElement>('.inline-chip')) {
      const marker = chip.dataset.chipMarker;
      if (!selection || selection.start === selection.end || !marker) {
        chip.classList.remove('selection-crossed');
        continue;
      }

      const prefixRange = document.createRange();
      prefixRange.selectNodeContents(editorEl);
      prefixRange.setEndBefore(chip);
      const chipStart = extractRangeTextLength(prefixRange);
      chip.classList.toggle(
        'selection-crossed',
        selection.start < chipStart + marker.length && selection.end > chipStart
      );
    }

    for (const icon of editorEl.querySelectorAll<HTMLElement>(
      '.composer-session-reference .inline-chip-icon-wrap, .composer-external-link .inline-chip-icon-wrap'
    )) {
      const reference = icon.parentElement?.closest<HTMLElement>(
        '.composer-session-reference, .composer-external-link'
      );
      if (!selection || selection.start === selection.end || !reference) {
        icon.classList.remove('selection-crossed');
        reference?.classList.remove('selection-end-crossed');
        continue;
      }

      const prefixRange = document.createRange();
      prefixRange.selectNodeContents(editorEl);
      prefixRange.setEndBefore(reference);
      const referenceStart = extractRangeTextLength(prefixRange);
      icon.classList.toggle(
        'selection-crossed',
        selection.start <= referenceStart && selection.end > referenceStart
      );
      const referenceLength = reference.dataset.chipMarker?.length ?? extractText(reference).length;
      reference.classList.toggle(
        'selection-end-crossed',
        selection.start < referenceStart + referenceLength &&
          selection.end >= referenceStart + referenceLength
      );
    }
  }

  function getSessionReferenceBoundary(node: Node): { start: number; end: number } | null {
    if (!editorEl) return null;
    // SAFETY: The surrounding shape or discriminator check establishes the Element contract used below.
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

  function revealCaret(controlledCursorUpdate = false) {
    if ((!revealCaretAfterControlledInput && !controlledCursorUpdate) || !editorEl) return;
    revealCaretAfterControlledInput = false;

    const range = getSelectionRange();
    if (!range?.collapsed || !('getBoundingClientRect' in range)) return;
    let caretRect = range.getBoundingClientRect();
    if (caretRect.height === 0) {
      const cursorOffset = getCursorOffset();
      const marker = document.createElement('span');
      marker.dataset.caretMeasure = 'true';
      marker.style.cssText =
        'display:inline-block;width:0;height:1em;overflow:hidden;vertical-align:text-bottom;pointer-events:none';
      range.cloneRange().insertNode(marker);
      caretRect = marker.getBoundingClientRect();
      marker.remove();
      editorEl.normalize();
      setCursorOffset(cursorOffset);
    }
    if (caretRect.height === 0) return;
    const editorRect = editorEl.getBoundingClientRect();

    if (caretRect.bottom > editorRect.bottom) {
      editorEl.scrollTop += caretRect.bottom - editorRect.bottom;
    } else if (caretRect.top < editorRect.top) {
      editorEl.scrollTop -= editorRect.top - caretRect.top;
    }
  }

  function syncEmptyState() {
    if (!editorEl) return;
    editorEl.dataset.empty = isEditorEmpty(editorEl) ? 'true' : 'false';
  }

  let lastSyncedValue = '';
  let lastSyncedChips = '';
  let lastSyncedPendingPaste: RichComposerPasteInsertion | undefined;

  createEffect(() => {
    const text = props.value;
    const pendingPaste = props.pendingPaste;
    const pendingPasteChanged = pendingPaste !== lastSyncedPendingPaste;
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
          chip.severity,
          chip.problemDetails,
        ])
    );
    if (!editorEl) return;

    const textChanged = text !== lastSyncedValue;
    const chipsChanged = chips !== lastSyncedChips;
    const isFocused = props.isFocused || document.activeElement === editorEl;
    const externalLinksOutOfSync = externalLinksNeedResync(editorEl, text, props.chips);
    const hasExpectedExternalLinks = props.chips.some((chip) => chip.type === 'external-link');
    const preserveEditedExternalLinks =
      isFocused &&
      hasExpectedExternalLinks &&
      editorEl.querySelector('.composer-external-link') !== null;
    const nativeInputAcknowledged =
      nativeInputSync?.value === text &&
      (requestedCursor == null || nativeInputSync.cursorOffset === requestedCursor);
    nativeInputSync = undefined;
    if (
      nativeInputAcknowledged &&
      !chipsChanged &&
      !pendingPasteChanged &&
      (!externalLinksOutOfSync || preserveEditedExternalLinks)
    ) {
      lastSyncedValue = text;
      pendingControlledCursorReveal = false;
      revealCaret();
      return;
    }

    const textNeedsResync = needsResync(editorEl, text);
    const domNeedsResync =
      textNeedsResync || (externalLinksOutOfSync && !preserveEditedExternalLinks);

    if (!textChanged && !chipsChanged && !pendingPasteChanged && !domNeedsResync) {
      let cursorUpdated = false;
      if (isFocused && requestedCursor != null && getCursorOffset() !== requestedCursor) {
        setCursorOffset(Math.min(requestedCursor, text.length));
        cursorUpdated = true;
      }
      revealCaret(cursorUpdated && pendingControlledCursorReveal);
      if (cursorUpdated) pendingControlledCursorReveal = false;
      return;
    }

    lastSyncedValue = text;
    lastSyncedChips = chips;
    lastSyncedPendingPaste = pendingPaste;
    if (pendingPasteChanged && isFocused) revealCaretAfterControlledInput = true;
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
    // Deferred paste resolution can supply the new text before its cursor offset.
    pendingControlledCursorReveal = textChanged && isFocused && !revealCaretAfterControlledInput;
    revealCaret();
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
    const offset = getCursorOffset();
    if (normalizeEditableExternalLinks(editorEl)) setCursorOffset(offset);
    const text = extractText(editorEl);
    editorEl.dataset.empty = text.length === 0 ? 'true' : 'false';
    const previousValue = props.value;
    const previousChips = props.chips.slice();
    lastSyncedValue = text;
    const syncMarker = { value: text, cursorOffset: offset };
    nativeInputSync = syncMarker;
    props.onInput(text, offset);
    queueMicrotask(() => {
      if (nativeInputSync === syncMarker) nativeInputSync = undefined;
    });

    if (!props.onRemoveChip) return;
    for (const chip of previousChips) {
      if (chip.type === 'external-link') continue;
      if (!previousValue.includes(chip.textMarker)) continue;
      if (text.includes(chip.textMarker)) continue;
      props.onRemoveChip(chip.id);
    }
  }

  function handlePaste(e: ClipboardEvent) {
    const selection = getSelectionOffsets();
    props.onPaste(e);
    if (e.defaultPrevented) {
      props.onPasteInsertion?.(
        e,
        selection
          ? {
              start: selection.start,
              end: selection.start,
              text: '',
              value: props.value,
            }
          : null
      );
      return;
    }

    // SAFETY: The surrounding shape or discriminator check establishes the ComposerClipboardEvent contract used below.
    const overrideText = (e as ComposerClipboardEvent).__varroPasteText;
    const text = overrideText ?? e.clipboardData?.getData('text/plain') ?? '';
    if (overrideText !== undefined) {
      e.preventDefault();
    }
    if (!text) {
      props.onPasteInsertion?.(e, null);
      return;
    }
    const insertionRange = selection || {
      start: props.value.length,
      end: props.value.length,
    };
    e.preventDefault();
    const nextValue = `${props.value.slice(0, insertionRange.start)}${text}${props.value.slice(insertionRange.end)}`;
    revealCaretAfterControlledInput = true;
    batch(() => {
      props.onInput(nextValue, insertionRange.start + text.length);
      props.onPasteInsertion?.(e, {
        start: insertionRange.start,
        end: insertionRange.start + text.length,
        text,
        value: nextValue,
      });
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
      revealCaretAfterControlledInput = true;
      props.onInput(nextValue, lineStart);
      return true;
    }

    const bulletPrefix = line.match(/^(\s*-\s+)/)?.[1];
    if (!bulletPrefix || selection.start < lineStart + bulletPrefix.length) {
      e.preventDefault();
      const nextValue = `${props.value.slice(0, selection.start)}\n${props.value.slice(selection.end)}`;
      revealCaretAfterControlledInput = true;
      props.onInput(nextValue, selection.start + 1);
      return true;
    }

    e.preventDefault();
    const insertion = `\n${bulletPrefix}`;
    const nextValue = `${props.value.slice(0, selection.start)}${insertion}${props.value.slice(selection.end)}`;
    revealCaretAfterControlledInput = true;
    props.onInput(nextValue, selection.start + insertion.length);
    return true;
  }

  function showImagePreview(target: EventTarget | null) {
    // SAFETY: The surrounding shape or discriminator check establishes the HTMLElement contract used below.
    const chipElement = (target as HTMLElement | null)?.closest?.<HTMLElement>(
      '.inline-chip[data-preview-image]'
    );
    if (!chipElement?.dataset.chipId) return;
    const chip = props.chips.find((item) => item.id === chipElement.dataset.chipId);
    if (!chip?.previewImage) return;
    unregisterComposerDismiss ??= registerComposerOverlayDismiss(hidePreview);

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
      const selection = document.activeElement === editorEl ? getSelectionOffsets() : null;
      updateSelectedChips(selection);
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
        onContextMenu={handleContextMenu}
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
            if (
              (e.inputType === 'deleteContentBackward' && removeTrailingLineBreak()) ||
              replaceSelectionContainingSession() ||
              removeSessionReferenceAtSelection()
            ) {
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
          if (moveAcrossAtomicReference(e)) return;
          const removedTrailingLineBreak =
            e.key === 'Backspace' &&
            !e.altKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.shiftKey &&
            !e.isComposing &&
            removeTrailingLineBreak();
          if (removedTrailingLineBreak) {
            e.preventDefault();
          } else if (!removeAtomicReference(e)) {
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
          // SAFETY: The surrounding shape or discriminator check establishes the HTMLElement contract used below.
          const sourceChip = (event.target as HTMLElement).closest?.('[data-preview-image]');
          const relatedChip =
            event.relatedTarget instanceof HTMLElement
              ? event.relatedTarget.closest('[data-preview-image]')
              : null;
          if (sourceChip === relatedChip) return;
          hidePreview();
        }}
        onFocus={() => props.onFocus()}
        onBlur={() => props.onBlur()}
        onClick={(e) => {
          // SAFETY: The surrounding shape or discriminator check establishes the HTMLElement contract used below.
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

      <Show when={chipMenu()}>
        {(menu) => (
          <Portal>
            <div
              ref={(element) => {
                chipMenuRef = element;
              }}
              class="session-item-actions-menu"
              role="menu"
              aria-label="Chip actions"
              style={{ left: `${menu().x}px`, top: `${menu().y}px` }}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                closeChipMenu();
                editorEl?.focus();
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const chipId = menu().chipId;
                  closeChipMenu();
                  editorEl?.focus();
                  props.onExpandChip?.(chipId);
                }}
              >
                Expand to Text
              </button>
            </div>
          </Portal>
        )}
      </Show>

      <Show when={props.isFocused && props.showCompletionMenu}>
        <CompletionMenu
          items={props.completionItems}
          selectedIndex={props.completionSelectedIndex}
          header={props.completionHeader}
          emptyMessage={props.completionEmptyMessage}
          anchorRect={() => {
            // Track controlled edits as well as native selection changes.
            void props.value;
            void props.cursorOffset;
            const range = getSelectionRange();
            if (!range || !('getBoundingClientRect' in range)) return null;
            const rect = range.getBoundingClientRect();
            return rect.height > 0 ? rect : null;
          }}
          onSelect={props.onSelectCompletion}
        />
      </Show>
      <For each={problemTooltipTargets()}>
        {(target) => (
          <ProblemsTooltip
            target={target.element}
            text={target.text}
            action="Click to view captured details"
          />
        )}
      </For>
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
    const placeholder = document.createElement('span');
    placeholder.dataset.caretPlaceholder = 'true';
    placeholder.textContent = CARET_SPACER;
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
      // SAFETY: The surrounding shape or discriminator check establishes the HTMLElement contract used below.
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

function getChipIcon(icon?: string): HTMLSpanElement {
  return createUiIconElement(
    icon === 'table'
      ? getMaterialChipIcon('table')
      : icon === 'folder'
        ? folderIcon
        : emptyPageIcon,
    {
      className: 'inline-chip-icon',
      width: 11,
      height: 11,
    }
  );
}

function getMaterialIconKind(icon?: string): MaterialChipIconKind | null {
  if (
    icon === 'agent' ||
    icon === 'skill' ||
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
      // SAFETY: The surrounding shape or discriminator check establishes the HTMLElement contract used below.
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
          return { node: root, offset: idx };
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
  // SAFETY: The surrounding shape or discriminator check establishes the HTMLElement contract used below.
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

function normalizeEditableExternalLinks(editor: HTMLElement): boolean {
  let changed = false;
  for (const element of Array.from(
    editor.querySelectorAll<HTMLElement>('.composer-external-link')
  )) {
    const content = element.textContent ?? '';
    const segments = splitExternalLinkText(content);
    const linkIndex = segments.findIndex((segment) => segment.type === 'external-link');
    if (linkIndex === -1) {
      element.replaceWith(document.createTextNode(content));
      changed = true;
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
    changed = true;
  }
  return changed;
}
