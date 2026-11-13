import test from 'node:test';
import assert from 'node:assert/strict';
import { BoardPage } from '../src/board.mjs';
import { previewPlan, executePlan, recoverPlan, parseStatus } from '../src/dispatch.mjs';
import { startFixture } from '../fixtures/source.mjs';

async function scenario(run) {
  const source = await startFixture();
  const board = await BoardPage.open(source.url);
  try {
    return await run(board, source);
  } finally {
    await board.close();
    await source.close();
  }
}

const keys = list => list.map(card => card.key);
const laneKeys = async (board, lane) => keys(await board.laneLocator(lane).locator('[data-card]').evaluateAll(elements => elements.map(element => element.dataset.key)));
const outcome = (result, key) => result.outcomes.find(entry => entry.key === key);

test('预按业务键核对航次，重名卡不会被标题混淆', async () => {
  await scenario(async board => {
    const plan = await previewPlan(board, { target: 'team-a', cards: [{ key: 'V2-LOAD' }] });
    assert.equal(plan.items[0].status, 'ready');
    assert.equal(plan.items[0].voyage, 'V2');
    assert.equal(plan.items[0].title, '装卸');
    // V1-LOAD 与 V2-LOAD 标题相同但航次不同，按 key 定位只动 V2-LOAD。
    assert.equal(plan.pageCards.filter(card => card.title === '装卸').length >= 2, true);
    const result = await executePlan(board, plan);
    assert.equal(outcome(result, 'V2-LOAD').status, 'committed');
    const page = await board.snapshot();
    const v1 = page.cards.find(card => card.key === 'V1-LOAD');
    const v2 = page.cards.find(card => card.key === 'V2-LOAD');
    assert.equal(v2.lane, 'team-a');
    assert.equal(v1.lane, 'pending');
    assert.equal(v2.version, 2);
  });
});

test('计划预览把容量竞争标为冲突，执行只提交可执行项', async () => {
  await scenario(async board => {
    // team-a 只有 2 个名额，计划 4 张卡。
    const request = { target: 'team-a', cards: [{ key: 'V1-LOAD' }, { key: 'V1-CHECK' }, { key: 'V2-LOAD' }, { key: 'V2-CHECK' }] };
    const plan = await previewPlan(board, request);
    assert.deepEqual(plan.ready.map(item => item.key), ['V1-LOAD', 'V2-LOAD']);
    assert.deepEqual(plan.conflicts.map(item => item.key), ['V1-CHECK', 'V2-CHECK']);
    assert.ok(plan.conflicts.every(item => item.reasons.some(reason => reason.code === 'capacity')));
    const result = await executePlan(board, plan);
    assert.deepEqual(result.attribution['V1-LOAD'].pageLane, 'team-a');
    assert.deepEqual(result.attribution['V2-LOAD'].pageLane, 'team-a');
    assert.equal(outcome(result, 'V1-CHECK').status, 'skipped-conflict');
    assert.equal((await board.lane('team-a')).count, 2);
  });
});

test('确认取消不改变归属，依赖它的后继被阻断但无关卡继续', async () => {
  await scenario(async board => {
    // team-b 容量 3：两张卡不触发容量竞争，仅验证取消与依赖阻断。
    const plan = await previewPlan(board, {
      target: 'team-b',
      cards: [{ key: 'V1-LOAD' }, { key: 'V1-CHECK' }, { key: 'V2-LOAD' }],
      confirm: { 'V1-LOAD': 'cancel' }
    });
    assert.deepEqual(plan.ready.map(item => item.key), ['V1-LOAD', 'V1-CHECK', 'V2-LOAD']);
    assert.equal(plan.items.find(item => item.key === 'V1-CHECK').batch, 1);
    const result = await executePlan(board, plan);
    assert.equal(outcome(result, 'V1-LOAD').status, 'cancelled');
    assert.equal(outcome(result, 'V1-CHECK').status, 'blocked');
    assert.equal(outcome(result, 'V2-LOAD').status, 'committed');
    assert.equal(result.attribution['V1-LOAD'].pageLane, 'pending');
    assert.equal(result.attribution['V2-LOAD'].pageLane, 'team-b');
    const blocked = outcome(result, 'V1-CHECK').evidence;
    assert.deepEqual(blocked.dependencies.map(entry => entry.key), ['V1-LOAD']);
    const dialogStep = result.evidence.find(step => step.step === 'confirm-dialog');
    assert.equal(dialogStep.detail.message, '确认分派 V1-LOAD 到 team-b？');
  });
});

