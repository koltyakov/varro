import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import { Dynamic, Portal } from 'solid-js/web';
import { client } from '../../lib/client';
import { getStoredVariantForModel, isSessionAwaitingInput, state } from '../../lib/state';
import { deleteSession, selectSession } from '../../hooks/useOpenCode';
import { getSessionPermissionRulesForMode } from '../../hooks/permission-rules';
import type { RalphConfig, RalphSelectedModel } from '../../../shared/ralph';
import { ralphStore } from '../../lib/stores/ralph-store';
import { ralphRunner } from './ralph-runner';
import { buildAnchorMessage, getDefaultPromptTemplate } from './ralph-prompts';
import { ModelPicker, getVariantsForModel } from '../ModelPicker';
import { ModelPickerButton, VariantPicker } from '../chat-input/ToolbarPickers';
import { getPreferredVariant } from '../../lib/model-variants';
import { formatVariantLabel } from '../../lib/format';

const DEFAULT_ITERATIONS = 10;

function getInitialRalphModelSelection(): RalphSelectedModel | null {
  const selected = state.selectedModel;
  if (selected) {
    const provider = state.providers.find((item) => item.id === selected.providerID);
    const model = provider?.models[selected.modelID];
    if (provider && model) {
      if (selected.variant && !model.variants?.[selected.variant]) {
        return { providerID: selected.providerID, modelID: selected.modelID };
      }
      return selected;
    }
  }

  for (const provider of state.providers) {
    const defaultModelID = state.providerDefaults[provider.id];
    if (defaultModelID && provider.models[defaultModelID]) {
      return { providerID: provider.id, modelID: defaultModelID };
    }
  }

  const firstProvider = state.providers[0];
  if (!firstProvider) return null;

  const firstModel = Object.values(firstProvider.models)[0];
  if (!firstModel) return null;

  return { providerID: firstProvider.id, modelID: firstModel.id };
}

type PreviousSessionCleanupState = {
  messages: Array<unknown>;
  queuedMessages: Array<{ sessionId: string }>;
  sessionStatus: Record<string, { type?: string } | undefined>;
};

export function shouldDeletePreviousBlankSession(
  previousSessionId: string | null,
  sessionState: PreviousSessionCleanupState,
  awaitingInput: boolean
): boolean {
  return (
    !!previousSessionId &&
    sessionState.messages.length === 0 &&
    !sessionState.queuedMessages.some((item) => item.sessionId === previousSessionId) &&
    !awaitingInput &&
    sessionState.sessionStatus[previousSessionId]?.type !== 'busy' &&
    sessionState.sessionStatus[previousSessionId]?.type !== 'retry'
  );
}

function visibleProviders() {
  return state.providers;
}

function close() {
  ralphStore.setShowRalphForm(false);
}

