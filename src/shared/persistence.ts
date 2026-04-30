type PersistResult = void | PromiseLike<void>;

export interface Persistence {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): PersistResult;
  remove(key: string): PersistResult;
}
