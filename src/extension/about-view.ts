import { randomBytes } from 'node:crypto';

export type AboutViewData = {
  name: string;
  description: string;
  logoUri: string;
  varroVersion: string;
  cliVersion: string;
  installMethod: string;
  binary: string;
  serverVersion: string;
  serverUrl: string;
  ownership: string;
  serverStatus: string;
  healthy: boolean;
  activeAgents: string;
  autoUpdate: boolean;
  vscodeVersion: string;
  nodeVersion: string;
  platform: string;
  updateNotice?: string;
  diagnostics?: string;
  diagnosticsWithPaths?: string;
};

export function renderAboutHtml(data: AboutViewData, cspSource: string): string {
  const nonce = randomBytes(16).toString('base64');
  const statusLabel = data.healthy ? 'System ready' : 'Needs attention';
  const statusClass = data.healthy ? 'healthy' : 'unhealthy';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${escapeHtmlAttribute(cspSource)}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <title>About ${escapeHtml(data.name)}</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.5;
    }
    main { width: min(820px, 100%); margin: 0 auto; padding: 48px 44px 40px; }
    .hero { display: grid; grid-template-columns: 1fr auto; gap: 44px; align-items: center; padding-bottom: 34px; }
    h1 { max-width: 580px; margin: 0; font-size: clamp(32px, 5vw, 46px); font-weight: 650; line-height: 1.04; letter-spacing: -.025em; }
    .description { max-width: 570px; margin: 16px 0 0; color: var(--vscode-descriptionForeground); font-size: 15px; line-height: 1.6; }
    .brand-mark { display: flex; flex-direction: column; align-items: center; gap: 8px; min-width: 92px; }
    .brand-mark img { display: block; width: 82px; height: 82px; }
    .brand-mark span { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; }
    .status-bar {
      display: flex;
      gap: 24px;
      align-items: center;
      justify-content: space-between;
      padding: 18px 20px;
      border-top: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder));
      border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder));
      background: var(--vscode-editorWidget-background);
    }
    .status { display: flex; align-items: center; gap: 10px; font-weight: 700; }
    .status-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--vscode-testing-iconFailed); }
    .healthy .status-dot { background: var(--vscode-testing-iconPassed); }
    .status-detail { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 12px; text-align: right; }
    .notice { margin-top: 16px; padding: 14px 18px; border-left: 3px solid var(--vscode-notificationsWarningIcon-foreground); background: var(--vscode-textBlockQuote-background); }
    .notice strong { display: block; margin-bottom: 3px; }
    .notice span { color: var(--vscode-descriptionForeground); }
    .cards { display: grid; gap: 12px; margin: 12px 0; }
    .card { min-width: 0; padding: 22px 24px; border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder)); background: var(--vscode-sideBar-background); }
    .card-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
    .card h2 { margin: 0; font-size: 15px; font-weight: 650; }
    .card-version { color: var(--vscode-textLink-foreground); font-size: 13px; font-weight: 500; }
    dl { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 10px 18px; margin: 0; }
    dt { color: var(--vscode-descriptionForeground); }
    dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
    code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .runtime { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder)); }
    .runtime-item { padding: 17px 20px; }
    .runtime-item + .runtime-item { border-left: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder)); }
    .runtime-label { display: block; margin-bottom: 3px; color: var(--vscode-descriptionForeground); font-size: 12px; }
    footer { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; margin-top: 32px; }
    .links { display: flex; flex-wrap: wrap; gap: 7px; }
    a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .links a {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      min-height: 30px;
      padding: 5px 10px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder));
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      font-size: 12px;
      font-weight: 500;
    }
    .links svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.7; }
    .links a:hover {
      border-color: var(--vscode-focusBorder);
      color: var(--vscode-textLink-activeForeground);
      background: var(--vscode-list-hoverBackground);
      text-decoration: none;
    }
    .links a:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      padding: 4px 0;
      border: 0;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    button svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.5; }
    button:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    @media (max-width: 660px) {
      main { padding: 32px 20px; }
      .hero { grid-template-columns: 1fr; gap: 28px; }
      .brand-mark { align-items: flex-start; }
      .brand-mark img { width: 70px; height: 70px; }
      .runtime { grid-template-columns: 1fr; }
      .runtime-item + .runtime-item { border-left: 0; border-top: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder)); }
      .status-bar { align-items: flex-start; flex-direction: column; gap: 8px; }
      .status-detail { text-align: left; }
    }
  </style>