export function RalphForm() {
  const [planPath, setPlanPath] = createSignal('');
  const [iterations, setIterations] = createSignal(DEFAULT_ITERATIONS);
  const [showAdvanced, setShowAdvanced] = createSignal(false);
  const [promptTemplate, setPromptTemplate] = createSignal(getDefaultPromptTemplate());
  const [model, setModel] = createSignal<RalphSelectedModel | null>(state.selectedModel);
  const [isSubmitting, setIsSubmitting] = createSignal(false);
  const [isPickingPlan, setIsPickingPlan] = createSignal(false);
  const [showModelPicker, setShowModelPicker] = createSignal(false);
  const [showVariantPicker, setShowVariantPicker] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null);
  const [modelPickerBoundaryRef, setModelPickerBoundaryRef] = createSignal<HTMLDivElement>();

  const currentModelInfo = createMemo(() => {
    const sel = model();
    if (!sel) {
      return { providerID: null as string | null, providerName: '', modelName: '' };
    }
    const provider = visibleProviders().find((p) => p.id === sel.providerID);
    const m = provider?.models[sel.modelID];
    return {
      providerID: sel.providerID,
      providerName: provider?.name || sel.providerID,
      modelName: m?.name || sel.modelID,
    };
  });

  const availableVariants = createMemo(() => {
    const sel = model();
    if (!sel) return [];
    return getVariantsForModel(sel.providerID, sel.modelID, visibleProviders());
  });

  const effectiveVariant = createMemo(() => {
    const sel = model();
    const variants = availableVariants();
    if (!sel || variants.length === 0) return null;
    if (sel.variant && variants.includes(sel.variant)) return sel.variant;
    const rememberedVariant = getStoredVariantForModel(sel.providerID, sel.modelID);
    if (rememberedVariant && variants.includes(rememberedVariant)) return rememberedVariant;
    return getPreferredVariant(sel.providerID, sel.modelID, visibleProviders()) || variants[0];
  });

  createEffect<boolean>((wasVisible = false) => {
    const visible = ralphStore.showRalphForm();
    if (visible && !wasVisible) {
      const activeFilePath = state.editorContext.activeFile?.relativePath;
      if (activeFilePath) setPlanPath(activeFilePath);
      setModel(getInitialRalphModelSelection());
      setErrorMessage(null);
    }
    return visible;
  });

  async function pickPlanPath() {
    if (isPickingPlan()) return;
    setErrorMessage(null);
    setIsPickingPlan(true);
    try {
      const pickedPath = await client.varro.pickWorkspaceFile();
      if (pickedPath) setPlanPath(pickedPath);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to pick plan document');
    } finally {
      setIsPickingPlan(false);
    }
  }

  async function submit() {
    if (isSubmitting()) return;
    const path = planPath().trim();
    if (!path) {
      setErrorMessage('Plan document path is required');
      return;
    }
    if (iterations() < 1) {
      setErrorMessage('Iterations must be at least 1');
      return;
    }
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const planLabel = path.split('/').pop() || path;
      const permissionMode: RalphConfig['permissionMode'] = 'full';
      const previousSessionId = state.activeSessionId;
      const shouldDeletePreviousSession = shouldDeletePreviousBlankSession(
        previousSessionId,
        state,
        previousSessionId ? isSessionAwaitingInput(previousSessionId) : false
      );
      const session = await client.session.create({
        title: `Ralph: ${planLabel}`,
        permission: getSessionPermissionRulesForMode(permissionMode, 'create'),
      });

      const selectedModel = model();
      const reasoningLevel = effectiveVariant();
      const configModel = selectedModel
        ? {
            providerID: selectedModel.providerID,
            modelID: selectedModel.modelID,
            ...(reasoningLevel ? { variant: reasoningLevel } : {}),
          }
        : null;

      const config: RalphConfig = {
        managerSessionId: session.id,
        planDocPath: path,
        iterations: iterations(),
        promptTemplate: promptTemplate(),
        permissionMode,
        model: configModel,
        agent: null,
        createdAt: Date.now(),
      };

      const anchorBody: Parameters<typeof client.session.sendAsync>[1] = {
        parts: [{ type: 'text', text: buildAnchorMessage(config) }],
        noReply: true,
      };
      if (config.model) {
        anchorBody.model = {
          providerID: config.model.providerID,
          modelID: config.model.modelID,
        };
        if (config.model.variant) {
          (anchorBody.model as { variant?: string }).variant = config.model.variant;
        }
      }
      await client.session.sendAsync(session.id, anchorBody).catch(() => {});

      await selectSession(session.id);
      if (previousSessionId && shouldDeletePreviousSession && previousSessionId !== session.id) {
        await deleteSession(previousSessionId).catch(() => {});
      }
      void ralphRunner.start(config).catch(() => {});

      close();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to start Ralph loop');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Show when={ralphStore.showRalphForm()}>
      <Portal>
        <div class="ralph-form-overlay">
          <div
            class="ralph-form-card"
            onClick={(e) => {
              e.stopPropagation();
              const target = e.target as HTMLElement | null;
              if (target && !target.closest('.ralph-form-model-picker')) {
                if (showModelPicker()) setShowModelPicker(false);
                if (showVariantPicker()) setShowVariantPicker(false);
              }
            }}
          >
            <div class="ralph-form-header">
              <span class="ralph-form-title">Start Ralph loop</span>
              <button type="button" class="ralph-form-close" onClick={close} aria-label="Close">
                ×
              </button>
            </div>

            <div
              class={`ralph-form-body${showModelPicker() || showVariantPicker() ? ' showing-model-picker' : ''}`}
            >
              <Field label="Plan / spec document">
                <div class="ralph-form-input-row">
                  <input
                    type="text"
                    class="ralph-form-input ralph-form-input-grow"
                    placeholder="No file selected"
                    value={planPath()}
                    readOnly
                    onClick={() => void pickPlanPath()}
                    title={planPath() || 'Click to pick a file from the workspace'}
                  />
                  <button
                    type="button"
                    class="ralph-form-button ralph-form-button-secondary ralph-form-inline-button"
                    onClick={() => void pickPlanPath()}
                    disabled={isPickingPlan() || isSubmitting()}
                  >
                    {isPickingPlan() ? 'Picking…' : planPath() ? 'Change…' : 'Pick file'}
                  </button>
                </div>
              </Field>

              <Field label="Iterations" as="div">
                <div class="ralph-form-stepper">
                  <button
                    type="button"
                    class="ralph-form-stepper-button"
                    aria-label="Decrease iterations"
                    onClick={() => setIterations(Math.max(1, iterations() - 1))}
                    disabled={iterations() <= 1}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min="1"
                    max="500"
                    class="ralph-form-input ralph-form-stepper-input"
                    value={iterations()}
                    onInput={(e) => setIterations(Math.max(1, Number(e.currentTarget.value) || 1))}
                  />
                  <button
                    type="button"
                    class="ralph-form-stepper-button"
                    aria-label="Increase iterations"
                    onClick={() => setIterations(Math.min(500, iterations() + 1))}
                    disabled={iterations() >= 500}
                  >
                    +
                  </button>
                </div>
              </Field>

              <Field label="Model" as="div">
                <div ref={setModelPickerBoundaryRef} class="ralph-form-model-picker">
                  <ModelPickerButton
                    providerID={currentModelInfo().providerID}
                    providerName={currentModelInfo().providerName}
                    modelName={currentModelInfo().modelName}
                    canEllipsize={true}
                    onToggle={() => {
                      setShowVariantPicker(false);
                      setShowModelPicker(!showModelPicker());
                    }}
                  />
                  <Show when={availableVariants().length > 0}>
                    <VariantPicker
                      boundaryRef={modelPickerBoundaryRef()}
                      alignTo="right"
                      popupGap={6}
                      variants={availableVariants()}
                      selectedVariant={effectiveVariant()}
                      selectedLabel={
                        effectiveVariant() ? formatVariantLabel(effectiveVariant()!) : ''
                      }
                      showPicker={showVariantPicker()}
                      getLabel={formatVariantLabel}
                      onToggle={() => {
                        setShowModelPicker(false);
                        setShowVariantPicker(!showVariantPicker());
                      }}
                      onSelect={(variant) => {
                        const sel = model();
                        if (sel) {
                          setModel({
                            providerID: sel.providerID,
                            modelID: sel.modelID,
                            variant,
                          });
                        }
                        setShowVariantPicker(false);
                      }}
                    />
                  </Show>
                  <Show when={showModelPicker()}>
                    <ModelPicker
                      currentSelection={model()}
                      showManageModels={false}
                      popupGap={6}
                      onSelect={(sel) => {
                        if (sel.providerID && sel.modelID) {
                          const variants = getVariantsForModel(
                            sel.providerID,
                            sel.modelID,
                            visibleProviders()
                          );
                          const prev = model();
                          const keepVariant =
                            prev?.variant && variants.includes(prev.variant)
                              ? prev.variant
                              : undefined;
                          setModel({
                            providerID: sel.providerID,
                            modelID: sel.modelID,
                            ...(keepVariant ? { variant: keepVariant } : {}),
                          });
                        }
                      }}
                      onClose={() => setShowModelPicker(false)}
                    />
                  </Show>
                </div>
              </Field>

              <button
                type="button"
                class="ralph-form-toggle"
                onClick={() => setShowAdvanced(!showAdvanced())}
              >
                {showAdvanced() ? '▾' : '▸'} Advanced - loop prompt template
              </button>
              <Show when={showAdvanced()}>
                <Field label="Prompt template">
                  <textarea
                    class="ralph-form-input ralph-form-textarea"
                    rows="10"
                    value={promptTemplate()}
                    onInput={(e) => setPromptTemplate(e.currentTarget.value)}
                  />
                  <span class="ralph-form-hint">
                    Variables: {'{{iteration}}'} {'{{totalIterations}}'} {'{{planPath}}'}{' '}
                    {'{{previousSummary}}'}
                  </span>
                </Field>
              </Show>

              <Show when={errorMessage()}>
                <div class="ralph-form-error">{errorMessage()}</div>
              </Show>
            </div>

            <div class="ralph-form-footer">
              <button type="button" class="ralph-form-button" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                class="ralph-form-button ralph-form-button-primary"
                onClick={() => void submit()}
                disabled={isSubmitting()}
              >
                {isSubmitting() ? 'Starting…' : 'Start loop'}
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}

function Field(props: { label: string; children: unknown; as?: 'label' | 'div' }) {
  return (
    <Dynamic component={props.as ?? 'label'} class="ralph-form-field">
      <span class="ralph-form-label">{props.label}</span>
      {props.children as never}
    </Dynamic>
  );
}
