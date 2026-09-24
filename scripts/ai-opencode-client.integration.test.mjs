import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import http from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AiOpenCodeClient } from './ai-opencode-client.mjs';
import { requireIsolatedTestServer } from './ai-test-isolation.mjs';
import { CdpController, sessionSnapshotMatches } from './ai-fuzzy-live.mjs';
import { cleanupOwnedHost } from './ai-streaming.mjs';

const binary = process.env.VARRO_OPENCODE_TEST_BINARY;
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
    const model = http.createServer(async (request, response) => {
      await Array.fromAsync(request);
      generationCount += 1;
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
                models: { fixture: { name: 'Fixture', limit: { context: 32000, output: 1000 } } },
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
          const openDeadline = Date.now() + 10000;
          while (
            Date.now() < openDeadline &&
            !sessionSnapshotMatches(await cdp.snapshot(), session.id, title)
          ) {
            await cdp.click('[aria-label="Back to sessions"]');
            await cdp.clickSession(session.id);
            await delay(250);
          }
          const opened = await cdp.snapshot();
          await writeFile(path.join(root, 'editor-open.json'), JSON.stringify(opened, null, 2));
          assert.ok(sessionSnapshotMatches(opened, session.id, title), JSON.stringify(opened));
          assert.ok(
            await cdp.sendComposerPrompt(
              'VFZ-UI-FOLLOWUP. Reply with the fixture response. Do not use tools.'
            )
          );
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
