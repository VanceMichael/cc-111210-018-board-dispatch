#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { BoardPage } from '../src/board.mjs';
import { previewPlan, executePlan, recoverPlan } from '../src/dispatch.mjs';
import { startFixture } from '../fixtures/source.mjs';

const USAGE = `用法：
  node scripts/dispatch.mjs preview <plan.json> [--source URL]
  node scripts/dispatch.mjs run     <plan.json> [--source URL]
  node scripts/dispatch.mjs recover <plan.json> [--source URL] [--previous state.json]

计划格式：
  {
    "target": "team-a",
    "cards": [{"key": "V1-LOAD", "voyage": "V1"}],
    "slots": {"V6-LOAD": "14:00-16:00"},
    "confirm": {"V1-LOAD": "cancel"},
    "zones": {"V3-LOAD": "placeholder"}
  }

未指定 --source 时启动本地演练来源，命令结束自动关闭。浏览器只连接回环地址。`;

function parseArguments(argv) {
  const [mode, planFile, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index].startsWith('--')) throw new Error(`未知参数：${rest[index]}`);
    options[rest[index].slice(2)] = rest[index + 1];
  }
  return { mode, planFile, options };
}

const { mode, planFile, options } = parseArguments(process.argv.slice(2));
if (!['preview', 'run', 'recover'].includes(mode) || !planFile) {
  console.error(USAGE);
  process.exit(2);
}

let request;
try {
  request = JSON.parse(await readFile(planFile, 'utf8'));
} catch (error) {
  console.error(`计划读取失败：${error.message}`);
  process.exit(2);
}

const source = options.source ? { url: options.source, close: async () => {} } : await startFixture();
const board = await BoardPage.open(source.url);
let exitCode = 0;
try {
  if (mode === 'preview') {
    const plan = await previewPlan(board, request);
    print({ target: plan.target, targetLaneBefore: plan.targetLaneBefore, items: plan.items.map(summary), batches: plan.batches, evidence: plan.readEvidence });
  } else if (mode === 'run') {
    const plan = await previewPlan(board, request);
    const result = await executePlan(board, plan);
    print({
      target: result.target,
      outcomes: result.outcomes.map(item => ({ key: item.key, status: item.status, reason: item.reason ?? null, slot: item.slot ?? null })),
      attribution: result.attribution,
      finalSnapshot: result.finalSnapshot,
      evidence: result.evidence,
      previewConflicts: plan.conflicts.map(summary)
    });
    if (result.outcomes.some(item => ['failed', 'conflict'].includes(item.status))) exitCode = 1;
  } else {
    const previous = options.previous ? JSON.parse(await readFile(options.previous, 'utf8')) : null;
    const plan = await previewPlan(board, request);
    const recovered = await recoverPlan(board, plan, previous);
    print({ target: recovered.target, report: recovered.report, lanes: recovered.lanes, evidence: recovered.evidence });
  }
} catch (error) {
  console.error(JSON.stringify({ error: error.message, evidence: error.evidence ?? null }, null, 2));
  exitCode = 1;
} finally {
  await board.close();
  await source.close();
}
process.exit(exitCode);

function summary(item) {
  return {
    key: item.key,
    title: item.title,
    voyage: item.voyage,
    pageVoyage: item.pageVoyage,
    lane: item.pageLane,
    version: item.version,
    status: item.status,
    batch: item.batch,
    dependencies: item.dependencies,
    reasons: item.reasons
  };
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}