</head>
<body>
  <main>
    <header class="hero">
      <div>
        <h1>${escapeHtml(data.name)}</h1>
        <p class="description">${escapeHtml(data.description)}</p>
      </div>
      <div class="brand-mark">
        <img src="${escapeHtmlAttribute(data.logoUri)}" alt="Varro" />
        <span>v${escapeHtml(data.varroVersion)}</span>
      </div>
    </header>

    <section class="status-bar ${statusClass}" aria-label="Server status">
      <div class="status"><span class="status-dot"></span>${statusLabel}</div>
      <div class="status-detail">${escapeHtml(data.serverStatus)}</div>
    </section>
    ${data.updateNotice ? `<section class="notice"><strong>OpenCode update available</strong><span>${escapeHtml(data.updateNotice)}</span></section>` : ''}

    <div class="cards">
      <section class="card">
        <div class="card-heading"><h2>OpenCode CLI</h2><span class="card-version">${escapeHtml(data.cliVersion)}</span></div>
        <dl>
          <dt>Installed via</dt><dd>${escapeHtml(data.installMethod)}</dd>
          <dt>Binary</dt><dd><code>${escapeHtml(data.binary)}</code></dd>
          <dt>Auto updates</dt><dd>${data.autoUpdate ? 'Enabled' : 'Disabled'}</dd>
        </dl>
      </section>
      <section class="card">
        <div class="card-heading"><h2>OpenCode server</h2><span class="card-version">${escapeHtml(data.serverVersion)}</span></div>
        <dl>
          <dt>Endpoint</dt><dd><code>${escapeHtml(data.serverUrl)}</code></dd>
          <dt>Ownership</dt><dd>${escapeHtml(data.ownership)}</dd>
          <dt>Active agents</dt><dd>${escapeHtml(data.activeAgents)}</dd>
        </dl>
      </section>
    </div>

    <section class="runtime" aria-label="Runtime">
      <div class="runtime-item"><span class="runtime-label">VS Code</span><code>${escapeHtml(data.vscodeVersion)}</code></div>
      <div class="runtime-item"><span class="runtime-label">Node</span><code>${escapeHtml(data.nodeVersion)}</code></div>
      <div class="runtime-item"><span class="runtime-label">Platform</span><code>${escapeHtml(data.platform)}</code></div>
    </section>

    <details class="card" style="margin-top: 16px">
      <summary>Preview diagnostics</summary>
      <p>Recent lifecycle events are included. Credentials and URL query values are removed.</p>
      <label><input id="include-paths" type="checkbox"> Include local paths</label>
      <pre id="diagnostics-preview" style="white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto">${escapeHtml(data.diagnostics ?? '')}</pre>
      <template id="diagnostics-redacted">${escapeHtml(data.diagnostics ?? '')}</template>
      <template id="diagnostics-with-paths">${escapeHtml(data.diagnosticsWithPaths ?? '')}</template>
      <button id="save-diagnostics" type="button">Save diagnostics</button>
      <span id="diagnostics-result" role="status" aria-live="polite"></span>
    </details>
    <footer>
      <nav class="links" aria-label="Varro links">
        <a href="https://github.com/koltyakov/varro"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 13.5c-3 .9-3-1.5-4-2m8 4v-2.3c0-.7-.2-1.2-.5-1.5 1.8-.2 3.7-.9 3.7-4A3.1 3.1 0 0 0 12.4 5c.1-.5.1-1.3-.3-2.1 0 0-.7-.2-2.4.9a8.2 8.2 0 0 0-4.4 0c-1.7-1.1-2.4-.9-2.4-.9C2.5 3.7 2.5 4.5 2.6 5a3.1 3.1 0 0 0-.8 2.2c0 3.1 1.9 3.8 3.7 4-.3.3-.5.7-.5 1.4v2.9" /></svg>GitHub</a>
        <a href="https://marketplace.visualstudio.com/items?itemName=koltyakov.varro"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5.5h10l-.7 8H3.7l-.7-8Z" /><path d="M6 6V4a2 2 0 0 1 4 0v2" /></svg>Marketplace</a>
        <a href="https://open-vsx.org/extension/koltyakov/varro"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m8 1.8 5.3 3.1v6.2L8 14.2l-5.3-3.1V4.9L8 1.8Z" /><path d="m2.7 4.9 5.3 3 5.3-3M8 7.9v6.3" /></svg>Open VSX</a>
      </nav>
      <button id="copy-diagnostics" type="button"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1" /><path d="M3 11H2.5A1.5 1.5 0 0 1 1 9.5v-7A1.5 1.5 0 0 1 2.5 1h7A1.5 1.5 0 0 1 11 2.5V3" /></svg><span>Copy diagnostics</span></button>
    </footer>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const copyButton = document.getElementById('copy-diagnostics');
    const includePaths = document.getElementById('include-paths');
    includePaths.addEventListener('change', () => {
      const source = document.getElementById(includePaths.checked ? 'diagnostics-with-paths' : 'diagnostics-redacted');
      document.getElementById('diagnostics-preview').textContent = source.content.textContent;
      document.getElementById('diagnostics-result').textContent = '';
    });
    copyButton.addEventListener('click', () => {
      vscode.postMessage({ action: 'copyDiagnostics', includePaths: includePaths.checked });
    });
    document.getElementById('save-diagnostics').addEventListener('click', () => {
      vscode.postMessage({ action: 'saveDiagnostics', includePaths: includePaths.checked });
    });
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'diagnostics-result' && typeof event.data.text === 'string') {
        document.getElementById('diagnostics-result').textContent = event.data.text;
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll('`', '&#96;');
}
