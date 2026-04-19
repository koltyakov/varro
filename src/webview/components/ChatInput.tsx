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
  removeClipboardImage,
  removeContextFile,
  clearClipboardImages,
  clearContextFiles,
} from '../lib/state';
import { postMessage } from '../lib/bridge';
import { sendMessage, abortSession } from '../hooks/useOpenCode';
import { ModelPicker, getVariantsForModel, formatThinkingLabel } from './ModelPicker';
import {
  isAssistantMessage,
  getContextWindow,
  sumAssistantTokens,
  formatNumber,
} from '../lib/message-metrics';
import { getLeafPathName } from '../lib/path-display';
import { TodoList } from './TodoList';

export function ChatInput() {
  // oxlint-disable-next-line no-unassigned-vars
  let textareaRef: HTMLTextAreaElement | undefined;
  // oxlint-disable-next-line no-unassigned-vars
  let containerRef: HTMLDivElement | undefined;
  const [isDraggingOver, setIsDraggingOver] = createSignal(false);
  const [showAgentPicker, setShowAgentPicker] = createSignal(false);
  const [showBusyMenu, setShowBusyMenu] = createSignal(false);
  const [showVariantPicker, setShowVariantPicker] = createSignal(false);
  const [showContextPopup, setShowContextPopup] = createSignal(false);
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
    if (!selectedLines) {
      return {
        filename: getLeafPathName(file.relativePath),
        lineRange: null as string | null,
      };
    }
    const lineRange =
      selectedLines.startLine === selectedLines.endLine
        ? `L${selectedLines.startLine}`
        : `L${selectedLines.startLine}-${selectedLines.endLine}`;
    return {
      filename: getLeafPathName(file.relativePath),
      lineRange,
    };
  };

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && isLoading()) {
        handleSend('steer');
      } else {
        handleSend();
      }
    }
  }

  async function handleSend(mode?: 'queue' | 'steer') {
    const text = inputText();
    if (!text.trim() && state.droppedFiles.length === 0 && state.clipboardImages.length === 0)
      return;
    setInputText('');
    if (textareaRef) textareaRef.style.height = 'auto';
    await sendMessage(text, { noReply: mode === 'steer' });
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

    const dataTransfer = e.dataTransfer;
    if (!dataTransfer) return;

    const paths = await collectDroppedPaths(dataTransfer);
    if (paths.length > 0) {
      postMessage({ type: 'files/drop', payload: { paths } });
      return;
    }

    // Async fallback: try reading items one by one via getAsString
    const uriList = await readItemByType(dataTransfer, 'text/uri-list');
    if (uriList) {
      const uris = parseDroppedText(uriList);
      if (uris.length > 0) {
        postMessage({ type: 'files/drop', payload: { paths: uris } });
        return;
      }
    }

    // Try any vscode-specific type
    for (const type of Array.from(dataTransfer.types || [])) {
      if (type.startsWith('application/vnd.code.')) {
        const data = await readItemByType(dataTransfer, type);
        const uris = parseDroppedText(data);
        if (uris.length > 0) {
          postMessage({ type: 'files/drop', payload: { paths: uris } });
          return;
        }
      }
    }

    const plainText = await readItemByType(dataTransfer, 'text/plain');
    if (plainText) {
      const uris = parseDroppedText(plainText);
      if (uris.length > 0) {
        postMessage({ type: 'files/drop', payload: { paths: uris } });
      }
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
    const handleWindowClick = (e: MouseEvent) => {
      if (!containerRef?.contains(e.target as Node | null)) {
        setShowAgentPicker(false);
        setShowModelPicker(false);
        setShowVariantPicker(false);
        setShowBusyMenu(false);
        setShowContextPopup(false);
      }
    };

    const beginDropTarget = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setIsDraggingOver(true);
    };

    const handleWindowDragOver = (e: DragEvent) => {
      // Always accept drops so the browser fires the drop event.
      // VS Code explorer drags may not expose MIME types during dragover.
      beginDropTarget(e);
    };

    const handleWindowDrop = async (e: DragEvent) => {
      e.preventDefault();
      setIsDraggingOver(false);
      await handleDrop(e);
    };

    const handleWindowDragLeave = (e: DragEvent) => {
      if (e.relatedTarget) return;
      setIsDraggingOver(false);
    };

    window.addEventListener('click', handleWindowClick, true);
    document.addEventListener('dragenter', beginDropTarget, true);
    document.addEventListener('dragover', handleWindowDragOver, true);
    document.addEventListener('drop', handleWindowDrop, true);
    document.addEventListener('dragleave', handleWindowDragLeave, true);
    window.addEventListener('dragenter', beginDropTarget, true);
    window.addEventListener('dragover', handleWindowDragOver, true);
    window.addEventListener('drop', handleWindowDrop, true);
    window.addEventListener('dragleave', handleWindowDragLeave, true);

    onCleanup(() => {
      window.removeEventListener('click', handleWindowClick, true);
      document.removeEventListener('dragenter', beginDropTarget, true);
      document.removeEventListener('dragover', handleWindowDragOver, true);
      document.removeEventListener('drop', handleWindowDrop, true);
      document.removeEventListener('dragleave', handleWindowDragLeave, true);
      window.removeEventListener('dragenter', beginDropTarget, true);
      window.removeEventListener('dragover', handleWindowDragOver, true);
      window.removeEventListener('drop', handleWindowDrop, true);
      window.removeEventListener('dragleave', handleWindowDragLeave, true);
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

    // Prefer a provider that has a configured default model
    for (const provider of state.providers) {
      const defaultModelID = state.providerDefaults[provider.id];
      if (defaultModelID && provider.models[defaultModelID]) {
        const model = provider.models[defaultModelID];
        return {
          providerID: provider.id,
          modelID: model.id,
          variant: null,
          providerName: provider.name,
          modelName: model.name,
          contextLimit: model.limit?.context || null,
        };
      }
    }

    // Fall back to first provider's first model
    const firstProvider = state.providers[0];
    if (firstProvider) {
      const firstModel = Object.values(firstProvider.models)[0];
      if (firstModel) {
        return {
          providerID: firstProvider.id,
          modelID: firstModel.id,
          variant: null,
          providerName: firstProvider.name,
          modelName: firstModel.name,
          contextLimit: firstModel.limit?.context || null,
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

  const contextUsage = createMemo(() => {
    const assistants = assistantMessages();
    if (assistants.length === 0) return null;
    let best = null;
    for (let i = assistants.length - 1; i >= 0; i--) {
      const msg = assistants[i];
      const hasTokens = (msg.tokens.input || 0) + (msg.tokens.output || 0) > 0;
      if (hasTokens) {
        best = msg;
        break;
      }
    }
    if (!best) return null;
    const ctx = getContextWindow(best, state.providers);
    if (!ctx) return null;
    return ctx;
  });

  const sessionTokens = createMemo(() => sumAssistantTokens(assistantMessages()));

  const availableVariants = createMemo(() => {
    const model = currentModel();
    return getVariantsForModel(model.providerID, model.modelID, state.providers).filter(
      (v) => v !== 'none'
    );
  });

  const effectiveVariant = createMemo(() => {
    const variants = availableVariants();
    if (variants.length === 0) return null;
    return currentModel().variant && variants.includes(currentModel().variant!)
      ? currentModel().variant
      : variants[0];
  });

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

      <Show when={isDraggingOver()}>
        <div class="chat-drop-overlay" aria-hidden="true" />
      </Show>

      <div
        ref={containerRef}
        class={`chat-input-container ${isFocused() ? 'focused' : ''} ${showContextPopup() || showAgentPicker() || showVariantPicker() || showBusyMenu() ? 'showing-context-popup' : ''}`}
        onDragEnter={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          setIsDraggingOver(true);
        }}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          setIsDraggingOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setIsDraggingOver(false);
        }}
        onDrop={handleDrop}
      >
        <Show when={state.todos.length > 0}>
          <TodoList />
        </Show>

        <Show when={hasContext()}>
          <div class="chat-attachments-container">
            <Show when={activeContext()}>
              <AttachmentChip
                label={activeContext()!.filename}
                detail={activeContext()!.lineRange}
              />
            </Show>
            <For each={files()}>
              {(file) => (
                <AttachmentChip
                  label={getDroppedFileLabel(file)}
                  icon={file.type === 'directory' ? 'folder' : 'file'}
                  onRemove={() => {
                    removeContextFile(file.path);
                    postMessage({ type: 'files/remove', payload: { path: file.path } });
                  }}
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
                style={{
                  cursor: 'pointer',
                  border: 'none',
                  background: 'none',
                  opacity: 0.4,
                  'font-size': '10px',
                }}
                onClick={() => {
                  clearContextFiles();
                  clearClipboardImages();
                  postMessage({ type: 'files/clear' });
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

        <div class="chat-editor-container">
          <textarea
            ref={textareaRef!}
            style={{
              'min-height': '36px',
              width: '100%',
              resize: 'none',
              background: 'transparent',
              padding: '0 0 0 6px',
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
                ? 'Queue a follow-up or steer with \u2303Enter...'
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
            onClick={() => {
              setShowAgentPicker(false);
              setShowModelPicker(false);
              setShowVariantPicker(false);
              setShowBusyMenu(false);
            }}
          />
        </div>

        <div class="chat-input-toolbars">
          <div class={`toolbar-left${showContextPopup() || showAgentPicker() || showVariantPicker() ? ' showing-context-popup' : ''}`}>
            <Show when={state.agents.length > 0}>
              <div style={{ position: 'relative' }}>
                <button
                  class="toolbar-picker"
                  onClick={() => {
                    setShowAgentPicker(!showAgentPicker());
                    setShowModelPicker(false);
                    setShowVariantPicker(false);
                    setShowContextPopup(false);
                    setShowBusyMenu(false);
                  }}
                  title="Select agent"
                >
                  <span class="toolbar-picker-label">{selectedAgentLabel()}</span>
                  <svg class="codicon-chevron" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </button>
                <Show when={showAgentPicker()}>
                  <div class="toolbar-popover" onClick={(e) => e.stopPropagation()}>
                    <For each={state.agents}>
                      {(agent) => (
                        <button
                          class={`toolbar-popover-item ${state.selectedAgent === agent.name ? 'selected' : ''}`}
                          onClick={() => {
                            setSelectedAgent(agent.name);
                            setShowAgentPicker(false);
                          }}
                        >
                          {agent.name}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>

            <button
              class="toolbar-picker model-picker-btn"
              onClick={() => {
                setShowModelPicker(!showModelPicker());
                setShowAgentPicker(false);
                setShowVariantPicker(false);
                setShowBusyMenu(false);
              }}
              title={
                currentModel().modelName
                  ? `${currentModel().providerName} / ${currentModel().modelName}`
                  : 'Choose model'
              }
            >
              <Show when={currentModel().modelName} fallback={<span>Model</span>}>
                <span class="toolbar-picker-label model-name">{currentModel().modelName}</span>
              </Show>
              <svg class="codicon-chevron" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </button>

            <Show when={availableVariants().length > 0}>
              <div style={{ position: 'relative' }}>
                <button
                  class="toolbar-picker"
                  onClick={() => {
                    setShowVariantPicker(!showVariantPicker());
                    setShowAgentPicker(false);
                    setShowModelPicker(false);
                    setShowContextPopup(false);
                    setShowBusyMenu(false);
                  }}
                  title="Thinking level"
                >
                  <span class="toolbar-picker-label">{formatThinkingLabel(effectiveVariant()!)}</span>
                  <svg class="codicon-chevron" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 6l4 4 4-4" />
                  </svg>
                </button>
                <Show when={showVariantPicker()}>
                  <div class="toolbar-popover" onClick={(e) => e.stopPropagation()}>
                    <For each={availableVariants()}>
                      {(v) => (
                        <button
                          class={`toolbar-popover-item ${effectiveVariant() === v ? 'selected' : ''}`}
                          onClick={() => {
                            const m = currentModel();
                            setSelectedModel({
                              providerID: m.providerID!,
                              modelID: m.modelID!,
                              variant: v,
                            });
                            setShowVariantPicker(false);
                          }}
                        >
                          {formatThinkingLabel(v)}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>

            <Show when={contextUsage()}>
              <div style={{ position: 'relative' }}>
                <button
                  class={`chat-context-usage ${contextUsage()!.percent >= 75 ? (contextUsage()!.percent >= 90 ? 'error' : 'warning') : ''}`}
                  onClick={() => {
                    setShowContextPopup(!showContextPopup());
                    setShowAgentPicker(false);
                    setShowModelPicker(false);
                    setShowVariantPicker(false);
                    setShowBusyMenu(false);
                  }}
                  title="Context usage"
                >
                  <svg class="circular-progress" viewBox="0 0 36 36">
                    <circle class="progress-bg" cx="18" cy="18" r="14" />
                    <circle
                      class="progress-arc"
                      cx="18"
                      cy="18"
                      r="14"
                      stroke-dasharray="87.96"
                      stroke-dashoffset={`${87.96 - (contextUsage()!.percent / 100) * 87.96}`}
                    />
                  </svg>
                </button>
                <Show when={showContextPopup()}>
                  <ContextPopup
                    usage={contextUsage()!}
                    tokens={sessionTokens()}
                    model={currentModel()}
                    onClose={() => setShowContextPopup(false)}
                  />
                </Show>
              </div>
            </Show>
          </div>

          <div class="toolbar-right">
            <Show when={isLoading()}>
              <button
                class="toolbar-picker stop-button"
                onClick={() => abortSession()}
                title="Stop"
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                  <rect x="3" y="3" width="10" height="10" rx="1.5" />
                </svg>
                <span class="toolbar-picker-label">Stop</span>
              </button>
            </Show>

            <div style={{ position: 'relative' }}>
              <Show when={isLoading() && canSend()} fallback={
                <button
                  class={`chat-send-button ${canSend() ? 'enabled' : 'disabled'}`}
                  onClick={() => canSend() && handleSend()}
                  disabled={!canSend()}
                  title="Send (Enter)"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 2.5L3.5 7H6v6.5h4V7h2.5L8 2.5z" />
                  </svg>
                </button>
              }>
                <div class="send-button-group">
                  <button
                    class="chat-send-button enabled send-main"
                    onClick={() => handleSend()}
                    title="Add to queue (Enter)"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M8 2.5L3.5 7H6v6.5h4V7h2.5L8 2.5z" />
                    </svg>
                  </button>
                  <button
                    class="send-mode-chevron"
                    onClick={() => setShowBusyMenu(!showBusyMenu())}
                    title="More send options"
                  >
                    <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M4 10l4-4 4 4" />
                    </svg>
                  </button>
                </div>
              </Show>

              <Show when={showBusyMenu() && canSend() && isLoading()}>
                <div class="toolbar-popover busy-menu" onClick={(e) => e.stopPropagation()}>
                  <button
                    class="toolbar-popover-item"
                    onClick={() => { handleSend(); setShowBusyMenu(false); }}
                  >
                    <span class="busy-menu-icon">
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M8 3v10M3 8h10" />
                      </svg>
                    </span>
                    <span class="busy-menu-label">Add to Queue</span>
                    <span class="busy-menu-hint">Enter</span>
                  </button>
                  <button
                    class="toolbar-popover-item"
                    onClick={() => { handleSend('steer'); setShowBusyMenu(false); }}
                  >
                    <span class="busy-menu-icon">
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M8 2l1.8 4.8H15l-4 3.4 1.6 5L8 12l-4.6 3.2 1.6-5-4-3.4h5.2z" />
                      </svg>
                    </span>
                    <span class="busy-menu-label">Steer with Message</span>
                    <span class="busy-menu-hint">{'\u2303'}Enter</span>
                  </button>
                  <button
                    class="toolbar-popover-item"
                    onClick={() => { abortSession(); handleSend(); setShowBusyMenu(false); }}
                  >
                    <span class="busy-menu-icon" style={{ color: 'var(--color-vscode-error)' }}>
                      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M2 3l12 10M14 3L2 13" />
                      </svg>
                    </span>
                    <span class="busy-menu-label">Stop and Send</span>
                  </button>
                </div>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ContextPopup(props: {
  usage: { used: number; limit: number; percent: number };
  tokens: {
    total: number;
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  model: { providerName: string; modelName: string };
  onClose: () => void;
}) {
  const rows = () => {
    const t = props.tokens;
    const items: Array<{ label: string; value: number; color?: string }> = [
      { label: 'Input', value: t.input },
      { label: 'Output', value: t.output },
    ];
    if (t.reasoning > 0) items.push({ label: 'Reasoning', value: t.reasoning });
    if (t.cacheRead > 0) items.push({ label: 'Cache read', value: t.cacheRead });
    if (t.cacheWrite > 0) items.push({ label: 'Cache write', value: t.cacheWrite });
    return items;
  };

  return (
    <div class="context-popup" onClick={(e) => e.stopPropagation()}>
      <div class="context-popup-header">
        <span class="context-popup-title">Context Window</span>
        <span class="context-popup-pct">{Math.round(props.usage.percent)}%</span>
      </div>

      <div class="context-popup-bar">
        <div
          class={`context-popup-bar-fill ${props.usage.percent >= 90 ? 'error' : props.usage.percent >= 75 ? 'warning' : ''}`}
          style={{ width: `${Math.min(props.usage.percent, 100)}%` }}
        />
      </div>

      <div class="context-popup-stat">
        <span>{formatNumber(props.usage.used)}</span>
        <span class="context-popup-sep">/</span>
        <span>{formatNumber(props.usage.limit)}</span>
        <span class="context-popup-unit">tokens</span>
      </div>

      <Show when={props.tokens.total > 0}>
        <div class="context-popup-section">Session Tokens</div>
        <div class="context-popup-rows">
          <For each={rows()}>
            {(row) => (
              <div class="context-popup-row">
                <span class="context-popup-row-label">{row.label}</span>
                <span class="context-popup-row-value">{formatNumber(row.value)}</span>
              </div>
            )}
          </For>
          <div class="context-popup-row context-popup-row-total">
            <span class="context-popup-row-label">Total</span>
            <span class="context-popup-row-value">{formatNumber(props.tokens.total)}</span>
          </div>
        </div>
      </Show>

      <Show when={props.model.modelName}>
        <div class="context-popup-model">
          {props.model.providerName} / {props.model.modelName}
        </div>
      </Show>
    </div>
  );
}

function AttachmentChip(props: {
  label: string;
  detail?: string | null;
  icon?: 'file' | 'folder' | 'image';
  onRemove?: () => void;
}) {
  return (
    <span class="chat-attachment-chip">
      <Show when={props.onRemove}>
        <button class="chip-remove" onClick={() => props.onRemove?.()}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 011.06 0L8 6.94l3.22-3.22a.75.75 0 111.06 1.06L9.06 8l3.22 3.22a.75.75 0 11-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 01-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 010-1.06z" />
          </svg>
        </button>
      </Show>
      <Show when={props.icon === 'image'}>
        <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M14.5 2h-13a.5.5 0 00-.5.5v11a.5.5 0 00.5.5h13a.5.5 0 00.5-.5v-11a.5.5 0 00-.5-.5zM2 3h12v7.3l-2.6-2.6a.5.5 0 00-.7 0L7.5 11 5.9 9.4a.5.5 0 00-.7 0L2 12.6V3zm3.5 4a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
        </svg>
      </Show>
      <Show when={props.icon === 'folder'}>
        <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M1.75 3A1.75 1.75 0 000 4.75v6.5C0 12.22.78 13 1.75 13h12.5c.97 0 1.75-.78 1.75-1.75V5.75C16 4.78 15.22 4 14.25 4H8.41L6.7 2.29A1 1 0 005.99 2H1.75z" />
        </svg>
      </Show>
      <Show when={props.icon !== 'image' && props.icon !== 'folder'}>
        <svg class="chip-icon" viewBox="0 0 16 16" fill="currentColor" width="12" height="12">
          <path d="M9.5 1.1l3.4 3.5.1.4v10c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2c0-.6.4-1 1-1h5.1l.4.1z" />
        </svg>
      </Show>
      <span class="chip-label">{props.label}</span>
      <Show when={props.detail}>
        <span class="chip-detail">{props.detail}</span>
      </Show>
    </span>
  );
}

function getDroppedFileLabel(file: { path: string; relativePath: string }) {
  if (!file.relativePath || file.relativePath === '.') {
    return getLeafPathName(file.path);
  }
  return getLeafPathName(file.relativePath);
}

async function collectDroppedPaths(dataTransfer: DataTransfer | null): Promise<string[]> {
  if (!dataTransfer) return [];

  const paths = new Set<string>();

  const knownTypes = [
    'CodeEditors',
    'CodeFiles',
    'text/uri-list',
    'ResourceURLs',
    'application/vnd.code.uri-list',
    'text/plain',
  ];
  const allTypes = Array.from(dataTransfer.types || []);
  for (const t of allTypes) {
    if (t.startsWith('application/vnd.code.') || !knownTypes.includes(t)) {
      knownTypes.push(t);
    }
  }

  for (const path of collectVSCodeDroppedPaths(dataTransfer)) {
    paths.add(path);
  }

  for (const type of knownTypes) {
    try {
      const data = dataTransfer.getData(type);
      for (const path of parseDroppedText(data)) {
        paths.add(path);
      }
    } catch {}
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
    // Fall back to async string reading from ALL DataTransferItems
    const stringItems = Array.from(dataTransfer.items).filter((item) => item.kind === 'string');

    const itemText = await Promise.all(stringItems.map(readDroppedItem));

    for (const value of itemText) {
      for (const path of parseDroppedText(value)) {
        paths.add(path);
      }
    }
  }

  return Array.from(paths);
}

function collectVSCodeDroppedPaths(dataTransfer: DataTransfer): string[] {
  const paths = new Set<string>();

  for (const path of parseCodeEditorsDrop(dataTransfer.getData('CodeEditors'))) {
    paths.add(path);
  }

  for (const path of parseCodeFilesDrop(dataTransfer.getData('CodeFiles'))) {
    paths.add(path);
  }

  for (const path of parseResourceListDrop(dataTransfer.getData('ResourceURLs'))) {
    paths.add(path);
  }

  for (const path of parseUriListDrop(dataTransfer.getData('application/vnd.code.uri-list'))) {
    paths.add(path);
  }

  return Array.from(paths);
}

function parseCodeEditorsDrop(value: string): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as unknown[];
    const paths = new Set<string>();
    for (const item of parsed) {
      if (!item) continue;
      if (typeof item === 'string') {
        const decoded = decodeDroppedCandidate(item);
        if (decoded) paths.add(decoded);
        continue;
      }
      if (typeof item !== 'object') continue;
      const resource = 'resource' in item ? (item.resource as string | undefined) : undefined;
      const uri = resource ? decodeDroppedCandidate(resource) : null;
      if (uri) paths.add(uri);
    }
    return Array.from(paths);
  } catch {
    return [];
  }
}

function parseCodeFilesDrop(value: string): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as unknown[];
    const paths = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const decoded = decodeDroppedCandidate(item);
      if (decoded) paths.add(decoded);
    }
    return Array.from(paths);
  } catch {
    return [];
  }
}

function parseResourceListDrop(value: string): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value) as unknown[];
    const paths = new Set<string>();
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const decoded = decodeDroppedCandidate(item);
      if (decoded) paths.add(decoded);
    }
    return Array.from(paths);
  } catch {
    return parseUriListDrop(value);
  }
}

function parseUriListDrop(value: string): string[] {
  if (!value) return [];
  const paths = new Set<string>();
  for (const entry of value.split(/\r?\n/)) {
    const decoded = decodeDroppedCandidate(entry.trim());
    if (decoded) paths.add(decoded);
  }
  return Array.from(paths);
}

function readItemByType(dataTransfer: DataTransfer, type: string): Promise<string> {
  return new Promise((resolve) => {
    const item = Array.from(dataTransfer.items).find((i) => i.type === type && i.kind === 'string');
    if (!item) {
      resolve(dataTransfer.getData(type) || '');
      return;
    }
    item.getAsString((value) => resolve(value || ''));
  });
}

function readDroppedItem(item: DataTransferItem): Promise<string> {
  return new Promise((resolve) => {
    item.getAsString((value) => resolve(value || ''));
  });
}

function parseDroppedText(value: string): string[] {
  if (!value) return [];
  const paths = new Set<string>();

  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const decoded = decodeDroppedCandidate(trimmed);
    if (decoded) paths.add(decoded);
  }

  for (const candidate of extractPathsFromStructuredDrop(value)) {
    paths.add(candidate);
  }

  return Array.from(paths);
}

function decodeDroppedCandidate(value: string): string | null {
  return decodeDroppedPath(value) || decodeWorkspaceRelativePath(value);
}

function decodeDroppedPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/')) return trimmed;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    let pathname = decodeURIComponent(url.pathname);

    if (url.protocol === 'vscode-file:') {
      pathname = pathname.replace(/^\/vscode-app(?=\/|$)/, '');
    }

    if (
      url.protocol === 'vscode-resource:' &&
      url.hostname === 'file' &&
      pathname.startsWith('///')
    ) {
      pathname = pathname.slice(2);
    }

    if (url.protocol === 'file:' && url.hostname && !/^\/[A-Za-z]:\//.test(pathname)) {
      pathname = `//${url.hostname}${pathname}`;
    }

    return normalizeDroppedPath(pathname);
  } catch {
    return null;
  }
}

function normalizeDroppedPath(pathname: string): string | null {
  if (!pathname) return null;
  if (/^\/[A-Za-z]:\//.test(pathname)) return pathname.slice(1);
  if (/^[A-Za-z]:[\\/]/.test(pathname)) return pathname;
  return pathname.startsWith('/') || pathname.startsWith('//') ? pathname : null;
}

function decodeWorkspaceRelativePath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  if (trimmed.startsWith('/') || trimmed.startsWith('//')) return null;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return null;
  if (/\s/.test(trimmed)) return null;

  const normalized = trimmed.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === '..') return null;

  const looksPathLike =
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.startsWith('.') ||
    /^[^/\\]+\.[^/\\]+$/.test(trimmed);

  return looksPathLike ? normalized : null;
}

function extractPathsFromStructuredDrop(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || !/^[[{"]/.test(trimmed)) return [];

  try {
    const parsed = JSON.parse(trimmed);
    const paths = new Set<string>();
    collectStructuredDropPaths(parsed, paths);
    return Array.from(paths);
  } catch {
    return [];
  }
}

function collectStructuredDropPaths(value: unknown, paths: Set<string>, keyHint = '') {
  if (typeof value === 'string') {
    const looksPathLike =
      !keyHint ||
      /(path|uri|url|resource)/i.test(keyHint) ||
      value.startsWith('/') ||
      value.startsWith('./') ||
      value.startsWith('../') ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      value.includes('/') ||
      value.includes('\\') ||
      /^[^/\\]+\.[^/\\]+$/.test(value) ||
      /^[a-z][a-z0-9+.-]*:/i.test(value);

    if (!looksPathLike) return;

    for (const candidate of value.split(/\r?\n/)) {
      const decoded = decodeDroppedCandidate(candidate);
      if (decoded) paths.add(decoded);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectStructuredDropPaths(item, paths, keyHint);
    }
    return;
  }

  if (!value || typeof value !== 'object') return;

  for (const [key, entry] of Object.entries(value)) {
    collectStructuredDropPaths(entry, paths, key);
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result || '')));
    reader.addEventListener('error', () =>
      reject(reader.error || new Error('Failed to read clipboard image'))
    );
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
