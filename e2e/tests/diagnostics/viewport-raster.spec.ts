import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { viewportPixelGaps } from '../viewport-pixels';

test('static native wheel raster diagnostic', async ({ page }) => {
  await page.setViewportSize({ width: 486, height: 794 });
  await page.setContent(`<style>
    body { margin: 0; background: #242424; color: #ddd; font: 14px Arial; }
    #list { position: absolute; top: 37px; left: 1px; width: 484px; height: 631px; overflow: auto; }
    p { margin: 0; height: 24px; }
    </style><div id="list">${Array.from({ length: 2400 }, (_, i) => `<p>Static transcript line ${i}: native wheel raster coverage</p>`).join('')}</div>`);
  await page.locator('#list').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(1000);
  await page.mouse.move(240, 350);
  const cdp = await page.context().newCDPSession(page);
  const frames: string[] = [];
  cdp.on('Page.screencastFrame', (frame) => {
    frames.push(frame.data);
    // A final frame can arrive while the capture session is detaching.
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  await page.waitForTimeout(100);
  await page.mouse.wheel(0, -720);
  await page.waitForTimeout(300);
  await cdp.send('Page.stopScreencast');
  await cdp.detach();
  // Preserve the original repro's scan region: x=[19,461), y=[187,647).
  const gaps = await viewportPixelGaps(page, frames, { x: 1, y: 37, width: 484, height: 630 });
  await writeFile(test.info().outputPath('coverage.json'), JSON.stringify(gaps));
  for (let index = 0; index < frames.length; index += 1) {
    if (gaps[index]! <= 80) continue;
    const body = Buffer.from(frames[index]!, 'base64');
    await writeFile(test.info().outputPath(`partial-viewport-${index}.png`), body);
    await test.info().attach(`partial-viewport-${index}`, { body, contentType: 'image/png' });
  }
  expect(frames.length).toBeGreaterThan(1);
  expect(Math.max(...gaps), JSON.stringify(gaps)).toBeLessThanOrEqual(80);
});
