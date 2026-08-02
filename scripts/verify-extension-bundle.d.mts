import type { Metafile } from 'esbuild';

export function verifyExtensionBundleMetafile(metafile: Metafile): void;
export function smokeLoadExtensionBundle(bundlePath: string): Promise<void>;
