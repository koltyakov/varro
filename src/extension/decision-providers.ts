import * as vscode from 'vscode';
import type { DecisionProviderRequest, DecisionProviderStatus } from '../shared/protocol';
import {
  JEV_API_KEY_ENV,
  JEV_API_KEY_SECRET,
  JEV_DEFAULT_MODEL,
  JevClient,
  type JevSettings,
} from './jev-decisions';
import { logger } from './logger';

const JEV_SETTINGS_SECTION = 'varro.decisions.jev';

/** Owns the TypeSafe credential and the opt-in settings for Jev decisions. */
export class DecisionProviders {
  constructor(
    private readonly secrets: vscode.SecretStorage | undefined,
    private readonly createClient: (apiKey: string) => JevClient = (apiKey) =>
      new JevClient(async () => apiKey)
  ) {}

  readonly getApiKey = async (): Promise<string | undefined> => {
    const stored = (await this.secrets?.get(JEV_API_KEY_SECRET))?.trim();
    if (stored) return stored;
    return process.env[JEV_API_KEY_ENV]?.trim() || undefined;
  };

  readonly hasApiKey = async () => !!(await this.getApiKey());

  readonly readSettings = (): JevSettings => {
    const config = vscode.workspace.getConfiguration(JEV_SETTINGS_SECTION);
    return {
      autoApprove: config.get<boolean>('autoApprove', false),
      model: JEV_DEFAULT_MODEL,
    };
  };

  async status(): Promise<DecisionProviderStatus> {
    const stored = (await this.secrets?.get(JEV_API_KEY_SECRET))?.trim();
    const credentialSource = stored
      ? 'secret'
      : process.env[JEV_API_KEY_ENV]?.trim()
        ? 'environment'
        : null;
    const settings = this.readSettings();
    return {
      jev: {
        connected: credentialSource !== null,
        credentialSource,
        model: settings.model,
        autoApprove: settings.autoApprove,
      },
    };
  }

  async handle(request: DecisionProviderRequest): Promise<DecisionProviderStatus> {
    if (request.action === 'connect') await this.connect();
    else if (request.action === 'disconnect') await this.disconnect();
    else {
      const config = vscode.workspace.getConfiguration(JEV_SETTINGS_SECTION);
      if (request.autoApprove !== undefined) {
        await config.update('autoApprove', request.autoApprove, vscode.ConfigurationTarget.Global);
      }
    }
    return this.status();
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
            this.readSettings().model,
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
    if (!this.readSettings().autoApprove) {
      void vscode.window.showInformationMessage(
        'TypeSafe Jev connected. Turn it on for auto-approve in the Varro Models view.'
      );
    }
    return true;
  }

  async disconnect(): Promise<void> {
    await this.secrets?.delete(JEV_API_KEY_SECRET);
  }
}
