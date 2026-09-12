import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after as afterAll, before as beforeAll, test } from 'node:test';
import { chromium } from '@playwright/test';

import { CdpController, executeActionPlan } from '../ai-fuzzy-live.mjs';

let browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

async function fixture(t, nested = false) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  t.after(() => page.close());
  const markers = Array.from(
    { length: 60 },
    (_, index) => `<button class="turn-navigation-marker" id="marker-${index}"></button>`
  ).join('');
  await page.setContent(`
    <style>
      body { margin: 0; }
      .interactive-list { position: absolute; inset: 20px 20px 20px 60px; overflow: auto; }
      .content { height: 4000px; }
      .anchor { height: 20px; }
    </style>
    <div class="interactive-list"><div class="content"><div class="anchor">Anchor</div>
      ${nested ? `<div class="turn-navigation">${markers}</div>` : ''}
      <button id="outer-target" style="margin-top: 1000px">Outer target</button>
    </div></div>
    ${nested ? '' : `<div class="turn-navigation">${markers}</div>`}
  `);
  await page.addStyleTag({
    content: await readFile(
      new URL('../../src/webview/styles/chat-shell.css', import.meta.url),
      'utf8'
    ),
  });
  await page.addStyleTag({
    content: '.interactive-list { position: absolute; } .turn-navigation { z-index: 10; }',
  });
  const session = await page.context().newCDPSession(page);
  const wheels = [];
  const controller = Object.create(CdpController.prototype);
  controller.evaluate = (expression) => page.evaluate(expression);
  controller.call = async (method, params) => {
    assert.equal(method, 'Input.dispatchMouseEvent');
    assert.equal(params.type, 'mouseWheel');
    wheels.push(params);
    return session.send(method, params);
  };
  const state = () =>
    page.evaluate(() => ({
      outer: document.querySelector('.interactive-list').scrollTop,
      anchorTop: document.querySelector('.anchor').getBoundingClientRect().top,
      inner: document.querySelector('.turn-navigation').scrollTop,
    }));
  return { page, controller, wheels, state };
}

for (const nested of [false, true]) {
  test(`reveals clipped navigation markers in both directions without moving the transcript (${nested ? 'nested' : 'sibling'})`, async (t) => {
    const { page, controller, wheels, state } = await fixture(t, nested);
    const before = await state();
    for (const index of [45, 0]) {
      const point = await controller.point(`#marker-${index}`);
      assert.ok(point, `marker ${index} must be reachable`);
      assert.equal(
        await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, point),
        `marker-${index}`
      );
      const after = await state();
      assert.equal(after.outer, before.outer);
      assert.equal(after.anchorTop, before.anchorTop);
      assert.equal(index === 45 ? after.inner > 0 : after.inner === 0, true);
    }
    assert.ok(wheels.some((wheel) => wheel.deltaY > 0));
    assert.ok(wheels.some((wheel) => wheel.deltaY < 0));
    assert.ok(wheels.length <= 48);
  });
}

test('returns an already visible hit without wheeling and still reveals outer targets', async (t) => {
  const { page, controller, wheels } = await fixture(t);
  assert.ok(await controller.point('#marker-0'));
  assert.equal(wheels.length, 0);
  const point = await controller.point('#outer-target');
  assert.ok(point);
  assert.equal(
    await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, point),
    'outer-target'
  );
  assert.ok(wheels.length > 0 && wheels.length <= 24);
});

for (const position of ['below', 'above']) {
  test(`reveals a nested scroller ${position} the viewport before scrolling its contents`, async (t) => {
    const { page, controller, wheels, state } = await fixture(t, true);
    await page.addStyleTag({
      content: `.turn-navigation { top: ${position === 'below' ? 1100 : 200}px; transform: none; }`,
    });
    if (position === 'above') {
      await page.mouse.move(1000, 400);
      await page.mouse.wheel(0, 600);
      await page.waitForFunction(
        () => document.querySelector('.interactive-list').scrollTop === 600
      );
    }
    assert.equal(
      await page.evaluate(() => {
        const inner = document.querySelector('.turn-navigation').getBoundingClientRect();
        const outer = document.querySelector('.interactive-list').getBoundingClientRect();
        return inner.bottom <= outer.top || inner.top >= outer.bottom;
      }),
      true
    );
    const gestures = [];
    const dispatch = controller.call;
    controller.call = async (method, params) => {
      gestures.push({
        ...(await state()),
        ...(await page.evaluate(({ x, y }) => {
          const owner = document.querySelector('.turn-navigation').getBoundingClientRect();
          const outer = document.querySelector('.interactive-list').getBoundingClientRect();
          const target = document.querySelector('#marker-45').getBoundingClientRect();
          return {
            nested: !!document.elementFromPoint(x, y)?.closest('.turn-navigation'),
            ownerVisible: owner.bottom > outer.top && owner.top < outer.bottom,
            targetOutsideOuter: target.bottom <= outer.top || target.top >= outer.bottom,
          };
        }, params)),
      });
      return dispatch(method, params);
    };
    const point = await controller.point('#marker-45');
    assert.ok(point, `offscreen owner must be revealed; dispatched ${wheels.length} wheels`);
    assert.equal(
      await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, point),
      'marker-45'
    );
    const handoff = gestures.findIndex((gesture) => gesture.nested);
    assert.ok(handoff > 0, 'outer reveal must precede nested scrolling');
    assert.ok(gestures.slice(0, handoff).every((gesture) => gesture.inner === 0));
    const after = await state();
    for (const [index, gesture] of gestures.entries()) {
      if (gesture.nested) {
        assert.equal(gesture.ownerVisible, true);
        const next = gestures[index + 1] ?? after;
        assert.equal(next.outer, gesture.outer);
        assert.equal(next.anchorTop, gesture.anchorTop);
      } else {
        assert.ok(
          !gesture.ownerVisible || gesture.targetOutsideOuter,
          'outer wheels must reveal a clipped owner or target'
        );
      }
    }
    assert.ok(after.inner > 0);
    assert.equal(Math.sign(wheels[0].deltaY), position === 'below' ? 1 : -1);
    assert.ok(wheels.length <= 24);
  });
}

