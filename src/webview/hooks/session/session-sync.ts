import type { SelectedModel, SessionSelectionOptions } from '../../lib/app-state-types';
import { routingStore } from '../../lib/stores/routing-store';
import type { MessageEntry, Session } from '../../types';
import {
  selectSessionWithDependencies,
  syncSessionMessagesWithDependencies,
  syncSessionWithDependencies,
} from './session-selection';

type SessionSyncDependencies = Parameters<typeof selectSessionWithDependencies>[0] &
  Parameters<typeof syncSessionMessagesWithDependencies>[0] & {
    loadSessionMetadata(sessionId: string): Promise<Session>;
  };

type SessionSyncGenerations = {
  nextSelection(): number;
  isCurrentSync(generation: number): boolean;
};

export class SessionSyncOperations {
  constructor(
    private readonly deps: SessionSyncDependencies,
    private readonly generations: SessionSyncGenerations
  ) {}

  readonly selectSession = async (id: string, options?: SessionSelectionOptions) => {
    await selectSessionWithDependencies(
      this.deps,
      { next: this.generations.nextSelection },
      id,
      options
    );
  };

  readonly syncSessionMessages = async (sessionId: string, generation: number) => {
    await syncSessionMessagesWithDependencies(
      this.deps,
      {
        next: () => generation,
        isCurrent: this.generations.isCurrentSync,
      },
      sessionId
    );
  };

  readonly syncSession = async (sessionId: string, options?: { shouldApply(): boolean }) => {
    await syncSessionWithDependencies(
      {
        loadSession: this.deps.loadSessionMetadata,
        upsertSession: this.deps.upsertSession,
      },
      sessionId,
      options
    );
  };
}

export function resolveMessagesSelectedModel(
  messages: MessageEntry[],
  providers: Array<unknown>,
  providerDefaults: Record<string, string>,
  deriveModelFromMessages: (messages: MessageEntry[]) => SelectedModel | null
) {
  return routingStore.resolveSelectedModel(
    deriveModelFromMessages(messages),
    // SAFETY: The surrounding shape or discriminator check establishes the Parameters<typeof routingStore.resolveSelectedModel> contract used below.
    providers as Parameters<typeof routingStore.resolveSelectedModel>[1],
    providerDefaults
  );
}