test('目标泳道折叠时先展开，展开后才执行真实拖放', async () => {
  await scenario(async board => {
    assert.equal((await board.lane('team-b')).collapsed, true);
    const plan = await previewPlan(board, { target: 'team-b', cards: [{ key: 'V1-LOAD' }] });
    const result = await executePlan(board, plan);
    assert.equal(outcome(result, 'V1-LOAD').status, 'committed');
    const expand = result.evidence.find(step => step.step === 'expand-target-lane');
    assert.equal(expand.detail.before.collapsed, true);
    assert.equal(expand.detail.after.collapsed, false);
    assert.equal((await board.lane('team-b')).collapsed, false);
  });
});

test('虚拟滚动泳道中的卡先滚动到真实可见位置再拖放', async () => {
  await scenario(async board => {
    const pending = await board.lane('pending');
    assert.equal(pending.virtual, true);
    assert.equal(pending.rendered <= 3, true);
    const plan = await previewPlan(board, { target: 'team-a', cards: [{ key: 'V5-LOAD' }] });
    const result = await executePlan(board, plan);
    const reveal = result.evidence.find(step => step.step === 'reveal-source-card');
    assert.equal(reveal.detail.virtual, true);
    assert.equal(reveal.detail.scanned > 1, true);
    assert.ok(reveal.detail.seen.includes('V5-LOAD'));
    assert.equal(outcome(result, 'V5-LOAD').status, 'committed');
    assert.equal(result.attribution['V5-LOAD'].pageLane, 'team-a');
  });
});

test('拖到虚拟占位区会被门户拒绝，计划记为冲突而不是成功', async () => {
  await scenario(async board => {
    const plan = await previewPlan(board, { target: 'team-a', cards: [{ key: 'V3-LOAD' }], zones: { 'V3-LOAD': 'placeholder' } });
    const result = await executePlan(board, plan);
    assert.equal(outcome(result, 'V3-LOAD').status, 'conflict');
    assert.equal(outcome(result, 'V3-LOAD').reason, 'placeholder');
    assert.equal(result.attribution['V3-LOAD'].pageLane, 'pending');
    const drag = result.evidence.find(step => step.step === 'drag');
    assert.equal(drag.detail.zone, 'placeholder');
  });
});

test('需要补选作业时段的卡必须选择时段后才被接受', async () => {
  await scenario(async board => {
    const withoutSlot = await previewPlan(board, { target: 'team-b', cards: [{ key: 'V6-LOAD' }] });
    assert.equal(withoutSlot.items[0].status, 'conflict');
    assert.equal(withoutSlot.items[0].reasons[0].code, 'slot-required');

    const plan = await previewPlan(board, { target: 'team-b', cards: [{ key: 'V6-LOAD' }, { key: 'V6-CHECK' }], slots: { 'V6-LOAD': '14:00-16:00' } });
    const result = await executePlan(board, plan);
    assert.equal(outcome(result, 'V6-LOAD').status, 'committed');
    assert.equal(outcome(result, 'V6-LOAD').slot, '14:00-16:00');
    assert.equal(outcome(result, 'V6-CHECK').status, 'committed');
    const slotStep = result.evidence.find(step => step.step === 'slot-select');
    assert.equal(slotStep.detail.selected.value, '14:00-16:00');
    assert.equal(result.attribution['V6-LOAD'].pageLane, 'team-b');
  });
});

test('预览与执行之间名额被占，溢出卡在落点被页面退回', async () => {
  await scenario(async board => {
    // team-b 容量 3，三张计划卡都排得下。
    const plan = await previewPlan(board, { target: 'team-b', cards: [{ key: 'V1-LOAD' }, { key: 'V2-LOAD' }, { key: 'V3-LOAD' }] });
    assert.deepEqual(plan.ready.map(item => item.key), ['V1-LOAD', 'V2-LOAD', 'V3-LOAD']);
    // 预览之后人工占用两个名额，只剩一个。
    await board.page.locator('[data-compete="team-b"]').click();
    await board.page.locator('[data-compete="team-b"]').click();
    const result = await executePlan(board, plan);
    assert.equal(outcome(result, 'V1-LOAD').status, 'committed');
    // 第二张在目标泳道已满，执行前的页面复核直接拒绝，不再拖放。
    assert.equal(outcome(result, 'V2-LOAD').status, 'conflict');
    assert.equal(outcome(result, 'V2-LOAD').reason, 'capacity');
    assert.equal(outcome(result, 'V3-LOAD').status, 'conflict');
    const laneChecks = result.evidence.filter(step => step.step === 'lane-check').map(step => step.detail.target);
    assert.ok(laneChecks.some(lane => Number(lane.count) >= Number(lane.capacity)));
    assert.equal(result.attribution['V2-LOAD'].pageLane, 'pending');
    assert.equal(result.attribution['V1-LOAD'].pageLane, 'team-b');
  });
});

