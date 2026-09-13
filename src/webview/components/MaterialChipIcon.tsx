import skillIcon from 'material-icon-theme/icons/skill.svg';
import terminalIcon from 'material-icon-theme/icons/console.svg';
import sessionIcon from 'material-icon-theme/icons/changelog.svg';
import imageIcon from 'material-icon-theme/icons/image.svg';
import externalLinkIcon from 'material-icon-theme/icons/url.svg';
import gitIcon from 'material-icon-theme/icons/git.svg';
import tableIcon from 'iconoir/icons/table.svg';
import { Show } from 'solid-js';
import { UiIcon } from './UiIcon';
import agentIcon from '../assets/agent.svg';

export type MaterialChipIconKind =
  | 'agent'
  | 'table'
  | 'skill'
  | 'terminal'
  | 'image'
  | 'session'
  | 'external-link'
  | 'git';

type MaterialChipIconMap = Record<MaterialChipIconKind, string>;

const ICONS = {
  agent: agentIcon,
  table: tableIcon,
  skill: skillIcon,
  terminal: terminalIcon,
  image: imageIcon,
  session: sessionIcon,
  'external-link': externalLinkIcon,
  git: gitIcon,
} satisfies MaterialChipIconMap;

export function getMaterialChipIcon(kind: MaterialChipIconKind): string {
  return ICONS[kind];
}

export function createMaterialChipIconElement(
  kind: MaterialChipIconKind,
  className: string
): HTMLImageElement {
  const image = document.createElement('img');
  image.className = `material-chip-icon ${className}`;
  image.dataset.chipIcon = kind;
  image.src = getMaterialChipIcon(kind);
  image.alt = '';
  image.setAttribute('aria-hidden', 'true');
  image.draggable = false;
  return image;
}

export function MaterialChipIcon(props: { kind: MaterialChipIconKind; class?: string }) {
  return (
    <Show
      when={props.kind === 'table'}
      fallback={
        <img
          class={props.class ? `material-chip-icon ${props.class}` : 'material-chip-icon'}
          src={getMaterialChipIcon(props.kind)}
          data-chip-icon={props.kind}
          alt=""
          aria-hidden="true"
          draggable={false}
        />
      }
    >
      <UiIcon source={tableIcon} class={props.class} data-chip-icon="table" />
    </Show>
  );
}
