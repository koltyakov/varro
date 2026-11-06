import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { build } from 'esbuild';
import { AiOpenCodeClient } from './ai-opencode-client.mjs';
import { requireIsolatedTestServer } from './ai-test-isolation.mjs';
import { CdpController } from './ai-fuzzy-live.mjs';
import { cleanupOwnedHost } from './ai-streaming.mjs';
import { reloadVscodeWindow } from './vscode-launch-process.mjs';

const binary = process.env.VARRO_OPENCODE_TEST_BINARY;
function pdfTransportHash(value) {
  return createHash('sha256').update(value).digest('hex');
}
test(
  'AI controller lifecycle against an isolated released backend',
  { skip: !binary, timeout: 90000 },
  async (t) => {
    const parent = path.resolve('artifacts/ai-test-data');
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(path.join(parent, 'ai-client-'));
    for (const name of [
      'home',
      'data/opencode',
      'config/opencode',
      'state',
      'cache',
      'workspace',
    ]) {
      await mkdir(path.join(root, name), { recursive: true });
    }
    const workspace = path.join(root, 'workspace');
    execFileSync('git', ['init', '--quiet'], { cwd: workspace });
    const version = execFileSync(binary, ['--version'], { encoding: 'utf8' })
      .trim()
      .replace(/^opencode v/, '');
    const major = Number(version.split('.')[0]);
    const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
    const password = randomUUID();
    process.env.OPENCODE_SERVER_PASSWORD = password;
    t.after(() => {
      if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
      else process.env.OPENCODE_SERVER_PASSWORD = previousPassword;
    });
    let generationCount = 0;
    const pdfRequests = [];
    const model = http.createServer(async (request, response) => {
      const body = JSON.parse(Buffer.concat(await Array.fromAsync(request)).toString());
      generationCount += 1;
      if (body.model?.startsWith('fixture-pdf')) pdfRequests.push(body);
      if (body.model === 'fixture-pdf-error') {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            error: { message: 'Fixture provider rejected PDF', type: 'invalid_request_error' },
          })
        );
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const content of ['AI-CONTROLLER ', 'VERIFIED']) {
        response.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`
        );
      }
      response.end(
        `data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`
      );
    });
    await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      model.closeAllConnections();
      await new Promise((resolve) => model.close(resolve));
    });
    const baseURL = `http://127.0.0.1:${model.address().port}/v1`;
    const config =
      major === 2
        ? {
            providers: {
              fixture: {
                package: '@opencode/ai/providers/openai-compatible',
                settings: { baseURL, apiKey: 'fixture-only' },
                models: {
                  fixture: { name: 'Fixture', limit: { context: 32000, output: 1000 } },
                  ...Object.fromEntries(
                    ['fixture-pdf', 'fixture-pdf-error'].map((id) => [
                      id,
                      {
                        name: id,
                        capabilities: {
                          input: ['text', 'image', 'pdf'],
                          output: ['text'],
                          tools: false,
                        },
                        limit: { context: 32000, output: 1000 },
                      },
                    ])
                  ),
                },
              },
            },
          }
        : {
            provider: {
              fixture: {
                npm: '@ai-sdk/openai-compatible',
                options: { baseURL, apiKey: 'fixture-only' },
                models: { fixture: { name: 'Fixture', limit: { context: 32000, output: 1000 } } },
              },
            },
          };
    await writeFile(path.join(root, 'config/opencode/opencode.json'), JSON.stringify(config));
    const child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        HOME: path.join(root, 'home'),
        XDG_DATA_HOME: path.join(root, 'data'),
        XDG_CONFIG_HOME: path.join(root, 'config'),
        XDG_STATE_HOME: path.join(root, 'state'),
        XDG_CACHE_HOME: path.join(root, 'cache'),
        OPENCODE_DB: path.join(root, 'data/opencode/opencode.db'),
        OPENCODE_TEST_HOME: path.join(root, 'home'),
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        OPENCODE_SERVER_PASSWORD: password,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    let logs = '';
    const collect = (chunk) => {
      logs += chunk.toString().replaceAll(password, '[redacted]');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    t.after(async () => {
      child.kill('SIGTERM');
      await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      await writeFile(path.join(root, 'server.log'), logs);
    });
    let url;
    const deadline = Date.now() + 20000;
    while (!(url = logs.match(/server listening on (http:\/\/\S+)/)?.[1])) {
      if (Date.now() >= deadline || child.exitCode !== null)
        throw new Error(`Server failed to start: ${logs}`);
      await delay(100);
    }
    const isolation = await requireIsolatedTestServer(
      url,
      workspace,
      parent,
      path.join(root, 'data/opencode')
    );
    assert.equal(isolation.backend.apiVersion, major);
    assert.equal(isolation.backend.version, version);
    assert.equal(isolation.serverPid, child.pid);
    const client = new AiOpenCodeClient(url, workspace);
    const title = `VFZ ai-client-${path.basename(root)}`;
    const sessions = [];
    try {
      const session = await client.request('POST', '/session', { title });
      sessions.push(session.id);
      assert.equal(session.directory, workspace);
      await client.request('POST', `/session/${session.id}/prompt_async`, {
        parts: [{ type: 'text', text: 'Reply with the fixture response. Do not use tools.' }],
        model: { providerID: 'fixture', modelID: 'fixture' },
      });
      let messages = [];
      const turnDeadline = Date.now() + 30000;
      while (Date.now() < turnDeadline) {
        messages = await client.request('GET', `/session/${session.id}/message?limit=1000`);
        if (
          messages.some(
            (message) => message.info.role === 'assistant' && message.info.time?.completed
          )
        )
          break;
        await delay(100);
      }
      assert.ok(
        messages.some((message) =>
          message.parts.some((part) => part.text?.includes('AI-CONTROLLER VERIFIED'))
        ),
        JSON.stringify(messages)
      );
      assert.ok(generationCount > 0);
      if (major === 2) {
        const { outputFiles } = await build({
          entryPoints: ['src/shared/native-pdf.test-support.ts'],
          bundle: true,
          platform: 'node',
          format: 'esm',
          write: false,
        });
        const { nativePdfFixture } = await import(
          `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
        );
        const evidence = {
          date: new Date().toISOString(),
          server: version,
          client: JSON.parse(await readFile('node_modules/@opencode/client/package.json', 'utf8'))
            .version,
          provider: '@opencode/ai/providers/openai-compatible',
          model: 'fixture-pdf',
          isolation,
          cases: [],
        };
        for (const kind of ['text', 'image']) {
          await t.test(`PDF ${kind} bytes reach the local fixture provider`, async () => {
            const pdf = nativePdfFixture(kind);
            const next = await client.request('POST', '/session', {
              title: `${title} PDF ${kind}`,
            });
            sessions.push(next.id);
            const previous = pdfRequests.length;
            await client.request('POST', `/session/${next.id}/prompt`, {
              model: { providerID: 'fixture', modelID: 'fixture-pdf' },
              parts: [
                { type: 'text', text: 'Inspect the attachment without using tools.' },
                { type: 'file', mime: pdf.mime, filename: pdf.filename, url: pdf.url },
              ],
            });
            assert.equal(pdfRequests.length, previous + 1);
            const media = pdfRequests
              .at(-1)
              .messages.flatMap((message) =>
                Array.isArray(message.content) ? message.content : []
              )
              .filter((part) => part.type === 'file');
            assert.equal(media.length, 1);
            assert.equal(media[0].file.filename, pdf.filename);
            assert.equal(
              pdfTransportHash(media[0].file.file_data),
              pdfTransportHash(pdf.url),
              'Provider must receive the original PDF bytes'
            );
            const restored = await new AiOpenCodeClient(url, workspace).request(
              'GET',
              `/session/${next.id}/message?limit=100`
            );
            const file = restored
              .flatMap((message) => message.parts)
              .find((part) => part.type === 'file');
            assert.equal(file.mime, pdf.mime);
            assert.equal(file.filename, pdf.filename);
            assert.equal(pdfTransportHash(file.url), pdfTransportHash(pdf.url));
            evidence.cases.push({
              kind,
              status: 'PASS',
              representation: 'file.file_data data URL',
              size: pdf.size,
              sha256: createHash('sha256')
                .update(Buffer.from(pdf.url.split(',')[1], 'base64'))
                .digest('hex'),
              modelReceipt: 'Not tested: fixture HTTP receiver only',
            });
          });
        }
        await t.test(
          'pending PDF reload retains identity and bytes without generation',
          async () => {
            const pdf = nativePdfFixture();
            const next = await client.request('POST', '/session', { title: `${title} PDF inbox` });
            sessions.push(next.id);
            const previous = pdfRequests.length;
            await client.request('POST', `/session/${next.id}/prompt_async`, {
              model: { providerID: 'fixture', modelID: 'fixture-pdf' },
              noReply: true,
              delivery: 'queue',
              parts: [{ type: 'file', mime: pdf.mime, filename: pdf.filename, url: pdf.url }],
            });
            const reopened = new AiOpenCodeClient(url, workspace);
            const history = await reopened.request('GET', `/session/${next.id}/message?limit=100`);
            const pending = history.find((message) => message.info.pendingDelivery === 'queue');
            assert.ok(pending);
            const file = pending.parts.find((part) => part.type === 'file');
            assert.equal(file.filename, pdf.filename);
            assert.equal(pdfTransportHash(file.url), pdfTransportHash(pdf.url));
            assert.equal(pdfRequests.length, previous);
            const again = await reopened.request('GET', `/session/${next.id}/message?limit=100`);
            assert.equal(
              pdfTransportHash(JSON.stringify(again)),
              pdfTransportHash(JSON.stringify(history))
            );
            evidence.cases.push({ kind: 'pending reload', status: 'PASS', generationCount: 0 });
          }
        );
        await t.test('unsupported PDF input fails before admission', async () => {
          const pdf = nativePdfFixture();
          const next = await client.request('POST', '/session', {
            title: `${title} PDF unsupported`,
          });
          sessions.push(next.id);
          const previous = generationCount;
          await assert.rejects(
            client.request('POST', `/session/${next.id}/prompt_async`, {
              model: { providerID: 'fixture', modelID: 'fixture' },
              parts: [{ type: 'file', mime: pdf.mime, filename: pdf.filename, url: pdf.url }],
            }),
            /does not support PDF input/
          );
          assert.deepEqual(
            await client.request('GET', `/session/${next.id}/message?limit=100`),
            []
          );
          assert.equal(generationCount, previous);
          evidence.cases.push({ kind: 'unsupported', status: 'PASS', admission: false });
        });
        await t.test('provider rejection retains history and never resends the PDF', async () => {
          const pdf = nativePdfFixture();
          const next = await client.request('POST', '/session', {
            title: `${title} PDF rejection`,
          });
          sessions.push(next.id);
          const previous = pdfRequests.length;
          await client.request('POST', `/session/${next.id}/prompt`, {
            model: { providerID: 'fixture', modelID: 'fixture-pdf-error' },
            parts: [{ type: 'file', mime: pdf.mime, filename: pdf.filename, url: pdf.url }],
          });
          const history = await client.request('GET', `/session/${next.id}/message?limit=100`);
          assert.equal(pdfRequests.length, previous + 1);
          assert.equal(
            history.filter(
              (message) =>
                message.info.role === 'user' && message.parts.some((part) => part.type === 'file')
            ).length,
            1
          );
          assert.ok(
            history.some(
              (message) =>
                message.info.error &&
                JSON.stringify(message.info.error).includes('Fixture provider rejected PDF')
            )
          );
          evidence.cases.push({
            kind: 'provider rejection',
            status: 'PASS',
            admission: true,
            providerRequests: 1,
          });
        });
        await writeFile(
          path.join(root, 'pdf-compatibility.json'),
          JSON.stringify(evidence, null, 2)
        );
        t.diagnostic(`PDF fixture-provider evidence: ${root}/pdf-compatibility.json`);
      }
      if (process.env.VARRO_AI_TEST_EDITOR === '1') {
        const { stdout } = await promisify(execFile)(
          process.execPath,
          ['scripts/launch-ai-vscode.mjs'],
          {
            cwd: path.resolve('.'),
            env: {
              ...process.env,
              VARRO_AI_SERVER_URL: url,
              VARRO_AI_WORKSPACE: workspace,
              VARRO_AI_DATA_DIR: path.join(root, 'data/opencode'),
            },
            timeout: 60000,
          }
        );
        const launch = JSON.parse(await readFile(stdout.match(/Launch metadata: (.+)/)[1], 'utf8'));
        let cdp;
        try {
          assert.equal(launch.isolation.backend.apiVersion, major);
          cdp = await CdpController.connect(launch.remoteDebuggingPort, {
            surface: 'sidebar',
            viewId: 'sidebar',
          });
          const sessionIsOpen = (snapshot) =>
            snapshot.title === title &&
            snapshot.turnMessageIds.some((id) =>
              messages.some((message) => message.info.id === id)
            );
          const openDeadline = Date.now() + 10000;
          while (Date.now() < openDeadline && !sessionIsOpen(await cdp.snapshot())) {
            await cdp.click('[aria-label="Back to sessions"]');
            await cdp.click(`.session-item[data-session-id="${session.id}"] .session-item-main`);
            await delay(250);
          }
          const opened = await cdp.snapshot();
          await writeFile(path.join(root, 'editor-open.json'), JSON.stringify(opened, null, 2));
          assert.ok(sessionIsOpen(opened), JSON.stringify(opened));
          assert.ok(await cdp.click('[aria-label="Message composer"]'));
          await cdp.call('Input.insertText', {
            text: 'VFZ-UI-FOLLOWUP. Reply with the fixture response. Do not use tools.',
          });
          const sendDeadline = Date.now() + 5000;
          while (
            !(await cdp.evaluate(`(() => {
              const button = document.querySelector('.chat-send-button');
              return button && !button.disabled && !button.classList.contains('disabled');
            })()`)) &&
            Date.now() < sendDeadline
          )
            await delay(100);
          assert.ok(await cdp.click('.chat-send-button:not(.disabled)'));
          const uiDeadline = Date.now() + 15000;
          let canonical;
          while (Date.now() < uiDeadline) {
            canonical = await client.request('GET', `/session/${session.id}/message?limit=1000`);
            if (
              canonical.filter(
                (message) => message.info.role === 'assistant' && message.info.time?.completed
              ).length >= 2
            )
              break;
            await delay(100);
          }
          assert.equal(
            canonical.filter(
              (message) =>
                message.info.role === 'user' &&
                message.parts.some((part) => part.text?.includes('VFZ-UI-FOLLOWUP'))
            ).length,
            1
          );
          assert.equal(
            canonical.filter(
              (message) => message.info.role === 'assistant' && message.info.time?.completed
            ).length,
            2
          );
          await writeFile(
            path.join(root, 'editor.json'),
            JSON.stringify({ launch, snapshot: await cdp.snapshot(), canonical }, null, 2)
          );
          if (major === 2) {
            const { data: form } = await client.wire('POST', `/api/session/${session.id}/form`, {
              title: 'Reload checkpoint regression',
              fields: [
                { key: 'answer', type: 'string', title: 'Saved answer', required: true },
                { key: 'count', type: 'integer', title: 'Saved zero', default: 0 },
                { key: 'confirm', type: 'boolean', title: 'Saved false', default: false },
                {
                  key: 'choices',
                  type: 'multiselect',
                  title: 'Selections',
                  options: [],
                  custom: true,
                },
              ],
            });
            const readDraft = () =>
              cdp.evaluate(`(() => {
              const form = document.querySelector('form[aria-label="Reload checkpoint regression"]');
              if (!form) return null;
              return Object.fromEntries([...form.querySelectorAll('input, textarea, [role="combobox"]')]
                .filter(control => ['Saved answer', 'Saved zero', 'Saved false', 'Selections: custom option'].includes(control.getAttribute('aria-label')))
                .map(control => [control.getAttribute('aria-label'), control.value]));
            })()`);
            const formDeadline = Date.now() + 10000;
            while (!(await readDraft()) && Date.now() < formDeadline) await delay(100);
            assert.ok(await cdp.click('[aria-label="Saved answer"]'));
            await cdp.call('Input.insertText', { text: 'keep-this-answer' });
            assert.ok(await cdp.click('[aria-label="Selections: custom option"]'));
            await cdp.call('Input.insertText', { text: 'unfinished selection' });
            const expected = {
              'Saved answer': 'keep-this-answer',
              'Saved zero': '0',
              'Saved false': 'false',
              'Selections: custom option': 'unfinished selection',
            };
            const before = await readDraft();
            assert.deepEqual(before, expected);
            const viewId = cdp.targetContext.viewId;
            cdp.close();
            await reloadVscodeWindow(launch.remoteDebuggingPort);
            cdp = await CdpController.connect(launch.remoteDebuggingPort, { viewId });
            const restoreDeadline = Date.now() + 10000;
            while (!(await readDraft()) && Date.now() < restoreDeadline) await delay(100);
            const after = await readDraft();
            const pending = await client.wire('GET', `/api/session/${session.id}/form/${form.id}`);
            await writeFile(
              path.join(root, 'editor-form-reload.json'),
              JSON.stringify(
                {
                  sessionID: session.id,
                  formID: form.id,
                  viewId,
                  before,
                  after,
                  state: pending.data.state,
                },
                null,
                2
              )
            );
            assert.equal(pending.data.state.status, 'pending', 'Reload must not submit the draft');
            assert.deepEqual(
              after,
              expected,
              'Pending values and custom text must survive editor reload'
            );
            // Restoring typed custom text does not select its multiselect checkbox.
            const customSelection = '[aria-label="Selections: select custom value 1"]';
            assert.equal(
              await cdp.evaluate(`document.querySelector('${customSelection}').checked`),
              false
            );
            assert.ok(await cdp.click(customSelection));
            assert.equal(
              await cdp.evaluate(`document.querySelector('${customSelection}').checked`),
              true
            );
            assert.ok(await cdp.click('form.native-form button[type="submit"]'));
            let resolved;
            const replyDeadline = Date.now() + 10000;
            while (Date.now() < replyDeadline) {
              resolved = await client.wire('GET', `/api/session/${session.id}/form/${form.id}`);
              if (resolved.data.state.status === 'answered') break;
              await delay(100);
            }
            assert.deepEqual(resolved.data.state, {
              status: 'answered',
              answer: {
                answer: 'keep-this-answer',
                count: 0,
                confirm: false,
                choices: ['unfinished selection'],
              },
            });
            t.diagnostic(
              `OpenCode ${version}: real-editor pending form reload and typed reply passed`
            );
          }
          t.diagnostic(
            `OpenCode ${version}: authenticated real VS Code launcher and native composer follow-up passed`
          );
        } finally {
          cdp?.close();
          const cleanup = await cleanupOwnedHost(launch);
          assert.equal(cleanup.hostExited, true);
          assert.equal(cleanup.debugEndpointStopped, true);
          await writeFile(path.join(root, 'editor-cleanup.json'), JSON.stringify(cleanup, null, 2));
        }
      }
      assert.deepEqual(await client.request('GET', '/permission'), []);
      assert.deepEqual(await client.request('GET', '/question'), []);
      await client.request('GET', '/session/status');
      const fork = await client.request('POST', `/session/${session.id}/fork`);
      sessions.push(fork.id);
      await client.request('PATCH', `/session/${fork.id}`, { title: `${title} fork` });
      assert.equal((await client.request('GET', `/session/${fork.id}`)).title, `${title} fork`);
      assert.ok(
        (await client.request('GET', `/session/${fork.id}/message?limit=1000`)).length >= 2
      );
      assert.ok(
        (await client.request('GET', '/session?roots=true&limit=1000')).some(
          (item) => item.id === fork.id
        )
      );
      t.diagnostic(
        `OpenCode ${version}: isolation, prompt, canonical history, status, pending input, fork, rename, cleanup. Evidence: ${root}`
      );
    } finally {
      for (const id of sessions.toReversed()) {
        const session = await client.request('GET', `/session/${id}`);
        // Fork titles are server-generated until the guarded rename above succeeds.
        assert.ok(session.title.startsWith(title));
        await client.request('DELETE', `/session/${id}`);
      }
      const remaining = await client.request('GET', '/session?limit=1000');
      assert.ok(sessions.every((id) => !remaining.some((session) => session.id === id)));
      await writeFile(
        path.join(root, 'result.json'),
        JSON.stringify({ version, isolation, sessions, deleted: true }, null, 2)
      );
    }
  }
);
