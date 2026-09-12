import { expect, test } from '@playwright/test';

test('in-flow attachments start at the card top while floating chips keep their reserved space', async ({
  page,
}) => {
  await page.setViewportSize({ width: 457, height: 800 });
  await page.goto('/e2e/harness/index.html?scenario=blank');
  await expect(page.locator('.interactive-session')).toBeVisible();

  const offsets = await page.locator('.interactive-session').evaluate((root) => {
    return [true, false].map((inFlow) => {
      const turn = document.createElement('div');
      turn.className = 'chat-turn chat-turn-user';
      const card = document.createElement('div');
      card.className = 'chat-turn-content chat-turn-card user-message-card';
      const content = document.createElement('div');
      content.className = 'rendered-markdown';
      const leading = document.createElement('div');
      if (inFlow) leading.className = 'user-message-leading-content';
      const attachments = document.createElement('div');
      attachments.className =
        'message-attachments message-file-attachments message-attachments-leading';
      attachments.textContent = 'Recording.mp4';
      leading.append(attachments);
      content.append(leading);
      card.append(content);
      turn.append(card);
      root.append(turn);
      const offset = card.getBoundingClientRect().top - turn.getBoundingClientRect().top;
      turn.remove();
      return offset;
    });
  });

  expect(offsets[0]).toBe(0);
  expect(offsets[1]).toBe(33);
});
