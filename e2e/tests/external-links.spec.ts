/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The E2E harness installs these fixture and bridge accessors. */
import { expect, test } from '@playwright/test';
import type { Message, Part } from '../../src/shared/opencode-types';
import type { MessageEntry } from '../../src/webview/types';

for (const url of ['http://ingest.above-all.test/', 'https://example.test/docs']) {
  test(`opens ${url} once without forwarding native link clicks to the webview host`, async ({
    page,
  }) => {
    await page.goto('/e2e/harness/index.html?scenario=rapid-streaming-jitter');
    const assistant = page.locator('[data-msg-id="message-rapid-assistant-streaming"]');
    await expect(assistant.locator('.rendered-markdown')).toHaveText('Starting...');
    await page.evaluate((href) => {
      const harness = (
        window as Window & {
          __varroE2E?: {
            getSessionMessages(id: string): MessageEntry[];
            updateMessagePart(part: Part): void;
            updateMessageInfo(info: Message): void;
            updateSessionStatus(id: string, status: { type: 'idle' }): void;
          };
        }
      ).__varroE2E;
      if (!harness) throw new Error('Missing E2E harness');
      const sessionID = 'session-rapid-streaming-jitter';
      const messages = harness.getSessionMessages(sessionID);
      for (const messageID of [
        'message-rapid-user-streaming',
        'message-rapid-assistant-streaming',
      ]) {
        const entry = messages.find((message) => message.info.id === messageID);
        const original = entry?.parts.find((part) => part.type === 'text');
        if (!entry || !original) throw new Error(`Missing link-test message ${messageID}`);
        const part: Part = {
          ...original,
          type: 'text',
          text:
            entry.info.role === 'assistant'
              ? `[Docs](${href}) ${href}\n\n| Component | URL |\n| --- | --- |\n| Ingestion | ${href} |\n\nFile: \`src/shared/protocol.ts:12-15\`\n\n[Project folder](src/) [Local folder](file:///workspace/varro/src/)`
              : `See ${href}.`,
        };
        harness.updateMessagePart(part);
        window.postMessage(
          { type: 'server/event', payload: { type: 'message.part.updated', properties: { part } } },
          '*'
        );
        if (entry.info.role === 'assistant') {
          const info: Message = {
            ...entry.info,
            time: { ...entry.info.time, completed: Date.now() },
            finish: 'stop',
          };
          harness.updateMessageInfo(info);
          window.postMessage(
            { type: 'server/event', payload: { type: 'message.updated', properties: { info } } },
            '*'
          );
        }
      }
      harness.updateSessionStatus(sessionID, { type: 'idle' });
      window.postMessage(
        {
          type: 'server/event',
          payload: { type: 'session.status', properties: { sessionID, status: { type: 'idle' } } },
        },
        '*'
      );
    }, url);

    const user = page.locator('[data-msg-id="message-rapid-user-streaming"]');
    await expect(assistant.locator('a.external-link')).toHaveCount(3);
    await expect(user.locator('a.external-link')).toHaveCount(1);
    const host = await page.evaluateHandle(() => {
      const observations = { linkClicks: 0, contextMenus: 0 };
      // Match VS Code's window-level handling: it does not check defaultPrevented for links.
      window.addEventListener('click', (event) => {
        if (event.composedPath().some((node) => node instanceof HTMLAnchorElement && node.href)) {
          observations.linkClicks += 1;
        }
      });
      window.addEventListener('contextmenu', (event) => {
        if (!event.defaultPrevented) observations.contextMenus += 1;
      });
      return observations;
    });

    for (const label of [
      assistant.locator('a.external-link .link-leading-label').nth(0),
      assistant.locator('a.external-link .link-leading-label').nth(1),
      assistant.locator('a.external-link .link-leading-label').nth(2),
      user.locator('a.external-link .link-leading-label'),
    ]) {
      await label.click();
    }
    const externalUrls = await page.evaluate(
      () =>
        (window as Window & { __varroE2E?: { externalUrls: string[] } }).__varroE2E?.externalUrls
    );
    expect(externalUrls).toEqual([url, url, url, url]);
    expect(await host.evaluate((observations) => observations.linkClicks)).toBe(0);

    const link = user.locator('a.external-link');
    expect(JSON.parse((await link.getAttribute('data-vscode-context')) ?? '{}')).toEqual({
      preventDefaultContextMenuItems: true,
      varroLinkText: url,
      webviewSection: 'varroExternalLink',
      varroLinkUrl: url,
    });
    await link.click({ button: 'right' });
    expect(await host.evaluate((observations) => observations.contextMenus)).toBe(1);
    const fileLink = assistant.locator('a.file-path-link').nth(0);
    await expect(fileLink).toHaveText('protocol.ts (line 12-15)');
    expect(JSON.parse((await fileLink.getAttribute('data-vscode-context')) ?? '{}')).toEqual({
      preventDefaultContextMenuItems: true,
      varroLinkText: 'protocol.ts (line 12-15)',
      webviewSection: 'varroFileLink',
      varroFilePath: '/workspace/varro/src/shared/protocol.ts',
    });
    await fileLink.locator('.link-leading-label').click({ button: 'right' });
    expect(await host.evaluate((observations) => observations.contextMenus)).toBe(2);
    for (const [index, text] of ['Project folder', 'Local folder'].entries()) {
      const folderLink = assistant.locator('a.file-path-link').nth(index + 1);
      await expect(folderLink).toHaveText(text);
      expect(JSON.parse((await folderLink.getAttribute('data-vscode-context')) ?? '{}')).toEqual({
        preventDefaultContextMenuItems: true,
        varroLinkText: text,
        webviewSection: 'varroFileLink',
        varroFilePath: '/workspace/varro/src',
      });
      await folderLink.locator('.link-leading-label').click({ button: 'right' });
      expect(await host.evaluate((observations) => observations.contextMenus)).toBe(index + 3);
    }
    await host.dispose();
  });
}
