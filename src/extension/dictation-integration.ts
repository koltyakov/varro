import * as vscode from 'vscode';
import type { DictationAction, DictationProvider, DictationStatus } from '../shared/protocol';
import { HandyIntegration } from './handy-integration';
import { HexIntegration } from './hex-integration';

export class DictationIntegration {
  private readonly handy = new HandyIntegration();
  private readonly hex = new HexIntegration();
  private pending: Promise<DictationStatus> | undefined;
  private pendingAction: DictationAction | undefined;
  private owner: DictationProvider | undefined;
  private selected: DictationProvider | undefined;
  private readonly observations = new Map<
    DictationProvider,
    { rawRevision: number; status: DictationStatus }
  >();
  private revision = 0;
  private generation = 0;
  private disposed = false;

  request(
    action: DictationAction,
    onState?: (status: DictationStatus) => void,
    provider?: DictationProvider
  ): Promise<DictationStatus> {
    if (this.disposed || vscode.env.remoteName) {
      return Promise.resolve({ available: false, running: false, state: 'idle' });
    }
    if (this.pending) {
      if (action !== 'status' && this.pendingAction === 'status') {
        return this.pending.then(() => this.request(action, onState, provider));
      }
      return this.pending.then((status) => {
        const result = { ...status };
        if (action !== 'status') result.error = 'Another dictation command is still pending.';
        return result;
      });
    }
    const operation = this.performRequest(action, onState, provider);
    this.pending = operation;
    this.pendingAction = action;
    void operation.then(() => {
      if (this.pending === operation) {
        this.pending = undefined;
        this.pendingAction = undefined;
      }
    });
    return operation;
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.handy.dispose();
    this.hex.dispose();
  }

  private async performRequest(
    action: DictationAction,
    onState?: (status: DictationStatus) => void,
    requestedProvider?: DictationProvider
  ): Promise<DictationStatus> {
    let provider = this.owner ?? (action === 'start' ? undefined : requestedProvider);
    let observed: DictationStatus | undefined;
    if (!provider) {
      const [handy, hex] = await Promise.all([
        this.handy.request('status'),
        this.hex.request('status'),
      ]);
      provider = hex.running ? 'hex' : handy.running ? 'handy' : hex.available ? 'hex' : 'handy';
      observed = provider === 'handy' ? handy : hex;
    }
    if (this.disposed) return { available: false, running: false, state: 'idle' };
    const generation =
      action === 'status' && this.selected === provider ? this.generation : ++this.generation;
    this.selected = provider;
    const publish = (status: DictationStatus): DictationStatus => {
      const previous = this.observations.get(provider);
      if (status.revision !== undefined && previous && status.revision < previous.rawRevision) {
        return previous.status;
      }
      // Keep finish/cancel routed to the app that accepted the start, even if
      // another app starts running meanwhile.
      if (status.state === 'recording' || status.state === 'processing') this.owner = provider;
      else if (!status.error && status.state === 'idle') this.owner = undefined;
      const result = { ...status, provider, revision: ++this.revision };
      this.observations.set(provider, { rawRevision: status.revision ?? -1, status: result });
      return result;
    };
    const integration = provider === 'handy' ? this.handy : this.hex;
    const status =
      action === 'status' && observed
        ? observed
        : await integration.request(action, (update) => {
            if (!this.disposed && generation === this.generation) onState?.(publish(update));
          });
    return publish(status);
  }
}
