type PersistResult = void | PromiseLike<void>;

export interface Persistence {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): PersistResult;
  remove(key: string): PersistResult;
}
