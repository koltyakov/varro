import { warningCircleIcon, warningTriangleIcon, xmarkCircleIcon } from '../lib/ui-icons';
import type { EditorDiagnostic } from '../../shared/protocol';
import { UiIcon } from './UiIcon';

export function ProblemsIcon(props: { severity?: EditorDiagnostic['severity'] } = {}) {
  return (
    <UiIcon
      source={getProblemsIconSource(props.severity)}
      class="chip-icon problems-icon"
      data-severity={props.severity ?? 'warning'}
      width={12}
      height={12}
      aria-hidden="true"
    />
  );
}

export function getProblemsIconSource(severity?: EditorDiagnostic['severity']): string {
  return severity === 'error'
    ? xmarkCircleIcon
    : severity === 'warning'
      ? warningTriangleIcon
      : warningCircleIcon;
}
