export function WarningIcon(props: {
  class?: string;
  width?: number | string;
  height?: number | string;
}) {
  return <UiIcon source={warningTriangleSolidIcon} {...props} aria-hidden="true" />;
}
import { warningTriangleSolidIcon } from '../lib/ui-icons';
import { UiIcon } from './UiIcon';
