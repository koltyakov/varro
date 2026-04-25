const GENERATED_NEW_SESSION_TITLE =
  /^New session\s+-\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function normalizeSessionTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  if (!trimmed) return '';
  if (GENERATED_NEW_SESSION_TITLE.test(trimmed)) return 'New session';
  return trimmed;
}
