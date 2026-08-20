import agentIcon from 'material-icon-theme/icons/skill.svg';
import terminalIcon from 'material-icon-theme/icons/console.svg';
import sessionIcon from 'material-icon-theme/icons/changelog.svg';
import imageIcon from 'material-icon-theme/icons/image.svg';
import externalLinkIcon from 'material-icon-theme/icons/url.svg';
import gitIcon from 'material-icon-theme/icons/git.svg';

export type MaterialChipIconKind =
  | 'agent'
  | 'terminal'
  | 'image'
  | 'session'
  | 'external-link'
  | 'git';

const ICONS: Record<MaterialChipIconKind, string> = {
  agent: agentIcon,
  terminal: terminalIcon,
  image: imageIcon,
  session: sessionIcon,
  'external-link': externalLinkIcon,
  git: gitIcon,
};

export function getMaterialChipIcon(kind: MaterialChipIconKind): string {
  return ICONS[kind];
}

export function createMaterialChipIconElement(
  kind: MaterialChipIconKind,
  className: string
): HTMLImageElement {
  const image = document.createElement('img');
  image.className = `material-chip-icon ${className}`;
  image.src = getMaterialChipIcon(kind);
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  image.draggable = false;
  return image;
}

export function MaterialChipIcon(props: { kind: MaterialChipIconKind; class?: string }) {
  return (
    <img
      class={props.class ? `material-chip-icon ${props.class}` : 'material-chip-icon'}
      src={getMaterialChipIcon(props.kind)}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
