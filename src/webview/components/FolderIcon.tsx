export function FolderIcon(props: {
  class?: string;
  width?: number | string;
  height?: number | string;
}) {
  return <UiIcon source={folderIcon} {...props} aria-hidden="true" />;
}
import { folderIcon } from '../lib/ui-icons';
import { UiIcon } from './UiIcon';
