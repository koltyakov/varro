import { expect, test } from '@playwright/test';

for (const scenario of ['large-transcript', 'blank', 'busy-stop-send']) {
  const action =
    scenario === 'busy-stop-send' ? 'queueing' : scenario === 'blank' ? 'first send of' : 'sending';
  for (const reducedMotion of [false, true]) {
    test(`${action} a tall draft collapses ${reducedMotion ? 'immediately with reduced motion' : 'smoothly'}`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
      await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
      await page.goto(`/e2e/harness/index.html?scenario=${scenario}`);
      const composer = page.locator('[role="textbox"][aria-multiline="true"]').first();
      const frame = page.locator('.chat-input-container').first();
      await expect(composer).toBeVisible();
      await page.evaluate(() => {
        window.postMessage(
          {
            type: 'files/dropped',
            payload: Array.from({ length: 6 }, (_, index) => ({
              path: `/workspace/varro/src/attachment-${index}.ts`,
              relativePath: `src/attachment-${index}.ts`,
              type: 'file',
            })),
          },
          '*'
        );
      });
      await expect(frame.locator('.chat-attachment-chip')).toHaveCount(6);
      await composer.fill(
        Array.from(
          { length: 10 },
          (_, index) => `Review the attached files, line ${index + 1}.`
        ).join('\n')
      );

      // Assert easing at a fixed frame cadence rather than the CI runner's available CPU time.
      await page.clock.pauseAt(new Date('2030-01-01T00:01:00Z'));
      await frame.evaluate((element) => {
        const toolbar = element.querySelector('.toolbar-main')!;
        const measure = () => {
          const bounds = element.getBoundingClientRect();
          return {
            height: bounds.height,
            toolbarBottomGap: bounds.bottom - toolbar.getBoundingClientRect().bottom,
          };
        };
        const samples = [measure()];
        const sample = () => {
          samples.push(measure());
          if (samples.length < 40) requestAnimationFrame(sample);
          else element.setAttribute('data-collapse-samples', JSON.stringify(samples));
        };
        element.addEventListener('keydown', () => requestAnimationFrame(sample), {
          once: true,
          capture: true,
        });
      });
      await composer.press('Enter');
      for (let index = 0; index < 40; index += 1) await page.clock.runFor(16);
      await expect(frame).toHaveAttribute('data-collapse-samples');
      const samples: Array<{ height: number; toolbarBottomGap: number }> = JSON.parse(
        (await frame.getAttribute('data-collapse-samples'))!
      );
      const heights = samples.map((sample) => sample.height);
      for (const sample of samples) {
        expect(sample.toolbarBottomGap, JSON.stringify(samples)).toBeCloseTo(
          samples[0]!.toolbarBottomGap,
          0
        );
      }

      await expect(composer).toHaveText('');
      await expect(frame.locator('.chat-attachment-chip')).toHaveCount(0);
      const start = heights[0]!;
      const end = heights.at(-1)!;
      expect(start - end).toBeGreaterThan(100);
      const intermediate = heights.filter((height) => height < start - 1 && height > end + 1);
      if (reducedMotion) {
        expect(intermediate).toHaveLength(0);
      } else {
        expect(intermediate.length, JSON.stringify(heights)).toBeGreaterThanOrEqual(4);
        for (let index = 1; index < heights.length; index++) {
          expect(heights[index]!).toBeLessThanOrEqual(heights[index - 1]! + 1);
          expect(heights[index - 1]! - heights[index]!).toBeLessThan((start - end) / 2);
        }
      }
      expect(errors).toEqual([]);
    });
  }
}
