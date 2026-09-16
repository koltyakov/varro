import { createSignal } from 'solid-js';
import type { ExtensionMessage, WebviewThemeKind } from '../../shared/protocol';
import { readInitialWebviewState } from './state-stored-values';
import { applyWebviewTheme, themeClassName } from './theme';
import { setTheme } from './state';
import { postMessage } from './bridge';

const initial = readInitialWebviewState();
const [windowChatTheme, setWindowChatTheme] = createSignal(initial?.windowChatTheme);
const [windowChatThemeReversed, setWindowChatThemeReversed] = createSignal(
  initial?.windowChatTheme?.reversed ?? false
);
export { windowChatTheme, windowChatThemeReversed };
let hostTheme: WebviewThemeKind = initial?.theme ?? 'dark';
let overrideStyle: HTMLStyleElement | undefined;
let themeObserver: MutationObserver | undefined;

// Theme files omit VS Code's registered defaults. Supply the colors used by the chat
// before layering the installed counterpart's explicit colors over them.
function defaultColors(kind: WebviewThemeKind) {
  const light = kind === 'light' || kind === 'high-contrast-light';
  const hc = kind === 'high-contrast' || kind === 'high-contrast-light';
  const bg = light ? '#ffffff' : hc ? '#000000' : '#1e1e1e';
  const fg = light ? '#333333' : hc ? '#ffffff' : '#cccccc';
  const surface = hc ? bg : light ? '#f3f3f3' : '#252526';
  const border = hc ? (light ? '#0f4a85' : '#6fc3df') : light ? '#d4d4d4' : '#474747';
  const muted = light ? '#616161' : '#a1a1a1';
  const link = light ? '#006ab1' : '#3794ff';
  const hover = light ? '#e8e8e8' : '#2a2d2e';
  return {
    'editor.background': bg,
    'editor.foreground': fg,
    'editor.selectionBackground': light ? '#add6ff' : '#264f78',
    foreground: fg,
    'sideBar.background': surface,
    'sideBar.foreground': fg,
    'interactive.session.foreground': fg,
    'interactive.result.editor.background.color': surface,
    'input.background': light || hc ? bg : '#3c3c3c',
    'input.foreground': fg,
    'input.border': border,
    'input.placeholderForeground': muted,
    'button.background': hc ? bg : light ? '#007acc' : '#0e639c',
    'button.foreground': hc ? fg : '#ffffff',
    'button.hoverBackground': hc ? hover : light ? '#0062a3' : '#1177bb',
    'button.separator': '#ffffff33',
    'button.border': hc ? border : 'transparent',
    'button.secondaryBackground': light ? '#e8e8e8' : '#3a3d41',
    'button.secondaryForeground': fg,
    'button.secondaryHoverBackground': hover,
    'panel.border': border,
    'widget.border': border,
    'editorWidget.background': surface,
    'widget.shadow': light ? '#00000029' : '#0000005c',
    contrastBorder: hc ? border : 'transparent',
    contrastActiveBorder: hc ? border : 'transparent',
    focusBorder: hc ? border : '#007fd4',
    descriptionForeground: muted,
    errorForeground: light ? '#a1260d' : '#f48771',
    'editorWarning.foreground': light ? '#bf8803' : '#cca700',
    'editorError.foreground': light ? '#e51400' : '#f14c4c',
    'problemsErrorIcon.foreground': light ? '#e51400' : '#f14c4c',
    'problemsWarningIcon.foreground': light ? '#bf8803' : '#cca700',
    'inputValidation.warningBackground': light ? '#f6f5d2' : '#352a05',
    'inputValidation.warningBorder': '#b89500',
    'list.hoverBackground': hover,
    'list.activeSelectionBackground': light ? '#0060c0' : '#04395e',
    'list.activeSelectionForeground': '#ffffff',
    'list.inactiveSelectionBackground': light ? '#e4e6f1' : '#37373d',
    'list.inactiveSelectionForeground': fg,
    'toolbar.hoverBackground': light ? '#b8b8b84f' : '#5a5d5e4f',
    'icon.foreground': fg,
    'textLink.foreground': link,
    'textLink.activeForeground': link,
    'textSeparator.foreground': light ? '#00000024' : '#ffffff2e',
    'textPreformat.foreground': light ? '#a31515' : '#d7ba7d',
    'textPreformat.background': light ? '#0000001a' : '#ffffff1a',
    'textPreformat.border': border,
    'textBlockQuote.background': '#7f7f7f1a',
    'textBlockQuote.border': '#007acc80',
    'chat.list.background': bg,
    'chat.requestBorder': border,
    'chat.requestBubbleBackground': hover,
    'chat.requestBubbleHoverBackground': surface,
    'chat.linesAddedForeground': light ? '#388a34' : '#73c991',
    'chat.linesRemovedForeground': light ? '#a1260d' : '#c74e39',
    'chat.thinkingShimmer': light ? '#00000099' : '#ffffff99',
    'chat.avatarBackground': surface,
    'chat.avatarForeground': fg,
    'diffEditor.insertedTextBackground': '#9ccc2c33',
    'diffEditor.removedTextBackground': '#ff000033',
    'diffEditor.insertedLineBackground': '#9ccc2c33',
    'diffEditor.removedLineBackground': '#ff000033',
    'charts.green': light ? '#388a34' : '#89d185',
    'charts.yellow': light ? '#b89500' : '#cca700',
    'charts.blue': link,
    'charts.orange': '#d18616',
    'charts.purple': light ? '#652d90' : '#b180d7',
    'gitDecoration.modifiedResourceForeground': light ? '#895503' : '#e2c08d',
    'testing.iconPassed': light ? '#388a34' : '#73c991',
    'testing.iconFailed': light ? '#a1260d' : '#f14c4c',
    'terminal.ansiGreen': light ? '#008000' : '#6a9955',
    'terminal.ansiMagenta': light ? '#af00db' : '#c586c0',
    'terminal.ansiRed': light ? '#a31515' : '#ce9178',
    'terminal.ansiYellow': light ? '#795e26' : '#dcdcaa',
    'terminal.ansiBlue': light ? '#0000ff' : '#569cd6',
    'terminal.ansiCyan': light ? '#267f99' : '#4ec9b0',
    'terminal.ansiBrightBlue': light ? '#001080' : '#9cdcfe',
    'scrollbarSlider.background': light ? '#64646466' : '#79797966',
    'scrollbarSlider.hoverBackground': '#646464b3',
  };
}

