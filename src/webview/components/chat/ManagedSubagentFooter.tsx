import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS } from '../../../shared/provider-limit-config';
import type { SelectedModel } from '../../lib/app-state-types';
import {
  formatModelName,
  formatProviderLimitTitle,
  formatVariantLabel,
  getProviderLimitCompactBadges,
  hasProviderLimitWindowWithinThreshold,
} from '../../lib/format';
import { getContextWindow } from '../../lib/message-metrics';
import { getPreferredVariant, getVariantsForModel } from '../../lib/model-variants';
import { getProviderIcon } from '../../lib/provider-icons';
import {
  getProviderLimit,
  getSelectedModelForSession,
  getSessionTreeIds,
  getStoredVariantForModel,
  providerLimitPollIntervalSeconds,
  providerLimitThresholdPercent,
  state,
} from '../../lib/state';
import {
  deriveSelectedModelFromMessages,
  deriveSelectedModelFromSession,
} from '../../hooks/routing-state';
import {
  ContextPopup,
  ContextUsageButton,
  formatContextUsageTitle,
} from '../chat-input/ContextPopup';
import { ProviderLimitPopup } from '../chat-input/ProviderLimitPopup';
import { ProviderLimitChip } from '../chat-input/ToolbarPickers';
import {
  getLatestAssistantMessageInfoWithTokens,
  getMessageEntriesForSession,
  getSessionTreeTokenBreakdown,
} from '../chat-input/message-usage';
import { filterCompactProviderLimitForModel } from '../chat-input/toolbar-compact';

type CurrentModelInfo = {
  providerID: string | null;
  modelID: string | null;
  variant: string | null;
  providerName: string;
  modelName: string;
  contextLimit: number | null;
};

