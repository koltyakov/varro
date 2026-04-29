import type { Memento } from 'vscode';
import type { Persistence } from '../shared/persistence';

export class HostPersistence implements Persistence {
  constructor(private readonly storage: Pick<Memento, 'get' | 'update'>) {}

  get<T>(key: string): T | undefined {
    return this.storage.get<T>(key);
  }

  set(key: string, value: unknown) {
    return this.storage.update(key, value);
  }

  remove(key: string) {
    return this.storage.update(key, undefined);
  }
}
