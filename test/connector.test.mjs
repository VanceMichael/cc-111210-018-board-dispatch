import test from 'node:test';
import assert from 'node:assert/strict';
import { openBrowser } from '../src/browser.mjs';
import { inspect } from '../src/connector.mjs';
import { startFixture } from '../fixtures/source.mjs';

test('真实看板按航次区分重名卡且拖放需要确认', async () => {
  const source = await startFixture();
  let session;
  try {
    // 只读查看器会滚动虚拟列表并临时展开折叠泳道，读到全部 9 张卡。
    const cards = await inspect(source.url);
    assert.equal(cards.length, 9);
    assert.deepEqual(
      cards.filter(card => card.text.includes('装卸') && card.lane === 'pending').map(card => card.voyage).sort(),
      ['V1', 'V2', 'V3', 'V4', 'V5', 'V6']
    );
    assert.ok(cards.filter(card => card.title === '装卸' || card.text.includes('装卸')).length >= 2);

    session = await openBrowser(source.url);
    const dialog = new Promise(resolve => session.page.once('dialog', async value => {
      const message = value.message();
      await value.accept();
      resolve(message);
    }));
    // V1-LOAD 位于待分派首屏，可直接拖放；team-a 初始展开。
    await session.page.locator('[data-lane="pending"] [data-key="V1-LOAD"]').dragTo(session.page.locator('[data-lane="team-a"] [data-accept-zone]'));
    assert.match(await dialog, /确认分派 V1-LOAD 到 team-a/);
    await session.page.locator('#app').evaluate(element => element.dataset.saved === 'true');
    assert.equal(await session.page.locator('[data-lane="team-a"] [data-key="V1-LOAD"]').count(), 1);
    assert.equal(await session.page.locator('[data-lane="pending"] [data-key="V1-LOAD"]').count(), 0);
    const other = await session.page.locator('[data-lane="pending"] [data-key="V2-LOAD"]').count();
    assert.equal(other, 1);
  } finally {
    await session?.close();
    await source.close();
  }
});
