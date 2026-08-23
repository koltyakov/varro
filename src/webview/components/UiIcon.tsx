import { splitProps } from 'solid-js';
import type { JSX } from 'solid-js';

export type UiIconSize = number | string;

export interface UiIconProps extends Omit<
  JSX.HTMLAttributes<HTMLSpanElement>,
  'children' | 'class' | 'style'
> {
  source: string;
  class?: string;
  width?: UiIconSize;
  height?: UiIconSize;
  style?: JSX.CSSProperties;
}

export interface UiIconElementOptions {
  className?: string;
  width?: UiIconSize;
  height?: UiIconSize;
  ariaHidden?: boolean;
  label?: string;
}

function toCssLength(value: UiIconSize | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Number.isFinite(Number(value)) ? `${value}px` : String(value);
}

export function toCssUrl(source: string): string {
  return `url(${JSON.stringify(source)})`;
}

function applyIconStyles(
  style: CSSStyleDeclaration,
  source: string,
  width?: UiIconSize,
  height?: UiIconSize
): void {
  style.setProperty('--ui-icon-mask', toCssUrl(source));
  const cssWidth = toCssLength(width);
  const cssHeight = toCssLength(height);
  if (cssWidth) style.setProperty('--ui-icon-width', cssWidth);
  if (cssHeight) style.setProperty('--ui-icon-height', cssHeight);
}

export function createUiIconElement(
  source: string,
  options: UiIconElementOptions = {}
): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = options.className ? `ui-icon ${options.className}` : 'ui-icon';
  applyIconStyles(element.style, source, options.width, options.height);
  if (options.label) {
    element.setAttribute('role', 'img');
    element.setAttribute('aria-label', options.label);
  } else if (options.ariaHidden !== false) {
    element.setAttribute('aria-hidden', 'true');
  }
  return element;
}

export function UiIcon(props: UiIconProps) {
  const [local, rest] = splitProps(props, [
    'source',
    'class',
    'width',
    'height',
    'style',
    'aria-hidden',
    'aria-label',
  ]);
  const style = (): JSX.CSSProperties => {
    const result: JSX.CSSProperties & {
      '--ui-icon-mask': string;
      '--ui-icon-width'?: string;
      '--ui-icon-height'?: string;
    } = {
      ...local.style,
      '--ui-icon-mask': toCssUrl(local.source),
    };
    const width = toCssLength(local.width);
    const height = toCssLength(local.height);
    if (width) result['--ui-icon-width'] = width;
    if (height) result['--ui-icon-height'] = height;
    return result;
  };

  return (
    <span
      {...rest}
      class={local.class ? `ui-icon ${local.class}` : 'ui-icon'}
      style={style()}
      aria-label={local['aria-label']}
      aria-hidden={local['aria-hidden'] ?? (local['aria-label'] ? undefined : 'true')}
    />
  );
}
