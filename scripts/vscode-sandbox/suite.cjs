/* oxlint-disable typescript/no-require-imports -- VS Code loads extension test suites as CommonJS. */
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vscode = require('vscode');

const EXPECTATIONS = {
  'clean-install-missing-cli': [
    '- CLI version: not found',
    '- Server status: error: OpenCode CLI not found.',
  ],
  'invalid-cli-path': [
    '- Resolved binary:',
    '- Server status: error: OpenCode CLI not found at the configured path:',
  ],
  'auto-start-disabled': [
    '- Auto updates: enabled',
    '- Server status: error: No server at http://127.0.0.1:',
  ],
  'version-command-failure': [
    '- CLI version: error:',
    '- Server status: running, event stream healthy',
    '- Server health: healthy',
  ],
  'startup-process-exit': [
    '- CLI version: 1.18.15',
    '- Server status: error: OpenCode server exited during startup (code 1)',
  ],
  'port-conflict-fallback': [
    '- CLI version: 1.18.15',
    '- Server status: running, event stream healthy',
    '- Server health: healthy',
  ],
  'required-update-disabled': [
    '- CLI version: 1.15.0',
    '- Server status: error: OpenCode update required.',
    'Automatic updates are disabled.',
  ],
  'required-update-failure': [
    '- CLI version: 1.15.0',
    '- Server status: error: OpenCode update required.',
    'The automatic update failed.',
  ],
  'healthy-first-run': [
    '- CLI version: 1.18.15',
    '- Server status: running, event stream healthy',
    '- Server health: healthy',
  ],
};

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readAboutDocument() {
  await vscode.commands.executeCommand('varro.about');
  const document = vscode.window.activeTextEditor?.document;
  if (!document || document.languageId !== 'markdown') return '';
  return document.getText();
}

async function waitForExpectedAboutText(expected, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let lastText = '';
  while (Date.now() < deadline) {
    lastText = await readAboutDocument();
    if (expected.every((text) => lastText.includes(text))) return lastText;
    await delay(250);
  }
  assert.fail(
    `Timed out waiting for About diagnostics:\n${expected.join('\n')}\n\nLast document:\n${lastText}`
  );
}

async function run() {
  const scenario = process.env.VARRO_SANDBOX_SCENARIO;
  assert.ok(scenario && Object.hasOwn(EXPECTATIONS, scenario), `Unknown sandbox scenario: ${scenario}`);
  const expected = [...EXPECTATIONS[scenario]];
  if (scenario === 'port-conflict-fallback') {
    const originalPort = Number(process.env.VARRO_SANDBOX_PORT);
    assert.ok(Number.isInteger(originalPort), 'Sandbox port was not provided');
    expected.push(`- Server port: ${String(originalPort + 1)}`);
  }

  const extension = vscode.extensions.getExtension('koltyakov.varro');
  assert.ok(extension, 'Varro extension was not loaded in the Extension Development Host');
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('varro.about'), 'Varro commands were not registered');

  // A fresh profile should reveal the view and start onboarding without a
  // command from the test. The About status therefore verifies first-run
  // activation as well as the host-side outcome for each scenario.
  const about = await waitForExpectedAboutText(expected);
  if (scenario === 'startup-process-exit') {
    const launches = readFileSync(process.env.VARRO_SANDBOX_LAUNCH_FILE, 'utf8')
      .trim()
      .split(/\r?\n/);
    assert.equal(launches.length, 4, 'Varro did not exhaust all three startup retries');
  }
  assert.match(about, /- VS Code: \d+\.\d+\.\d+/);
  assert.match(about, /- Platform: (darwin|linux|win32) /);
  process.stdout.write(`VS Code sandbox scenario passed: ${scenario}\n`);
}

module.exports = { run };