test('reveals in a short scroller without overshooting or chaining at its boundary', async (t) => {
  const { page, controller, state } = await fixture(t, true);
  await page.addStyleTag({ content: '.turn-navigation { max-height: 33px; }' });
  const before = await state();
  for (const index of [10, 59, 0]) {
    const point = await controller.point(`#marker-${index}`, 'right');
    assert.ok(point);
    assert.equal(
      await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, point),
      `marker-${index}`
    );
    assert.equal((await state()).outer, before.outer);
    assert.equal((await state()).anchorTop, before.anchorTop);
  }
});

test('preserves message scope and safe hit testing when revealing nested content', async (t) => {
  const { page, controller, state } = await fixture(t, true);
  await page.evaluate(() => {
    const navigation = document.querySelector('.turn-navigation');
    navigation.style.width = '180px';
    navigation.innerHTML = `<div data-msg-id="other"><div class="target">Other message</div></div>
      <div style="height: 600px; flex: 0 0 auto"></div>
      <div data-msg-id="wanted"><div class="target" style="width: 160px; height: 80px">
        <button style="width: 50px; height: 80px">Control</button>
      </div></div>`;
  });
  const before = await state();
  const point = await controller.point('.target', 'safe', { messageIds: ['wanted'] });
  assert.ok(point);
  assert.deepEqual(
    await page.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return {
        messageId: hit.closest('[data-msg-id]')?.dataset.msgId,
        control: !!hit.closest('button'),
      };
    }, point),
    { messageId: 'wanted', control: false }
  );
  assert.equal((await state()).outer, before.outer);
  assert.equal((await state()).anchorTop, before.anchorTop);
});

test('does not wheel the transcript when navigation is occluded or cannot scroll', async (t) => {
  const { page, controller, wheels, state } = await fixture(t, true);
  const before = await state();
  await page.addStyleTag({ content: '.turn-navigation { overflow-y: hidden; }' });
  assert.equal(await controller.point('#marker-45'), null);
  await page.addStyleTag({
    content:
      '.turn-navigation { overflow-y: auto; } .cover { position: fixed; inset: 0; z-index: 100; }',
  });
  await page.evaluate(() => {
    const cover = document.createElement('div');
    cover.className = 'cover';
    document.body.append(cover);
  });
  assert.equal(await controller.point('#marker-45'), null);
  assert.equal(wheels.length, 0);
  assert.deepEqual(await state(), before);
});

test('bounds native reveal attempts when wheel input is canceled', async (t) => {
  const { page, controller, wheels, state } = await fixture(t);
  await page.evaluate(() =>
    document
      .querySelector('.turn-navigation')
      .addEventListener('wheel', (event) => event.preventDefault(), { passive: false })
  );
  const before = await state();
  assert.equal(await controller.point('#marker-45'), null);
  assert.equal(wheels.length, 24);
  assert.deepEqual(await state(), before);
});

test('expands a painted disclosure instead of a hidden retained summary in the same turn', async (t) => {
  const { page, controller, wheels } = await fixture(t);
  await page.evaluate(() => {
    document.querySelector('.content').innerHTML = `
      <div data-msg-id="current">
        <button class="assistant-activity-summary" style="display:none" data-activity-summary-group-key="retained" aria-expanded="false">Retained</button>
        <button class="assistant-activity-summary" data-activity-summary-group-key="painted" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">Explored</button>
      </div>`;
  });
  const session = await page.context().newCDPSession(page);
  controller.call = (method, params) => session.send(method, params);
  const before = await controller.captureActionState({ messageIds: ['current'] });
  assert.deepEqual(before.disclosures.map((item) => item.visible), [false, true]);
  const actions = await executeActionPlan(controller, [{ step: 9, action: 'expand disclosure' }], 'test', 0, {
    scope: { messageIds: ['current'] },
  });
  assert.equal(actions[0].executed, true);
  assert.equal(await page.locator('[data-activity-summary-group-key="painted"]').getAttribute('aria-expanded'), 'true');
  assert.equal(wheels.length, 0);
});

test('refreshes disclosure targeting when the first retained summary is occluded', async (t) => {
  const { page, controller } = await fixture(t);
  await page.evaluate(() => {
    document.querySelector('.content').innerHTML = `
      <div data-msg-id="current">
        <button class="assistant-activity-summary" data-activity-summary-group-key="occluded" aria-expanded="false">Occluded</button>
        <div style="height:1000px"></div>
        <button class="assistant-activity-summary" data-activity-summary-group-key="reachable" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true')">Explored</button>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', '<div style="position:fixed;inset:0 0 auto;height:100px;z-index:100">Sticky overlay</div>');
  });
  const session = await page.context().newCDPSession(page);
  controller.call = (method, params) => session.send(method, params);
  const actions = await executeActionPlan(controller, [{ step: 9, action: 'expand disclosure' }], 'test', 0, { scope: { messageIds: ['current'] } });
  assert.equal(actions[0].executed, true);
  assert.deepEqual(actions[0].targetingAttempts, [
    { key: 'occluded', dispatched: false },
    { key: 'reachable', dispatched: true },
  ]);
  assert.equal(await page.locator('[data-activity-summary-group-key="occluded"]').getAttribute('aria-expanded'), 'false');
});
