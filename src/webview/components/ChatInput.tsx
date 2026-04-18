import { Show, For, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import {
  state,
  inputText,
  setInputText,
  isLoading,
  setSelectedAgent,
  setSelectedModel,
  resolveSelectedModel,
  addClipboardImage,
  showModelPicker,
  setShowModelPicker,
  showSettings,
  setShowSettings,
  removeClipboardImage,
  removeContextFile,
  clearClipboardImages,
  clearContextFiles,
} from '../lib/state';
import { postMessage } from '../lib/bridge';
import { sendMessage, abortSession } from '../hooks/useOpenCode';
import { ModelPicker } from './ModelPicker';
import { isAssistantMessage } from '../lib/message-metrics';

export function ChatInput() {
  let textareaRef: HTMLTextAreaElement | undefined;
  let containerRef: HTMLDivElement | undefined;
  const [isDraggingOver, setIsDraggingOver] = createSignal(false);
  const [busyPromptMode, setBusyPromptMode] = createSignal<'queue' | 'steer'>('queue');
  const [showAgentPicker, setShowAgentPicker] = createSignal(false);
  const [showBusyMenu, setShowBusyMenu] = createSignal(false);
  const [isFocused, setIsFocused] = createSignal(false);

  const files = () => state.droppedFiles;
  const clipboardImages = () => state.clipboardImages;
  const selection = () => state.editorContext.selection;
  const activeFile = () => state.editorContext.activeFile;
  const hasContext = () => files().length > 0 || clipboardImages().length > 0 || !!activeFile();

  const activeContext = () => {
    const file = activeFile();
    if (!file) return null;
    const selectedLines = selection();
    if (!selectedLines) return { filename: file.relativePath, lineRange: null as string | null };
    const lineRange =
      selectedLines.startLine === selectedLines.endLine
        ? `L${selectedLines.startLine}`
        : `L${selectedLines.startLine}-${selectedLines.endLine}`;
    return { filename: file.relativePath, lineRange };
  };

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleSend() {
    const text = inputText();
    if (!text.trim() && state.droppedFiles.length === 0 && state.clipboardImages.length === 0)
      return;
    const sendMode = isLoading() ? busyPromptMode() : 'queue';
    setInputText('');
    if (textareaRef) textareaRef.style.height = 'auto';
    await sendMessage(text, { noReply: sendMode === 'steer' });
  }

  function autoResize() {
    if (!textareaRef) return;
    textareaRef.style.height = 'auto';
    textareaRef.style.height = Math.min(textareaRef.scrollHeight, 200) + 'px';
  }

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    const paths = await collectDroppedPaths(e.dataTransfer);
    if (paths.length > 0) {
      postMessage({ type: 'files/drop', payload: { paths } });
    }
  }

  async function handlePaste(e: ClipboardEvent) {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    const imageItems = Array.from(clipboardData.items).filter(
      (item) => item.kind === 'file' && item.type.startsWith('image/')
    );

    if (imageItems.length === 0) return;

    e.preventDefault();

    for (const [index, item] of imageItems.entries()) {
      const file = item.getAsFile();
      if (!file) continue;

      const url = await readFileAsDataUrl(file);
      addClipboardImage({
        id: createAttachmentID(),
        url,
        mime: file.type || 'image/png',
        filename:
          file.name || `pasted-image-${Date.now()}-${index + 1}.${extensionForMime(file.type)}`,
        size: file.size,
      });
    }
  }

  onMount(() => {
    const handleWindowDragOver = (e: DragEvent) => {
      if (!isPathDrop(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };

    const handleWindowDrop = async (e: DragEvent) => {
      if (!isPathDrop(e.dataTransfer)) return;
      e.preventDefault();

      if (!containerRef?.contains(e.target as Node | null)) {
        setIsDraggingOver(false);
        return;
      }

      await handleDrop(e);
    };

    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('drop', handleWindowDrop);

    onCleanup(() => {
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('drop', handleWindowDrop);
    });
  });

  const canSend = () =>
    inputText().trim().length > 0 ||
    state.droppedFiles.length > 0 ||
    state.clipboardImages.length > 0;

  const currentModel = () => {
    const selected = resolveSelectedModel(
      state.selectedModel,
      state.providers,
      state.providerDefaults
    );
    if (selected) {
      const provider = state.providers.find((item) => item.id === selected.providerID);
      const model = provider?.models[selected.modelID];
      return {
        providerID: selected.providerID,
        modelID: selected.modelID,
        variant: selected.variant || null,
        providerName: provider?.name || selected.providerID,
        modelName: model?.name || selected.modelID,
        contextLimit: model?.limit?.context || null,
      };
    }

    const latestAuto = [...assistantMessages()].toReversed()[0];
    if (latestAuto) {
      const provider = state.providers.find((item) => item.id === latestAuto.providerID);
      const model = provider?.models[latestAuto.modelID];
      return {
        providerID: latestAuto.providerID,
        modelID: latestAuto.modelID,
        variant: latestAuto.variant || null,
        providerName: provider?.name || latestAuto.providerID,
        modelName: model?.name || latestAuto.modelID,
        contextLimit: model?.limit?.context || null,
      };
    }

    const firstProvider = state.providers[0];
    if (firstProvider) {
      const defaultModelID = state.providerDefaults[firstProvider.id];
      const defaultModel = defaultModelID
        ? firstProvider.models[defaultModelID]
        : Object.values(firstProvider.models)[0];
      if (defaultModel) {
        return {
          providerID: firstProvider.id,
          modelID: defaultModel.id,
          variant: null,
          providerName: firstProvider.name,
          modelName: defaultModel.name,
          contextLimit: defaultModel.limit?.context || null,
        };
      }
    }

    return {
      providerID: null as string | null,
      modelID: null as string | null,
      variant: null as string | null,
      providerName: '',
      modelName: '',
      contextLimit: null as number | null,
    };
  };

  const assistantMessages = createMemo(() =>
    state.messages.map((entry) => entry.info).filter(isAssistantMessage)
  );

  const selectedAgentLabel = () => {
    const name = state.selectedAgent;
    if (!name) return 'Agent';
    const agent = state.agents.find((a) => a.name === name);
    return agent?.name || name;
  };

  return (
    <div class="interactive-input-part">
      <Show when={showModelPicker()}>
        <ModelPicker
          onSelect={(sel) => {
            if (sel.providerID && sel.modelID) {
              setSelectedModel({
                providerID: sel.providerID,
                modelID: sel.modelID,
                variant: sel.variant,
              });
            }
          }}
          onClose={() => setShowModelPicker(false)}
        />
      </Show>

      <Show when={showAgentPicker()}>
        <AgentPicker
          onSelect={(agent) => {
            setSelectedAgent(agent);
            setShowAgentPicker(false);
          }}
          onClose={() => setShowAgentPicker(false)}
        />
      </Show>

      <div
        ref={containerRef}
        class={`chat-input-container ${isFocused() ? 'focused' : ''} ${isDraggingOver() ? 'focused' : ''}`}
        onDrop={(e) => handleDrop(e as DragEvent)}
        onDragEnter={(e) => {
          if (!isPathDrop(e.dataTransfer)) return;
          e.preventDefault();
          setIsDraggingOver(true);
        }}
        onDragOver={(e) => {
          if (!isPathDrop(e.dataTransfer)) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          setIsDraggingOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setIsDraggingOver(false);
        }}
      >
        <Show when={hasContext()}>
          <div class="chat-attachments-container">
            <Show when={activeContext()}>
              <AttachmentChip label={activeContext()!.filename} detail={activeContext()!.lineRange} />
            </Show>
            <For each={files()}>
              {(file) => (
                <AttachmentChip
                  label={file.relativePath}
                  onRemove={() => removeContextFile(file.path)}
                />
              )}
            </For>
            <For each={clipboardImages()}>
              {(image) => (
                <AttachmentChip
                  label={image.filename}
                  icon="image"
                  onRemove={() => removeClipboardImage(image.id)}
                />
              )}
            </For>
            <Show when={files().length > 1 || clipboardImages().length > 1}>
              <button
                class="chat-attachment-chip"
                style={{ cursor: 'pointer', border: 'none', background: 'none', opacity: 0.4, 'font-size': '10px' }}
                onClick={() => {
                  clearContextFiles();
                  clearClipboardImages();
                }}
                title="Clear all"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
                </svg>
              </button>
            </Show>
          </div>
        </Show>

        <div class="chat-editor-container" style={{ padding: '4px 0 0 4px' }}>
          <textarea
            ref={textareaRef!}
            style={{
              'min-height': '36px',
              width: '100%',
              resize: 'none',
              background: 'transparent',
              padding: '0 8px',
              'font-size': '13px',
              'line-height': '1.45',
              color: 'var(--color-vscode-input-fg)',
              outline: 'none',
              'font-family': 'inherit',
              border: 'none',
            }}
            rows={1}
            placeholder={
              isLoading()
                ? busyPromptMode() === 'steer'
                  ? 'Steer current run...'
                  : 'Describe what to build'
                : 'Describe what to build'
            }
            value={inputText()}
            onInput={(e) => {
              setInputText(e.currentTarget.value);
              autoResize();
            }}
            onKeyDown={handleKeydown}
            onPaste={handlePaste}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
          />
        </div>

        <div class="chat-input-toolbars">
          <button
            class="toolbar-icon"
            onClick={() => postMessage({ type: 'context/request' })}
            title="Add context"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
              <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
            </svg>
          </button>

          <Show when={state.agents.length > 0}>
            <button
              class="toolbar-picker"
              onClick={() => {
                setShowAgentPicker(!showAgentPicker());
                setShowModelPicker(false);
                setShowBusyMenu(false);
              }}
              title="Select agent"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M14 8A6 6 0 102 8a6 6 0 0012 0zm-1 0A5 5 0 113 8a5 5 0 0110 0z" />
              </svg>
              <span style={{ 'max-width': '100px', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>{selectedAgentLabel()}</span>
              <svg class="codicon-chevron" width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4.5 6l3.5 4 3.5-4z" />
              </svg>
            </button>
          </Show>

          <button
            class="toolbar-picker"
            onClick={() => {
              setShowModelPicker(!showModelPicker());
              setShowAgentPicker(false);
              setShowBusyMenu(false);
            }}
            title={
              currentModel().modelName
                ? `${currentModel().providerName} / ${currentModel().modelName}`
                : 'Choose model'
            }
          >
            <Show when={currentModel().modelName} fallback={<span>Model</span>}>
              <span style={{ 'max-width': '180px', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
                {currentModel().modelName}
                <Show when={currentModel().variant}>
                  <span style={{ opacity: 0.5 }}>
                    {' '}
                    · {formatThinkingLabel(currentModel().variant!)}
                  </span>
                </Show>
              </span>
            </Show>
            <svg class="codicon-chevron" width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.5 6l3.5 4 3.5-4z" />
            </svg>
          </button>

          <button
            class={`toolbar-icon ${showSettings() ? 'active' : ''}`}
            onClick={() => setShowSettings(!showSettings())}
            title="Model settings"
            style={showSettings() ? { background: 'var(--color-vscode-toolbar-hover)' } : {}}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M3.5 2h-1v5h1V2zm6.1 5H6.4L6 6.45v-1L6.4 5h3.2l.4.5v1l-.4.5zm-5 3H1.4L1 9.5v-1l.4-.5h3.2l.4.5v1l-.4.5zm3.9-8h-1v12h1V2zm-1 4h-1v8h1V6zm8-2h-1v10h1V4zm-2.1 3h-3.2l-.4.5v1l.4.5h3.2l.4-.5v-1l-.4-.5z" />
            </svg>
          </button>

          <div style={{ 'margin-left': 'auto', display: 'flex', 'align-items': 'center', gap: '4px' }}>
            <Show when={isLoading()}>
              <div style={{ position: 'relative' }}>
                <button
                  class="chat-stop-button"
                  onClick={() => {
                    if (canSend()) {
                      setShowBusyMenu(!showBusyMenu());
                    } else {
                      abortSession();
                    }
                  }}
                  title={canSend() ? 'Send options' : 'Stop'}
                >
                  <Show
                    when={canSend()}
                    fallback={
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                        <rect x="4" y="4" width="8" height="8" rx="1" />
                      </svg>
                    }
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm3 4l-4 6H5l2-3H5l4-6h2l-2 3h2z" />
                    </svg>
                  </Show>
                </button>

                <Show when={showBusyMenu() && canSend()}>
                  <div
                    style={{
                      position: 'absolute',
                      bottom: '100%',
                      right: 0,
                      'z-index': 50,
                      'margin-bottom': '4px',
                      width: '210px',
                      overflow: 'hidden',
                      'border-radius': '4px',
                      border: '1px solid var(--color-vscode-widget-border)',
                      background: 'var(--color-vscode-widget-bg)',
                      'box-shadow': '0 -4px 16px rgba(0,0,0,0.3)',
                    }}
                    onClick={() => setShowBusyMenu(false)}
                  >
                    <button
                      style={{
                        display: 'flex',
                        width: '100%',
                        'align-items': 'center',
                        gap: '8px',
                        padding: '6px 10px',
                        'text-align': 'left',
                        'font-size': '12px',
                        color: 'var(--color-vscode-fg)',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-vscode-hover)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                      onClick={() => {
                        abortSession();
                        handleSend();
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ color: 'var(--color-vscode-error)' }}>
                        <path d="M1 1.91L1.78 1.5 15 8 1.78 14.5 1 14.09 3.61 8 1 1.91z" />
                      </svg>
                      Stop and Send
                    </button>
                    <button
                      style={{
                        display: 'flex',
                        width: '100%',
                        'align-items': 'center',
                        'justify-content': 'space-between',
                        padding: '6px 10px',
                        'text-align': 'left',
                        'font-size': '12px',
                        color: 'var(--color-vscode-fg)',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-vscode-hover)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                      onClick={() => {
                        setBusyPromptMode('queue');
                        handleSend();
                      }}
                    >
                      <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ color: 'var(--color-vscode-muted)' }}>
                          <path d="M14 7H9V2H7v5H2v2h5v5h2V9h5V7z" />
                        </svg>
                        Add to Queue
                      </div>
                      <span style={{ 'font-size': '11px', color: 'var(--color-vscode-muted)', opacity: 0.4 }}>Enter</span>
                    </button>
                    <button
                      style={{
                        display: 'flex',
                        width: '100%',
                        'align-items': 'center',
                        'justify-content': 'space-between',
                        padding: '6px 10px',
                        'text-align': 'left',
                        'font-size': '12px',
                        color: 'var(--color-vscode-fg)',
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-vscode-hover)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                      onClick={() => {
                        setBusyPromptMode('steer');
                        handleSend();
                      }}
                    >
                      <div style={{ display: 'flex', 'align-items': 'center', gap: '8px' }}>
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ color: 'var(--color-vscode-muted)' }}>
                          <path d="M7.5 1L9 5h4l-3.5 3 1.5 4.5L7.5 10 4 12.5 5.5 8 2 5h4l1.5-4z" />
                        </svg>
                        Steer with Message
                      </div>
                      <span style={{ 'font-size': '11px', color: 'var(--color-vscode-muted)', opacity: 0.4 }}>{'\u2303'}Enter</span>
                    </button>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={!isLoading()}>
              <button
                class={`chat-send-button ${canSend() ? 'enabled' : 'disabled'}`}
                onClick={handleSend}
                disabled={!canSend()}
                title="Send (Enter)"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1 1.91L1.78 1.5 15 8 1.78 14.5 1 14.09 3.61 8 1 1.91zM3.39 8.5L1.72 13.09 13.31 8 1.72 2.91 3.39 7.5H9v1H3.39z" />
                </svg>
              </button>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentPicker(props: { onSelect: (agent: string) => void; onClose: () => void }) {
  return (
    <div style={{ position: 'absolute', inset: '0 auto auto 0', 'z-index': 50, 'margin': '0 12px' }} onClick={props.onClose}>
      <div
        style={{
          width: '100%',
          overflow: 'hidden',
          'border-radius': '4px',
          border: '1px solid var(--color-vscode-widget-border)',
          background: 'var(--color-vscode-widget-bg)',
          'box-shadow': '0 4px 16px rgba(0,0,0,0.3)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <For each={state.agents}>
          {(agent) => (
            <button
              style={{
                display: 'flex',
                width: '100%',
                'align-items': 'center',
                gap: '8px',
                padding: '6px 10px',
                'text-align': 'left',
                'font-size': '12px',
                background: state.selectedAgent === agent.name ? 'var(--color-vscode-hover)' : 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--color-vscode-fg)',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--color-vscode-hover)')}
              onMouseLeave={(e) => {
                if (state.selectedAgent !== agent.name) e.currentTarget.style.background = 'none';
              }}
              onClick={() => props.onSelect(agent.name)}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ color: 'var(--color-vscode-muted)', 'flex-shrink': 0 }}>
                <path d="M14 8A6 6 0 102 8a6 6 0 0012 0zm-1 0A5 5 0 113 8a5 5 0 0110 0z" />
              </svg>
              <span style={{ flex: 1, 'font-weight': 500 }}>{agent.name}</span>
              <Show when={agent.description}>
                <span style={{ 'font-size': '11px', color: 'var(--color-vscode-muted)', opacity: 0.6 }}>{agent.description}</span>
              </Show>
              <Show when={state.selectedAgent === agent.name}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ color: 'var(--color-vscode-accent)', 'flex-shrink': 0 }}>
                  <path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z" />
                </svg>
              </Show>
            </button>
          )}
        </For>
        <Show when={state.agents.length === 0}>
          <div style={{ padding: '12px 10px', 'text-align': 'center', 'font-size': '11px', color: 'var(--color-vscode-muted)' }}>
            No agents available
          </div>
        </Show>
      </div>
    </div>
  );
}

function AttachmentChip(props: {
  label: string;
  detail?: string | null;
  icon?: 'file' | 'image';
  onRemove?: () => void;
}) {
  return (
    <span class="chat-attachment-chip">
      <Show when={props.icon === 'image'}>
        <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M14.5 2h-13a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h13a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5zM2 3h12v7.3l-2.6-2.6a.5.5 0 00-.7 0L7.5 11 5.9 9.4a.5.5 0 00-.7 0L2 12.6V3zm3.5 4a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
        </svg>
      </Show>
      <Show when={props.icon !== 'image'}>
        <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1z" />
        </svg>
      </Show>
      <span class="chip-label">{props.label}</span>
      <Show when={props.detail}>
        <span class="chip-detail">{props.detail}</span>
      </Show>
      <Show when={props.onRemove}>
        <button class="chip-remove" onClick={() => props.onRemove?.()}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
          </svg>
        </button>
      </Show>
    </span>
  );
}

async function collectDroppedPaths(dataTransfer: DataTransfer | null): Promise<string[]> {
  if (!dataTransfer) return [];

  const paths = new Set<string>();

  for (const type of ['text/uri-list', 'text/plain']) {
    for (const path of parseDroppedText(dataTransfer.getData(type))) {
      paths.add(path);
    }
  }

  for (const file of Array.from(dataTransfer.files)) {
    const path = (file as File & { path?: string }).path;
    if (path) paths.add(path);
  }

  for (const item of Array.from(dataTransfer.items)) {
    const file = item.getAsFile() as (File & { path?: string }) | null;
    if (file?.path) paths.add(file.path);
  }

  if (paths.size === 0) {
    const itemText = await Promise.all(
      Array.from(dataTransfer.items)
        .filter(
          (item) =>
            item.kind === 'string' && (item.type === 'text/uri-list' || item.type === 'text/plain')
        )
        .map(readDroppedItem)
    );

    for (const value of itemText) {
      for (const path of parseDroppedText(value)) {
        paths.add(path);
      }
    }
  }

  return Array.from(paths);
}

function isPathDrop(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types || []);
  return types.includes('Files') || types.includes('text/uri-list');
}

function readDroppedItem(item: DataTransferItem): Promise<string> {
  return new Promise((resolve) => {
    item.getAsString((value) => resolve(value || ''));
  });
}

function parseDroppedText(value: string): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(decodeDroppedPath)
    .filter((path): path is string => Boolean(path));
}

function decodeDroppedPath(value: string): string | null {
  if (value.startsWith('file://')) {
    try {
      const pathname = decodeURIComponent(new URL(value).pathname);
      return pathname.replace(/^\/([A-Za-z]:\/)/, '$1');
    } catch {
      return null;
    }
  }
  return value.startsWith('/') ? value : null;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result || '')));
    reader.addEventListener('error', () => reject(reader.error || new Error('Failed to read clipboard image')));
    reader.readAsDataURL(file);
  });
}

function createAttachmentID() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function extensionForMime(mime: string) {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'png';
  }
}

function formatThinkingLabel(variant: string) {
  return variant
    .split(/[-_]/g)
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(' ');
}