function applyLocalTheme(): WebviewThemeKind {
  themeObserver?.disconnect();
  themeObserver = undefined;
  overrideStyle?.remove();
  overrideStyle = undefined;
  const counterpart = windowChatThemeReversed() ? windowChatTheme()?.counterpart : null;
  if (!counterpart) return hostTheme;
  const colors = { ...defaultColors(counterpart.kind), ...counterpart.colors };
  const declarations = Object.entries(colors)
    .filter(([key, value]) => /^[\w.-]+$/.test(key) && /^(#[\da-f]{3,8}|transparent)$/i.test(value))
    .map(([key, value]) => `--vscode-${key.replaceAll('.', '-')}: ${value} !important;`);
  overrideStyle = document.createElement('style');
  overrideStyle.textContent = `:root, body { ${declarations.join('\n')} color-scheme: ${counterpart.kind === 'light' || counterpart.kind === 'high-contrast-light' ? 'light' : 'dark'}; }`;
  document.head.append(overrideStyle);
  themeObserver = new MutationObserver(() => {
    if (!document.body.classList.contains(themeClassName(counterpart.kind))) {
      applyWebviewTheme(counterpart.kind);
    }
  });
  themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return counterpart.kind;
}

export function syncWindowChatTheme(
  payload: Extract<ExtensionMessage, { type: 'theme/update' }>['payload']
): WebviewThemeKind {
  setWindowChatThemeReversed(
    payload.windowChatTheme
      ? (payload.windowChatTheme.reversed ?? windowChatThemeReversed())
      : false
  );
  hostTheme = payload.theme;
  setWindowChatTheme(payload.windowChatTheme);
  return applyLocalTheme();
}

export function toggleWindowChatTheme() {
  if (!windowChatTheme()?.counterpart) return;
  setWindowChatThemeReversed((value) => !value);
  postMessage({
    type: 'window-chat-theme/set-reversed',
    payload: { reversed: windowChatThemeReversed() },
  });
  const kind = applyLocalTheme();
  setTheme(kind);
  applyWebviewTheme(kind);
}
