/* oxlint-disable typescript/no-require-imports -- VS Code loads extension test suites as CommonJS. */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vscode = require('vscode');

const DEFAULT_WAIT_TIMEOUT_MS = process.platform === 'win32' ? 60_000 : 25_000;

const EXPECTATIONS = {
  'clean-install-missing-cli': [
    '  - **Version:** `not found`',
    '  - **Status:** `error: OpenCode CLI not found.',
    '  - **Health:** unhealthy',
  ],
  'invalid-cli-path': [
    '  - **Binary:**',
    '  - **Status:** `error: OpenCode CLI not found at the configured path:',
    '  - **Health:** unhealthy',
  ],
  'auto-start-disabled': [
    '- **Auto updates:** enabled',
    '  - **Status:** `error: No server at http://127.0.0.1:',
    '  - **Health:** unhealthy',
  ],
  'version-command-failure': [
    '  - **Version:** `error:',
    '  - **Status:** `running, event stream healthy`',
    '  - **Health:** healthy',
  ],
  'malformed-cli-version': [
    '  - **Version:** `not found`',
    '  - **Status:** `running, event stream healthy`',
    '  - **Health:** healthy',
  ],
  'startup-process-exit': [
    '  - **Version:** `1.18.15`',
    '  - **Status:** `error: OpenCode server exited during startup (code 1)',
    '  - **Health:** unhealthy',
  ],
  'runtime-crash-recovery': [
    '  - **Version:** `1.18.15`',
    '  - **Status:** `running, event stream healthy`',
    '  - **Health:** healthy',
  ],
  'event-stream-failure': [
    '  - **Version:** `1.18.15`',
    '  - **Status:** `running, event stream degraded`',
    '  - **Health:** healthy',
  ],
  'port-conflict-fallback': [
    '  - **Version:** `1.18.15`',
    '  - **Status:** `running, event stream healthy`',
    '  - **Health:** healthy',
  ],
  'required-update-disabled': [
    '  - **Version:** `1.15.0`',
    '  - **Status:** `error: OpenCode update required.',
    '  - **Health:** unhealthy',
    'Automatic updates are disabled.',
  ],
  'required-update-failure': [
    '  - **Version:** `1.15.0`',
    '  - **Status:** `error: OpenCode update required.',
    '  - **Health:** unhealthy',
    'The automatic update failed.',
  ],
  'required-update-no-change': [
    '  - **Version:** `1.15.0`',
    '  - **Status:** `error: OpenCode update required.',
    '  - **Health:** unhealthy',
    'The automatic update did not install a compatible CLI (found 1.15.0)',
  ],
  'file-link-open': [
    '  - **Version:** `1.18.15`',
    '  - **Status:** `running, event stream healthy`',
    '  - **Health:** healthy',
  ],
  'healthy-first-run': [
    '- **Version:** `1.18.15`',
    '- **Install method:** a path configured in varro.server.command',
    '- **Ownership:** managed by Varro',
    '  - **Status:** `running, event stream healthy`',
    '  - **Health:** healthy',
  ],
};

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readAboutDocument() {
  const document = vscode.workspace.textDocuments
    .filter(
      (candidate) =>
        candidate.uri.scheme === 'varro-tool-output' &&
        candidate.uri.path.endsWith('/Varro About.md')
    )
    .at(-1);
  if (!document) return '';
  return document.getText();
}

async function waitForExpectedAboutText(expected, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  while (Date.now() < deadline) {
    await vscode.commands.executeCommand('varro.about');
    lastText = await readAboutDocument();
    if (expected.every((text) => lastText.includes(text))) return lastText;
    await delay(250);
  }
  assert.fail(
    `Timed out waiting for About diagnostics:\n${expected.join('\n')}\n\nLast document:\n${lastText}`
  );
}

async function waitForLaunchCount(expected, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let launches = [];
  while (Date.now() < deadline) {
    try {
      launches = readFileSync(process.env.VARRO_SANDBOX_LAUNCH_FILE, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
    } catch {}
    if (launches.length >= expected) return launches;
    await delay(250);
  }
  assert.fail(
    `Timed out waiting for ${String(expected)} OpenCode launches; saw ${String(launches.length)}`
  );
}

async function run() {
  const scenario = process.env.VARRO_SANDBOX_SCENARIO;
  assert.ok(
    scenario && Object.hasOwn(EXPECTATIONS, scenario),
    `Unknown sandbox scenario: ${scenario}`
  );
  const expected = [...EXPECTATIONS[scenario]];
  expected.push(
    '- **CLI:**',
    '  - **Version:**',
    '  - **Binary:**',
    '- **Server:**',
    '  - **URL:**',
    '  - **Status:**',
    '  - **Health:**',
    '- **Auto updates:**'
  );
  if (scenario === 'port-conflict-fallback') {
    const originalPort = Number(process.env.VARRO_SANDBOX_PORT);
    assert.ok(Number.isInteger(originalPort), 'Sandbox port was not provided');
    expected.push(`  - **URL:** [http://127.0.0.1:${String(originalPort + 1)}]`);
  }

  const extension = vscode.extensions.getExtension('koltyakov.varro');
  assert.ok(extension, 'Varro extension was not loaded in the Extension Development Host');
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('varro.about'), 'Varro commands were not registered');

  // A fresh profile should reveal the view and start onboarding without a
  // command from the test. The About status therefore verifies first-run
  // activation as well as the host-side outcome for each scenario.
  if (scenario === 'runtime-crash-recovery') await waitForLaunchCount(2);
  const about = await waitForExpectedAboutText(expected);
  if (scenario === 'startup-process-exit') {
    const launches = await waitForLaunchCount(4);
    assert.equal(launches.length, 4, 'Varro did not exhaust all three startup retries');
  }
  assert.match(about, /- \*\*VS Code:\*\* `\d+\.\d+\.\d+`/);
  assert.match(about, /- \*\*Platform:\*\* `(darwin|linux|win32) /);
  if (scenario === 'file-link-open') {
    const root = process.env.VARRO_SANDBOX_FILE_LINK_ROOT;
    const target = process.env.VARRO_SANDBOX_FILE_LINK_TARGET;
    assert.ok(root && target, 'File-link sandbox paths were not provided');
    await vscode.commands.executeCommand(
      'varro.test.openPath',
      `${root}/MarkdownRenderer.tsx`,
      1447
    );
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor?.document.uri.fsPath, target, 'The unique nested file was not opened');
    assert.equal(editor?.selection.active.line, 1446, 'The requested line was not selected');
    const missingResult = await vscode.commands.executeCommand(
      'varro.test.openPath',
      `${root}/DefinitelyMissing.ts`,
      12
    );
    assert.equal(missingResult, 'unavailable', 'A missing file did not report unavailable');
  }
  process.stdout.write(`VS Code sandbox scenario passed: ${scenario}\n`);
}

module.exports = { run };
