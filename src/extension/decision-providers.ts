import * as vscode from 'vscode';
import type { DecisionProviderRequest, DecisionProviderStatus } from '../shared/protocol';
import {
  directJevModelID,
  JEV_API_KEY_ENV,
  JEV_API_KEY_SECRET,
  JEV_DEFAULT_MODEL,
  JEV_DIRECT_ROUTE,
  JevClient,
  type JevSettings,
} from './jev-decisions';
import { readAutoApproveDecisionModel } from './extension-config';
import { logger } from './logger';
import type { NativeDecisions } from './native-decisions';

/**
 * Owns the TypeSafe credential and the one `varro.permissions.decisionModel` selection, which
 * holds either a direct TypeSafe Jev route or an OpenCode-hosted decision model.
 */
export class DecisionProviders {
  constructor(
    private readonly secrets: vscode.SecretStorage | undefined,
    private readonly createClient: (apiKey: string) => JevClient = (apiKey) =>
      new JevClient(async () => apiKey),
    private readonly native?: Pick<NativeDecisions, 'status'>
  ) {}

  readonly getApiKey = async (): Promise<string | undefined> => {
    const stored = (await this.secrets?.get(JEV_API_KEY_SECRET))?.trim();
    if (stored) return stored;
    return process.env[JEV_API_KEY_ENV]?.trim() || undefined;
  };

  readonly hasApiKey = async () => !!(await this.getApiKey());

  readonly readSettings = (): JevSettings => ({
    model: directJevModelID(readAutoApproveDecisionModel()),
  });

  async status(): Promise<DecisionProviderStatus> {
    const stored = (await this.secrets?.get(JEV_API_KEY_SECRET))?.trim();
    const credentialSource = stored
      ? 'secret'
      : process.env[JEV_API_KEY_ENV]?.trim()
        ? 'environment'
        : null;
    const settings = this.readSettings();
    const native = await this.native?.status();
    return {
      native: native
        ? {
            ...native,
            visible: vscode.workspace
              .getConfiguration('varro')
              .get<boolean>('debug.showDecisionModels', false),
          }
        : undefined,
      jev: {
        connected: credentialSource !== null,
        credentialSource,
        model: settings.model ?? JEV_DEFAULT_MODEL,
        autoApprove: settings.model !== null,
      },
    };
  }

  async handle(request: DecisionProviderRequest): Promise<DecisionProviderStatus> {
    if (request.action === 'native') {
      if (request.model) {
        const status = await this.native?.status();
        if (
          !status?.supported ||
          !status.models.some((model) => `${model.providerID}/${model.modelID}` === request.model)
        )
          throw new Error('Select an available OpenCode decision model');
        await this.writeDecisionModel(request.model);
      } else if (this.readSettings().model === null) {
        // Turning the native reviewer off must not turn off a selected Jev route.
        await this.writeDecisionModel(undefined);
      }
    } else if (request.action === 'connect') await this.connect();
    else if (request.action === 'disconnect') await this.disconnect();
    else if (request.autoApprove === true) {
      // Keep a direct TypeSafe model the user chose; otherwise replace any native selection.
      if (this.readSettings().model === null) {
        await this.writeDecisionModel(JEV_DIRECT_ROUTE);
      }
    } else if (request.autoApprove === false) await this.clearJevSelection();
    return this.status();
  }

  /** `varro.permissions.decisionModel` is a user setting; `undefined` removes the user value. */
  private async writeDecisionModel(value: string | undefined): Promise<void> {
    await vscode.workspace
      .getConfiguration('varro')
      .update('permissions.decisionModel', value, vscode.ConfigurationTarget.Global);
  }

  /** Clears a direct Jev selection, leaving an OpenCode decision model untouched. */
  private async clearJevSelection(): Promise<void> {
    if (this.readSettings().model !== null) {
      await this.writeDecisionModel(undefined);
    }
  }

  /** Prompts for a TypeSafe API key, verifies it with a minimal request, and stores it. */
  async connect(): Promise<boolean> {
    if (!this.secrets) throw new Error('Secret storage is unavailable');
    const apiKey = (
      await vscode.window.showInputBox({
        title: 'Connect TypeSafe Jev',
        prompt: 'Paste a TypeSafe API key. Varro stores it in VS Code secret storage.',
        password: true,
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? null : 'Enter an API key'),
      })
    )?.trim();
    if (!apiKey) return false;

    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Verifying TypeSafe API key' },
        () =>
          this.createClient(apiKey).evaluate(
            this.readSettings().model ?? JEV_DEFAULT_MODEL,
            'Connection check from Varro.',
            { ok: { type: 'noul', instructions: 'Is this a connection check?' } },
            10_000
          )
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`TypeSafe API key verification failed: ${message}`);
      void vscode.window.showErrorMessage(`Could not connect TypeSafe Jev: ${message}`);
      return false;
    }

    await this.secrets.store(JEV_API_KEY_SECRET, apiKey);
    if (this.readSettings().model === null) {
      void vscode.window.showInformationMessage(
        'TypeSafe Jev connected. Turn on Auto-approve decisions for it in the Varro Models view.'
      );
    }
    return true;
  }

  /** Removes the stored key and a direct Jev selection, so no dangling selection is left. */
  async disconnect(): Promise<void> {
    await this.secrets?.delete(JEV_API_KEY_SECRET);
    await this.clearJevSelection();
  }
}
