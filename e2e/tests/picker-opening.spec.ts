import { expect, test } from '@playwright/test';

const pickers = [
  { name: 'permissions', trigger: '.permission-mode-button', menu: '.permission-mode-popover' },
  { name: 'agents', trigger: '[aria-label="Select agent"]', menu: '.agent-popover' },
  { name: 'models', trigger: '.model-picker-btn', menu: '.model-picker-menu' },
  { name: 'reasoning', trigger: '[aria-label="Thinking level"]', menu: '.variant-popover' },
];

for (const delay of [0, 100]) {
  for (const width of [420, 1000]) {
    for (const picker of pickers) {
      test(`${picker.name} opens in its final position at ${width}px with ${delay}ms placement delay`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        if (delay > 0) {
          // Shadow the placement module's scheduler, not the page scheduler: Solid
          // must be able to mount the real menu before we sample the hidden gap.
          await page.route('**/src/webview/lib/popup-position.ts*', async (route) => {
            const response = await route.fetch();
            await route.fulfill({
              response,
              body: `let delayFirstPlacement = true;
                const queueMicrotask = (place) => {
                  const menu = document.querySelector(${JSON.stringify(picker.menu)});
                  if (!menu || !delayFirstPlacement) return window.queueMicrotask(place);
                  delayFirstPlacement = false;
                  requestAnimationFrame(() => setTimeout(() => {
                    menu.dispatchEvent(new Event('picker-test:placement', { bubbles: true }));
                    window.queueMicrotask(place);
                  }, ${delay}));
                };\n${await response.text()}`,
            });
          });
        }
        await page.goto('/e2e/harness/index.html?scenario=model-search');
        await expect(page.locator(picker.trigger)).toBeVisible();

        const frames = await page.evaluate(async ({ trigger, menu }) => {
          const button = document.querySelector<HTMLButtonElement>(trigger);
          if (!button) throw new Error(`Missing picker trigger: ${trigger}`);
          let placementStarted = false;
          const markPlacement = () => {
            placementStarted = true;
          };
          document.addEventListener('picker-test:placement', markPlacement);
          const samples: Array<{
            visible: boolean;
            placementStarted: boolean;
            left: number;
            top: number;
            bottom: number;
            width: number;
            unobscured: boolean;
            aboveFade: boolean;
            focused: boolean;
          }> = [];
          try {
            button.click();
            for (let index = 0; index < 24; index += 1) {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              const element = document.querySelector<HTMLElement>(menu);
              if (!element) continue;
              const box = element.getBoundingClientRect();
              const visible = getComputedStyle(element).visibility === 'visible';
              const shell = element.closest('.chat-input-shell');
              const fade = document.querySelector('.interactive-list-bottom-fade-wrap');
              const hit = document.elementFromPoint(box.left + box.width / 2, box.bottom - 8);
              samples.push({
                visible,
                placementStarted,
                left: box.left,
                top: box.top,
                bottom: box.bottom,
                width: box.width,
                unobscured: !!hit && element.contains(hit),
                aboveFade:
                  !fade ||
                  (!!shell &&
                    Number(getComputedStyle(shell).zIndex) > Number(getComputedStyle(fade).zIndex)),
                focused: element.contains(document.activeElement),
              });
            }
          } finally {
            document.removeEventListener('picker-test:placement', markPlacement);
          }
          return samples;
        }, picker);

        expect(frames.length).toBeGreaterThan(0);
        if (delay > 0) {
          expect(frames.some((frame) => !frame.placementStarted)).toBe(true);
          expect(
            frames.filter((frame) => !frame.placementStarted).every((frame) => !frame.visible)
          ).toBe(true);
        }
        const visibleFrames = frames.filter((frame) => frame.visible);
        expect(visibleFrames.length).toBeGreaterThan(0);
        const finalFrame = visibleFrames.at(-1)!;
        for (const frame of visibleFrames) {
          expect(Math.abs(frame.left - finalFrame.left)).toBeLessThanOrEqual(1);
          expect(Math.abs(frame.top - finalFrame.top)).toBeLessThanOrEqual(1);
          expect(Math.abs(frame.bottom - finalFrame.bottom)).toBeLessThanOrEqual(1);
          expect(Math.abs(frame.width - finalFrame.width)).toBeLessThanOrEqual(1);
          expect(frame.unobscured).toBe(true);
          expect(frame.aboveFade).toBe(true);
        }
        if (picker.name === 'models') expect(finalFrame.focused).toBe(true);
      });
    }
  }
}