export function ManagedSubagentFooter(props: {
  parentTitle: string | null;
  onReturnToParent: () => void;
}) {
  const [showContextPopup, setShowContextPopup] = createSignal(false);
  const [showProviderLimitPopup, setShowProviderLimitPopup] = createSignal(false);
  let footerRef: HTMLDivElement | undefined;
  let inputFrameRef: HTMLDivElement | undefined;

  const activeSession = createMemo(() =>
    state.sessions.find((session) => session.id === state.activeSessionId)
  );
  const activeMessages = createMemo(() =>
    state.messages.filter((entry) => entry.info.sessionID === state.activeSessionId)
  );
  const selectedModel = createMemo(
    () =>
      deriveSelectedModelFromMessages(activeMessages()) ||
      deriveSelectedModelFromSession(activeSession()) ||
      getSelectedModelForSession(state.activeSessionId) ||
      state.selectedModel
  );
  const currentModel = createMemo(() => resolveCurrentModel(selectedModel()));
  const availableVariants = createMemo(() => {
    const current = currentModel();
    return getVariantsForModel(current.providerID, current.modelID, state.providers);
  });
  const effectiveVariant = createMemo(() => {
    const current = currentModel();
    if (current.variant) return current.variant;
    const remembered = getStoredVariantForModel(current.providerID, current.modelID);
    if (remembered && availableVariants().includes(remembered)) return remembered;
    return (
      getPreferredVariant(current.providerID, current.modelID, state.providers) ||
      availableVariants()[0] ||
      null
    );
  });
  const currentSessionMessages = createMemo(() =>
    getMessageEntriesForSession(state.messages, state.activeSessionId)
  );
  const contextUsage = createMemo(() => {
    const latest = getLatestAssistantMessageInfoWithTokens(currentSessionMessages(), {
      includeSubagents: true,
    });
    if (latest) {
      const usage = getContextWindow(latest, state.providers);
      if (usage) return usage;
    }
    const limit = currentModel().contextLimit;
    return limit ? { used: 0, limit, percent: 0 } : null;
  });
  const tokenBreakdown = createMemo(() => {
    const sessionId = state.activeSessionId;
    if (!sessionId) return getSessionTreeTokenBreakdown([], [], [], '');
    return getSessionTreeTokenBreakdown(
      state.messages,
      state.sessions,
      getSessionTreeIds(sessionId),
      sessionId
    );
  });
  const currentProviderLimit = createMemo(() => {
    const current = currentModel();
    return getProviderLimit(current.providerID, current.modelID);
  });
  const compactProviderLimit = createMemo(() => {
    const current = currentModel();
    return filterCompactProviderLimitForModel(
      currentProviderLimit(),
      current.modelID,
      current.modelName
    );
  });
  const showProviderLimit = createMemo(
    () =>
      providerLimitPollIntervalSeconds() !== DISABLED_PROVIDER_LIMIT_POLL_INTERVAL_SECONDS &&
      hasProviderLimitWindowWithinThreshold(compactProviderLimit(), providerLimitThresholdPercent())
  );
  const providerLimitBadges = createMemo(() =>
    showProviderLimit() ? getProviderLimitCompactBadges(compactProviderLimit()) : []
  );
  const providerLimitTitle = createMemo(() =>
    showProviderLimit() ? formatProviderLimitTitle(compactProviderLimit()) : null
  );
  const parentLabel = () => (props.parentTitle ? `"${props.parentTitle}"` : 'its parent session');

  const closePopups = () => {
    setShowContextPopup(false);
    setShowProviderLimitPopup(false);
  };

  let popupSessionId = state.activeSessionId;
  createEffect(() => {
    const sessionId = state.activeSessionId;
    if (sessionId !== popupSessionId) closePopups();
    popupSessionId = sessionId;
    if (!showProviderLimit()) setShowProviderLimitPopup(false);
    if (!contextUsage()) setShowContextPopup(false);
  });

  onMount(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && footerRef?.contains(event.target)) return;
      closePopups();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (!showContextPopup() && !showProviderLimitPopup())) return;
      event.preventDefault();
      (event as KeyboardEvent & { varroHandled?: boolean }).varroHandled = true;
      closePopups();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    onCleanup(() => {
      document.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    });
  });

  return (
    <div
      ref={(element) => {
        footerRef = element;
      }}
      class="managed-subagent-footer"
      role="note"
    >
      <div
        class={`chat-input-shell${showContextPopup() || showProviderLimitPopup() ? ' showing-floating-popover' : ''}`}
      >
        <div
          ref={(element) => {
            inputFrameRef = element;
          }}
          class="chat-input-container managed-subagent-container"
        >
          <div class="managed-subagent-footer-copy">
            <span class="managed-subagent-footer-title">Managed subagent</span>
            <span class="managed-subagent-footer-description">
              This session receives instructions from {parentLabel()}.
            </span>
          </div>
          <div class="chat-input-toolbar-divider" />
          <div class="chat-input-toolbars toolbar-main managed-subagent-toolbar">
            <div class="toolbar-left">
              <Show when={currentModel().modelName}>
                <span
                  class="toolbar-picker model-picker-btn managed-subagent-info-chip"
                  title={`${currentModel().providerName} / ${formatModelName(currentModel().modelName)}`}
                >
                  <span class="toolbar-picker-label model-name">
                    <Show when={getProviderIcon(currentModel().providerID)}>
                      {(icon) => (
                        <span
                          class="provider-icon"
                          style={{ '--provider-icon-mask': `url("${icon()}")` }}
                          aria-hidden="true"
                        />
                      )}
                    </Show>
                    <span class="model-name-text">{formatModelName(currentModel().modelName)}</span>
                  </span>
                </span>
              </Show>
              <Show when={effectiveVariant()}>
                {(variant) => (
                  <span
                    class="toolbar-picker managed-subagent-info-chip managed-subagent-reasoning"
                    title="Thinking level"
                  >
                    <span class="toolbar-picker-label">{formatVariantLabel(variant())}</span>
                  </span>
                )}
              </Show>
            </div>
            <div class="toolbar-right">
              <button
                type="button"
                class="managed-subagent-footer-button"
                onClick={props.onReturnToParent}
              >
                Return to parent
              </button>
            </div>
          </div>
        </div>

        <Show when={providerLimitBadges().length > 0 || contextUsage()}>
          <div class="chat-input-toolbars toolbar-meta managed-subagent-meta">
            <div class="toolbar-meta-left" />
            <div class="toolbar-meta-right">
              <Show when={providerLimitBadges().length > 0}>
                <div class="provider-limit-anchor" style={{ position: 'relative' }}>
                  <ProviderLimitChip
                    badges={providerLimitBadges()}
                    title={showProviderLimitPopup() ? null : providerLimitTitle()}
                    ariaLabel={providerLimitTitle()}
                    onClick={() => {
                      setShowContextPopup(false);
                      setShowProviderLimitPopup((visible) => !visible);
                    }}
                  />
                  <Show when={showProviderLimitPopup()}>
                    <ProviderLimitPopup
                      boundaryRef={inputFrameRef}
                      alignTo="right"
                      limit={currentProviderLimit()}
                      providerName={currentModel().providerName}
                      onClose={() => setShowProviderLimitPopup(false)}
                    />
                  </Show>
                </div>
              </Show>
              <Show when={contextUsage()}>
                {(usage) => (
                  <div class="context-anchor" style={{ position: 'relative' }}>
                    <ContextUsageButton
                      percent={usage().percent}
                      available={usage().used > 0}
                      title={
                        showContextPopup()
                          ? undefined
                          : formatContextUsageTitle(usage().percent, usage().used > 0)
                      }
                      onClick={() => {
                        setShowProviderLimitPopup(false);
                        setShowContextPopup((visible) => !visible);
                      }}
                    />
                    <Show when={showContextPopup()}>
                      <ContextPopup
                        boundaryRef={inputFrameRef}
                        alignTo="right"
                        usage={usage()}
                        tokens={tokenBreakdown().session}
                        subagentTokens={tokenBreakdown().subagents}
                        subagentCount={tokenBreakdown().subagentCount}
                        model={currentModel()}
                        compactDisabled
                        showCompactAction={false}
                        onClose={() => setShowContextPopup(false)}
                        onCompact={closePopups}
                      />
                    </Show>
                  </div>
                )}
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}

function resolveCurrentModel(selected: SelectedModel | null): CurrentModelInfo {
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

  for (const provider of state.providers) {
    const defaultModelID = state.providerDefaults[provider.id];
    const model = defaultModelID ? provider.models[defaultModelID] : undefined;
    if (model) {
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

  const provider = state.providers[0];
  const model = provider ? Object.values(provider.models)[0] : undefined;
  return {
    providerID: provider?.id || null,
    modelID: model?.id || null,
    variant: null,
    providerName: provider?.name || '',
    modelName: model?.name || '',
    contextLimit: model?.limit?.context || null,
  };
}
