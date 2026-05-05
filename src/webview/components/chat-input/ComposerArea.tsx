import { Show, type JSX } from 'solid-js';
import { CompletionMenu, type CompletionItem } from './CompletionMenu';

export function ComposerArea(props: {
  textareaRef: (el: HTMLTextAreaElement) => void;
  placeholder: string;
  value: string;
  isFocused: boolean;
  showCompletionMenu: boolean;
  completionItems: CompletionItem[];
  completionSelectedIndex: number;
  completionHeader?: string;
  onInput: JSX.EventHandlerUnion<HTMLTextAreaElement, InputEvent>;
  onKeyDown: JSX.EventHandlerUnion<HTMLTextAreaElement, KeyboardEvent>;
  onPaste: JSX.EventHandlerUnion<HTMLTextAreaElement, ClipboardEvent>;
  onFocus: JSX.EventHandlerUnion<HTMLTextAreaElement, FocusEvent>;
  onBlur: JSX.EventHandlerUnion<HTMLTextAreaElement, FocusEvent>;
  onClick: JSX.EventHandlerUnion<HTMLTextAreaElement, MouseEvent>;
  onKeyUp: JSX.EventHandlerUnion<HTMLTextAreaElement, KeyboardEvent>;
  onSelect: JSX.EventHandlerUnion<HTMLTextAreaElement, Event>;
  onSelectCompletion: (item: CompletionItem) => void;
}) {
  return (
    <div class="chat-editor-container">
      <textarea
        ref={props.textareaRef}
        style={{
          'min-height': '30px',
          width: '100%',
          resize: 'none',
          background: 'transparent',
          padding: '4px 4px 4px 4px',
          'font-size': '13px',
          'line-height': '1.45',
          color: 'var(--color-vscode-input-fg)',
          outline: 'none',
          'font-family': 'inherit',
          border: 'none',
        }}
        rows={1}
        placeholder={props.placeholder}
        value={props.value}
        onInput={props.onInput}
        onKeyDown={props.onKeyDown}
        onPaste={props.onPaste}
        onFocus={props.onFocus}
        onBlur={props.onBlur}
        onClick={props.onClick}
        onKeyUp={props.onKeyUp}
        onSelect={props.onSelect}
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
