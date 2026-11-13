import { writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BoardPage } from './board.mjs';
import { previewPlan, executePlan, recoverPlan } from './dispatch.mjs';
import { startFixture } from '../fixtures/source.mjs';
import { startBoard } from './report.mjs';

const OCCUPY = 2;

async function runScenario(source, scenario) {
  const board = await BoardPage.open(source.url);
  try {
    const plan = await previewPlan(board, scenario.plan);
    if (scenario.id === 'capacity-race') {
      for (let index = 0; index < OCCUPY; index++) {
        await board.laneLocator(plan.target).locator(`[data-compete=${JSON.stringify(plan.target)}]`).click();
      }
    }
    const result = await executePlan(board, plan);
    const recovered = await recoverPlan(board, plan, result);
    return {
      plan: { target: plan.target, targetLaneBefore: plan.targetLaneBefore, items: plan.items, batches: plan.batches, conflicts: plan.conflicts, readEvidence: plan.readEvidence },
      result,
      recovered,
      snapshot: result.finalSnapshot
    };
  } finally {
    await board.close();
  }
}

async function runAll() {
  const directory = await mkdtemp(join(tmpdir(), 'dispatch-demo-'));
  const scenarios = {};
  const state = {};
  const boardHost = await startBoard({ dataProvider: async () => ({ scenarios: state }) });
  try {
    for (const scenario of boardHost.scenarios) {
      // 每个场景使用全新的演练来源，避免前一个场景的分派结果污染后一个场景。
      const source = await startFixture();
      scenarios[scenario.id] = {
        id: scenario.id,
        label: scenario.label,
        intro: scenario.intro,
        plan: scenario.plan,
        occupy: scenario.occupy,
        human: scenario.human
      };
      try {
        scenarios[scenario.id].view = await runScenario(source, scenario);
      } catch (error) {
        scenarios[scenario.id].view = { error: error.message };
      } finally {
        await source.close();
      }
      state[scenario.id] = scenarios[scenario.id];
    }
    const output = join(process.env.REPORT_DIR ?? directory, 'dispatch-report.json');
    await mkdir(dirname(output), { recursive: true }).catch(() => {});
    const report = { board: boardHost.url, scenarios };
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ board: boardHost.url, report: output, scenarios: Object.fromEntries(Object.entries(scenarios).map(([id, value]) => [id, value.view?.error ? { error: value.view.error } : { outcomes: value.view.result.outcomes.map(item => ({ key: item.key, status: item.status, reason: item.reason ?? null })) }])) }, null, 2));
    console.log('演练看板已启动，按 Ctrl+C 结束。');
    await new Promise(resolve => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await boardHost.close();
  } finally {
    await boardHost.close().catch(() => {});
    if (!process.env.REPORT_DIR) await rm(directory, { recursive: true, force: true });
  }
}

runAll().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
