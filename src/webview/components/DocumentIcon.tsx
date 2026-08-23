export function DocumentIcon(props: {
  class?: string;
  width?: number | string;
  height?: number | string;
}) {
  return <UiIcon source={pageIcon} {...props} aria-hidden="true" />;
}
import { pageIcon } from '../lib/ui-icons';
import { UiIcon } from './UiIcon';
