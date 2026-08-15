import { MaterialChipIcon, createMaterialChipIconElement } from './MaterialChipIcon';

export function createExternalLinkIconElement(): HTMLImageElement {
  return createMaterialChipIconElement('external-link', 'external-link-icon');
}

export function ExternalLinkIcon() {
  return <MaterialChipIcon kind="external-link" class="external-link-icon" />;
}
