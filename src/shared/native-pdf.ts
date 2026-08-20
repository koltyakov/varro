export const NATIVE_PDF_MIME = 'application/pdf';
export const MAX_NATIVE_PDF_TOTAL_BYTES = 20 * 1024 * 1024;
export const MAX_NATIVE_PDF_FILENAME_LENGTH = 512;
export const MAX_NATIVE_PDF_DATA_URL_LENGTH =
  'data:application/pdf;base64,'.length + Math.ceil(MAX_NATIVE_PDF_TOTAL_BYTES / 3) * 4;

export type NativePdfAttachment = {
  id: string;
  url: string;
  mime: typeof NATIVE_PDF_MIME;
  filename: string;
  size: number;
  attachmentSequence?: number;
  contextFile?: {
    path: string;
    relativePath: string;
    type: 'file';
  };
};

export function isPdfBytes(value: Uint8Array): boolean {
  return (
    value.length >= 5 &&
    value[0] === 0x25 &&
    value[1] === 0x50 &&
    value[2] === 0x44 &&
    value[3] === 0x46 &&
    value[4] === 0x2d
  );
}

export function getPdfDataUrlSize(url: string): number | null {
  const prefix = `data:${NATIVE_PDF_MIME};base64,`;
  if (!url.startsWith(prefix) || url.length > MAX_NATIVE_PDF_DATA_URL_LENGTH) return null;
  const encoded = url.slice(prefix.length);
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    return null;
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const size = (encoded.length / 4) * 3 - padding;
  if (size <= 0 || size > MAX_NATIVE_PDF_TOTAL_BYTES) return null;
  try {
    const header = atob(encoded.slice(0, 8));
    return header.startsWith('%PDF-') ? size : null;
  } catch {
    return null;
  }
}

export function isNativePdfAttachment<T>(value: T): value is T & NativePdfAttachment {
  const pdf = asRecord(value);
  if (!pdf) return false;
  if (
    !isString(pdf.id) ||
    pdf.id.length === 0 ||
    pdf.id.length > 512 ||
    pdf.mime !== NATIVE_PDF_MIME ||
    !isString(pdf.filename) ||
    pdf.filename.length === 0 ||
    pdf.filename.length > MAX_NATIVE_PDF_FILENAME_LENGTH ||
    !isString(pdf.url) ||
    !isNumber(pdf.size) ||
    !Number.isSafeInteger(pdf.size)
  ) {
    return false;
  }
  const dataUrlSize = getPdfDataUrlSize(pdf.url);
  if (dataUrlSize === null || dataUrlSize !== pdf.size) return false;
  if (pdf.contextFile !== undefined) {
    const contextFile = asRecord(pdf.contextFile);
    if (!contextFile) return false;
    if (
      !isString(contextFile.path) ||
      contextFile.path.length === 0 ||
      !isString(contextFile.relativePath) ||
      contextFile.relativePath.length === 0 ||
      contextFile.type !== 'file'
    ) {
      return false;
    }
  }
  return (
    pdf.attachmentSequence === undefined ||
    (isNumber(pdf.attachmentSequence) &&
      Number.isSafeInteger(pdf.attachmentSequence) &&
      pdf.attachmentSequence >= 0)
  );
}
import { asRecord, isNumber, isString } from './type-utils';
