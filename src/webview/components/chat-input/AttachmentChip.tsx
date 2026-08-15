import { Show, createSignal } from 'solid-js';
import { Portal } from 'solid-js/web';
import { AttachmentLabel } from '../AttachmentLabel';
import { FileTypeIcon } from '../FileTypeIcon';
import { FolderIcon } from '../FolderIcon';
import { MaterialChipIcon } from '../MaterialChipIcon';
import { WarningIcon } from '../WarningIcon';

export function AttachmentChip(props: {
  label: string;
  path?: string;
  detail?: string | null;
  disabled?: boolean;
  icon?: 'file' | 'folder' | 'image' | 'terminal' | 'warning';
  toggle?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  previewImage?: { url: string; alt: string };
  title?: string;
}) {
  const [previewStyle, setPreviewStyle] = createSignal<Record<string, string> | null>(null);
  const [showTitle, setShowTitle] = createSignal(props.title !== props.label);
  const hasFormatIcon = () =>
    props.icon === 'file' ||
    props.icon === undefined ||
    (props.icon === 'image' && /\.[^./]+$/.test(props.path || props.label));
  let labelElement: HTMLSpanElement | undefined;

  const updateTitleVisibility = () => {
    if (props.title !== props.label) return;
    const stem = labelElement?.querySelector<HTMLElement>('.chip-label-stem');
    const isTruncated = stem
      ? stem.scrollWidth > stem.clientWidth
      : Boolean(labelElement && labelElement.scrollWidth > labelElement.clientWidth);
    setShowTitle(isTruncated);
  };

  const hidePreview = () => setPreviewStyle(null);
  const showPreview = (element: HTMLElement) => {
    updateTitleVisibility();
    if (!props.previewImage) return;

    const rect = element.getBoundingClientRect();
    const chatRect = element.closest<HTMLElement>('.chat-input-shell')?.getBoundingClientRect();
    const edgeGap = 10;
    const anchorGap = 22;
    const chatLeft = Math.max(chatRect?.left ?? 0, edgeGap);
    const chatRight = Math.min(chatRect?.right ?? window.innerWidth, window.innerWidth - edgeGap);
    const maxWidth = Math.max(120, (chatRect?.width ?? window.innerWidth) * 0.8);
    const constrainedWidth = Math.min(maxWidth, chatRight - chatLeft);
    const chipCenter = rect.left + rect.width / 2;
    const center = Math.min(
      Math.max(chipCenter, chatLeft + constrainedWidth / 2),
      chatRight - constrainedWidth / 2
    );

    setPreviewStyle({
      left: `${center}px`,
      bottom: `${window.innerHeight - rect.top + anchorGap}px`,
      '--attachment-preview-max-width': `${constrainedWidth}px`,
      '--attachment-preview-max-height': `${Math.max(80, Math.min(300, rect.top - anchorGap - edgeGap))}px`,
      '--attachment-preview-tail-offset': `${chipCenter - center}px`,
    });
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (!props.onClick) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    props.onClick();
  };

  return (
    <span
      class={`chat-attachment-chip${props.disabled ? ' disabled' : ''}${props.onClick ? ' clickable' : ''}`}
      title={showTitle() ? props.title : undefined}
      aria-disabled={props.disabled ? 'true' : undefined}
      aria-pressed={
        props.onClick && props.toggle ? (!props.disabled ? 'true' : 'false') : undefined
      }
      role={props.onClick ? 'button' : undefined}
      tabIndex={props.onClick ? 0 : undefined}
      onClick={() => props.onClick?.()}
      onKeyDown={handleKeyDown}
      onMouseEnter={(event) => showPreview(event.currentTarget)}
      onMouseLeave={hidePreview}
      onFocus={(event) => showPreview(event.currentTarget)}
      onBlur={hidePreview}
    >
      <Show when={props.onRemove}>
        <button
          class="chip-remove"
          onClick={(e) => {
            e.stopPropagation();
            props.onRemove?.();
          }}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
          </svg>
        </button>
      </Show>
      <Show when={props.icon === 'image' && !hasFormatIcon()}>
        <MaterialChipIcon kind="image" class="chip-icon" />
      </Show>
      <Show when={props.icon === 'folder'}>
        <FolderIcon class="chip-icon" width="12" height="12" />
      </Show>
      <Show when={props.icon === 'terminal'}>
        <MaterialChipIcon kind="terminal" class="chip-icon" />
      </Show>
      <Show when={props.icon === 'warning'}>
        <WarningIcon class="chip-icon" width={12} height={12} />
      </Show>
      <Show when={hasFormatIcon()}>
        <FileTypeIcon path={props.path || props.label} class="chip-icon" />
      </Show>
      <AttachmentLabel
        ref={(element) => (labelElement = element)}
        label={props.label}
        preserveExtension={props.icon !== 'folder' && props.icon !== 'terminal'}
      />
      <Show when={props.detail}>
        <span class="chip-detail">{props.detail}</span>
      </Show>
      <Portal>
        <Show when={props.previewImage && previewStyle()}>
          <div class="chat-attachment-image-preview" style={previewStyle() ?? undefined}>
            <img src={props.previewImage!.url} alt={props.previewImage!.alt} />
          </div>
        </Show>
      </Portal>
    </span>
  );
}