test('执行前发现卡片已被人工派走到别处时跳过，不拉回', async () => {
  await scenario(async board => {
    const plan = await previewPlan(board, { target: 'team-b', cards: [{ key: 'V1-LOAD' }, { key: 'V2-LOAD' }] });
    // 人工把 V2-LOAD 拖到 team-a，并接受确认框。
    const dialog = board.confirmDialog('accept', 5000);
    await board.dragCardToLane({ key: 'V2-LOAD', from: 'pending', target: 'team-a' });
    assert.equal((await dialog).seen, true);
    await board.waitIdle();
    const result = await executePlan(board, plan);
    assert.equal(outcome(result, 'V2-LOAD').status, 'skipped-external');
    assert.equal(result.attribution['V2-LOAD'].pageLane, 'team-a');
    assert.equal(outcome(result, 'V1-LOAD').status, 'committed');
    const recheck = result.evidence.find(step => step.step === 'recheck-card' && step.detail.page?.key === 'V2-LOAD');
    assert.equal(recheck.detail.page.lane, 'team-a');
  });
});

test('版本变化时拒绝按过期计划拖放', async () => {
  await scenario(async board => {
    const plan = await previewPlan(board, { target: 'team-a', cards: [{ key: 'V1-LOAD' }] });
    // 页面已把该卡派到 team-b 并升版，计划中的版本过期，且已不处于待分派栏。
    await board.openLane('team-b');
    const dialog = board.confirmDialog('accept', 5000);
    await board.dragCardToLane({ key: 'V1-LOAD', from: 'pending', target: 'team-b' });
    assert.equal((await dialog).seen, true);
    await board.waitIdle();
    const located = await board.locateCard('V1-LOAD');
    assert.equal(located.card.lane, 'team-b');
    assert.equal(located.card.version, 2);
    const result = await executePlan(board, plan);
    assert.equal(outcome(result, 'V1-LOAD').status, 'skipped-external');
    assert.equal(result.attribution['V1-LOAD'].pageLane, 'team-b');
  });
});

test('恢复核对只读页面最终归属，人工改派的结果被保留', async () => {
  await scenario(async board => {
    const plan = await previewPlan(board, { target: 'team-a', cards: [{ key: 'V1-LOAD' }, { key: 'V2-LOAD' }] });
    const first = await executePlan(board, plan);
    assert.equal(first.attribution['V1-LOAD'].pageLane, 'team-a');
    // 分派后人工把 V2-LOAD 又拖到 team-b（team-b 初始折叠，先展开）。
    await board.openLane('team-b');
    const dialog = board.confirmDialog('accept', 5000);
    await board.dragCardToLane({ key: 'V2-LOAD', from: 'team-a', target: 'team-b' });
    assert.equal((await dialog).seen, true);
    await board.waitIdle();
    const recovered = await recoverPlan(board, plan, first);
    const report = Object.fromEntries(recovered.report.map(item => [item.key, item]));
    assert.equal(report['V1-LOAD'].note, 'confirmed-in-target');
    assert.equal(report['V2-LOAD'].note, 'moved-away-after-plan');
    assert.equal(report['V2-LOAD'].pageLane, 'team-b');
    assert.equal((await board.lane('team-a')).count, 1);
  });
});

test('状态栏解析区分接受、拒绝、占位与取消', () => {
  assert.equal(parseStatus('{"key":"K","state":"accepted"}').state, 'accepted');
  assert.equal(parseStatus('{"key":"K","state":"rejected","reason":"capacity"}').reason, 'capacity');
  assert.equal(parseStatus('{"key":"K","state":"invalid-drop"}').state, 'invalid-drop');
  assert.equal(parseStatus('已取消').state, 'cancelled');
  assert.equal(parseStatus('').state, 'none');
});
