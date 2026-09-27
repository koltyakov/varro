import packageJson from '../../../package.json';
import {
  EXTENSION_ID_PATTERN,
  cloneExtensionContexts,
  isExtensionContext,
  isExtensionContexts,
} from '../../shared/extension-context';
import type { ExtensionContext } from '../../shared/extension-context';
import type { WebviewMessage } from '../../shared/protocol';
import { asRecord, isString } from '../../shared/type-utils';
import type { UnknownRecord } from '../../shared/type-utils';

export const HOST_API_VERSION = 1;
const FEATURES = new Set(['context-providers', 'menu-actions', 'project-storage', 'file-paths']);

export interface ContextProvider {
  id: string;
  version: number;
  validate(data: ExtensionContext['data']): boolean;
  capture(data: ExtensionContext['data']): NonNullable<ExtensionContext['captured']>;
  /** Read-only compatibility with previously emitted transcript formats. */
  readLegacyBlock?(
    lines: string[],
    index: number
  ): { context: ExtensionContext; end: number } | null;
}

export interface HostAction {
  id: string;
  slot: 'chat.new' | 'session.actions';
  label: string;
  run(context: { sessionId?: string; directory?: string }): void | Promise<void>;
}

export interface HostExtension {
  apiVersion: number;
  id: string;
  requires?: readonly string[];
  metadata?: { name: string; version: string; repository: string; ideName: string };
  capabilities?: { detachedEditors?: boolean };
  presentation?: { attachmentDetails?: 'inline' | 'tooltip' };
  services?: {
    send?(message: WebviewMessage): void;
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Transport input is parsed by the core message validator.
    subscribe?(receive: (message: unknown) => void): () => void;
    projectStorage?: Storage;
    viewState?: {
      getState(): UnknownRecord;
      setState(state: UnknownRecord): void;
    };
    filePath?(file: File): string | undefined;
    /** Return true when the host handled the preview for this drag. */
    setDragImage?(transfer: DataTransfer, element: Element, x: number, y: number): boolean;
  };
  contexts?: readonly ContextProvider[];
  actions?: readonly HostAction[];
  dispose?(): void;
}

let extension: HostExtension | undefined;
let started = false;

/** Register before importing the app. Registration is fixed for one mounted webview. */
export function registerHostExtension(value: HostExtension): () => void {
  if (started || extension)
    throw new Error('Register the host extension once, before loading Varro');
  if (value.apiVersion !== HOST_API_VERSION)
    throw new Error(`Unsupported Varro host API ${value.apiVersion}`);
  if (!EXTENSION_ID_PATTERN.test(value.id)) throw new Error(`Invalid extension ID: ${value.id}`);
  for (const feature of value.requires ?? []) {
    if (!FEATURES.has(feature)) throw new Error(`Unsupported Varro host feature: ${feature}`);
  }
  const ids = new Set<string>();
  for (const item of [...(value.contexts ?? []), ...(value.actions ?? [])]) {
    if (!EXTENSION_ID_PATTERN.test(item.id) || ids.has(item.id))
      throw new Error(`Invalid or duplicate contribution: ${item.id}`);
    ids.add(item.id);
  }
  for (const provider of value.contexts ?? []) {
    if (!Number.isSafeInteger(provider.version) || provider.version < 1)
      throw new Error(`Invalid context version: ${provider.id}`);
  }
  extension = Object.freeze({
    ...value,
    metadata: value.metadata ? Object.freeze({ ...value.metadata }) : undefined,
    capabilities: value.capabilities ? Object.freeze({ ...value.capabilities }) : undefined,
    presentation: value.presentation ? Object.freeze({ ...value.presentation }) : undefined,
    services: value.services ? Object.freeze({ ...value.services }) : undefined,
    contexts: Object.freeze(
      (value.contexts ?? []).map((provider) => Object.freeze({ ...provider }))
    ),
    actions: Object.freeze((value.actions ?? []).map((action) => Object.freeze({ ...action }))),
  });
  const registered = extension;
  return () => {
    if (extension !== registered) return;
    if (started) throw new Error('Unmount Varro before disposing its host extension');
    extension = undefined;
    registered.dispose?.();
  };
}

export function startHostExtension(): () => void {
  started = true;
  return () => {
    started = false;
  };
}

export function getHostExtension(): HostExtension | undefined {
  return extension;
}

export function hostMetadata() {
  const metadata: { version?: string; repository: string } = packageJson;
  return (
    extension?.metadata ?? {
      name: 'Varro',
      version: metadata.version ?? '0.0.0',
      repository: packageJson.repository,
      ideName: 'VS Code',
    }
  );
}

export function supportsDetachedEditors(): boolean {
  return extension?.capabilities?.detachedEditors ?? true;
}

export function showAttachmentDetails(): boolean {
  return extension?.presentation?.attachmentDetails !== 'tooltip';
}

export function captureExtensionContexts(
  contexts: ExtensionContext[] | undefined
): ExtensionContext[] | undefined {
  const snapshots = cloneExtensionContexts(contexts)?.map((context) => {
    if (context.captured) return context;
    const provider = extension?.contexts?.find(
      (item) => item.id === context.provider && item.version === context.version
    );
    if (!provider)
      throw new Error(`Context provider unavailable: ${context.provider} v${context.version}`);
    try {
      if (!provider.validate(context.data)) throw new Error('Invalid context data');
      const captured = { ...context, captured: provider.capture(context.data) };
      if (!isExtensionContext(captured)) throw new Error('Invalid captured context');
      return captured;
    } catch (cause) {
      throw new Error(`Could not capture ${context.label} (${context.provider})`, { cause });
    }
  });
  if (snapshots && !isExtensionContexts(snapshots))
    throw new Error('Captured extension context exceeds the total size limit');
  return snapshots;
}

export function readLegacyExtensionContext(lines: string[], index: number) {
  for (const provider of extension?.contexts ?? []) {
    try {
      const result = provider.readLegacyBlock?.(lines, index);
      if (
        result &&
        result.end > index &&
        result.end < lines.length &&
        result.context.provider === provider.id &&
        isExtensionContext(result.context) &&
        result.context.captured
      )
        return result;
    } catch {
      // A malformed legacy block remains visible as ordinary transcript text.
    }
  }
  return null;
}

export function getHostFilePath(file: File): string | undefined {
  const path = extension?.services?.filePath?.(file) ?? asRecord(file)?.path;
  return isString(path) ? path : undefined;
}

export function setHostDragImage(
  transfer: DataTransfer,
  element: Element,
  x: number,
  y: number
): void {
  if (!extension?.services?.setDragImage?.(transfer, element, x, y))
    transfer.setDragImage(element, x, y);
}
