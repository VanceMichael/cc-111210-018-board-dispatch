import { createServer } from 'node:http';

const STYLE = `
body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#f6f7f9;color:#20242a}
h1{margin:0 0 4px}h2{font-size:18px;margin:24px 0 8px}
.muted{color:#5a6472;font-size:13px}
.board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-top:16px}
.lane{background:#fff;border:1px solid #ccd2da;border-radius:8px;padding:10px;min-height:120px}
.lane header{font-weight:600;font-size:14px;margin-bottom:8px;display:flex;gap:8px;align-items:center}
.tag{font-weight:400;color:#5a6472;font-size:12px}
.card{border:1px solid #c6cdd6;border-left-width:4px;border-radius:6px;padding:8px;margin-bottom:8px;background:#fbfcfd;font-size:13px}
.card .key{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.card .title{font-weight:600}
.st-ready{border-left-color:#2f7d4d}.st-conflict{border-left-color:#b46a10}.st-already{border-left-color:#3568a8}
.st-committed{border-left-color:#2f7d4d}.st-cancelled{border-left-color:#8a5aa8}.st-blocked{border-left-color:#a83a3a}
.st-failed{border-left-color:#a83a3a}.st-skipped-external{border-left-color:#3568a8}
table{border-collapse:collapse;width:100%;background:#fff;font-size:13px}
th,td{border:1px solid #d4d9e0;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#eceff3;font-weight:600}
code{font-family:ui-monospace,Menlo,monospace;font-size:12px;background:#eceff3;padding:1px 4px;border-radius:3px}
details{background:#fff;border:1px solid #d4d9e0;border-radius:8px;padding:10px;margin-top:10px}
details pre{white-space:pre-wrap;font-size:12px;margin:8px 0 0}
.verdict-ok{color:#22623b}.verdict-bad{color:#8d2f2f}.verdict-warn{color:#8a5a10}
`;

const SCENARIOS = [
  {
    id: 'duplicate-titles',
    label: '重名卡按业务键区分',
    intro: 'V1-LOAD 与 V2-LOAD 标题同为“装卸”，只拖计划中指定的那一个。',
    plan: { target: 'team-b', cards: [{ key: 'V1-LOAD', voyage: 'V1' }, { key: 'V2-LOAD', voyage: 'V2' }, { key: 'V1-CHECK' }] },
    setup: '先展开 team-b'
  },
  {
    id: 'capacity-race',
    label: '容量竞争',
    intro: '计划三张卡，预览后人工占用两个名额，执行时按页面实际名额退回。',
    plan: { target: 'team-b', cards: [{ key: 'V1-LOAD' }, { key: 'V2-LOAD' }, { key: 'V3-LOAD' }] },
    human: 'preview:after:experiment',
    occupy: 2
  },
  {
    id: 'confirm-cancel',
    label: '确认框取消',
    intro: 'V1-LOAD 的确认框被取消；依赖它的 V1-CHECK 不得越过它继续。',
    plan: { target: 'team-b', cards: [{ key: 'V1-LOAD' }, { key: 'V1-CHECK' }, { key: 'V2-LOAD' }], confirm: { 'V1-LOAD': 'cancel' } }
  },
  {
    id: 'prerequisite-failure',
    label: '前置作业失败后的依赖阻断',
    intro: '前置卡拖到占位区被门户退回，后继卡应被阻断而不是继续。',
    plan: { target: 'team-b', cards: [{ key: 'V1-LOAD' }, { key: 'V1-CHECK' }], zones: { 'V1-LOAD': 'placeholder' } }
  },
  {
    id: 'slot-and-virtual',
    label: '虚拟滚动与补选时段',
    intro: 'V6-LOAD 位于待分派虚拟列表末屏，且页面要求补选作业时段。',
    plan: { target: 'team-b', cards: [{ key: 'V6-LOAD' }, { key: 'V6-CHECK' }], slots: { 'V6-LOAD': '14:00-16:00' } }
  }
];

function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function lanesFor(view) {
  const lanes = ['pending', 'team-a', 'team-b'];
  const cards = view?.snapshot?.cards ?? [];
  return lanes.map(lane => {
    const info = view?.snapshot?.lanes?.[lane] ?? {};
    return {
      lane,
      collapsed: Boolean(info.collapsed),
      capacity: info.capacityLabel ?? info.capacity ?? '∞',
      cards: cards.filter(card => card.lane === lane)
    };
  });
}

function cardClass(card, view) {
  const status = view?.plan?.items?.find(item => item.key === card.key)?.status
    ?? view?.result?.outcomes?.find(item => item.key === card.key)?.status
    ?? 'ready';
  return `card st-${escapeHtml(status)}`;
}

function measure(view) {
  return view?.plan?.targetLaneBefore ? `现有 ${view.plan.targetLaneBefore.count} / 容量 ${view.plan.targetLaneBefore.capacity}` : '';
}

function verdictClass(verdict) {
  if (['confirmed-in-target', 'in-target-not-by-this-run'].includes(verdict)) return 'verdict-ok';
  if (['moved-after-commit', 'rolled-back-or-moved'].includes(verdict)) return 'verdict-warn';
  return 'verdict-bad';
}

function planRows(view) {
  const plan = view?.plan;
  if (!plan) return '<p class="muted">尚无计划。</p>';
  return `<table><thead><tr><th>业务键</th><th>标题</th><th>航次</th><th>页面归属</th><th>版本</th><th>批次</th><th>预览状态</th><th>原因</th></tr></thead><tbody>${
    plan.items.map(item => `<tr>
      <td class="key">${escapeHtml(item.key)}</td>
      <td>${escapeHtml(item.title)}</td>
      <td>${escapeHtml(item.voyage)}</td>
      <td>${escapeHtml(item.pageLane)}</td>
      <td>${escapeHtml(item.version)}</td>
      <td>${escapeHtml(item.batch)}</td>
      <td>${escapeHtml(item.status)}</td>
      <td>${escapeHtml(item.reasons.map(reason => reason.code).join(', ') || '—')}</td>
    </tr>`).join('')
  }</tbody></table>`;
}

function outcomeRows(view) {
  const result = view?.result;
  if (!result) return '';
  return `<h2>执行结果（以页面最终归属为准）</h2>
  <table><thead><tr><th>业务键</th><th>动作结果</th><th>原因</th><th>页面归属</th><th>页面版本</th><th>判定</th></tr></thead><tbody>${
    Object.entries(result.attribution).map(([key, value]) => `<tr>
      <td class="key">${escapeHtml(key)}</td>
      <td>${escapeHtml(value.outcome)}</td>
      <td>${escapeHtml(result.outcomes.find(item => item.key === key)?.reason ?? '—')}</td>
      <td>${escapeHtml(value.pageLane ?? '缺失')}</td>
      <td>${escapeHtml(value.version ?? '—')}</td>
      <td class="${verdictClass(value.verdict)}">${escapeHtml(value.verdict)}</td>
    </tr>`).join('')
  }</tbody></table>`;
}

function evidenceBlock(view) {
  const steps = view?.result?.evidence ?? view?.plan?.readEvidence;
  if (!steps) return '';
  return `<h2>页面证据（每次动作）</h2>
  <table><thead><tr><th>#</th><th>动作</th><th>依据</th></tr></thead><tbody>${
    steps.map((step, index) => `<tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(step.step)}</td>
      <td><details><summary>展开</summary><pre>${escapeHtml(JSON.stringify(step.detail, null, 2))}</pre></details></td>
    </tr>`).join('')
  }</tbody></table>`;
}

function boardHtml(view) {
  const measurement = measure(view);
  return `<div class="board">${lanesFor(view).map(lane => `<section class="lane">
    <header>${escapeHtml(lane.lane)} <span class="tag">${lane.collapsed ? '折叠' : `${lane.cards.length} 张`} · 名额 ${escapeHtml(lane.capacity)}</span></header>
    ${lane.cards.map(card => `<article class="${cardClass(card, view)}">
      <div class="title">${escapeHtml(card.title)} <span class="tag">${escapeHtml(card.voyage)}</span></div>
      <div class="key">${escapeHtml(card.key)} · v${escapeHtml(card.version)}${card.requiresSlot ? ' · 需时段' : ''}</div>
    </article>`).join('') || '<p class="muted">（空）</p>'}
  </section>`).join('')}</div>${measurement ? `<p class="muted">目标泳道（预览时）：${escapeHtml(measurement)}</p>` : ''}`;
}

function renderScenario(scenario, view) {
  return `<article class="scenario" id="scenario-${escapeHtml(scenario.id)}">
    <h2>${escapeHtml(scenario.label)}</h2>
    <p class="muted">${escapeHtml(scenario.intro)}</p>
    ${scenario.human ? `<p class="muted">人工动作：预览后占用 ${scenario.occupy} 个名额（模拟其他班组抢先分派）。</p>` : ''}
    ${view?.error ? `<p class="verdict-bad">运行失败：${escapeHtml(view.error)}</p>` : ''}
    ${boardHtml(view)}
    ${planRows(view)}
    ${outcomeRows(view)}
    ${evidenceBlock(view)}
  </article>`;
}

export async function startBoard({ dataProvider, port = 0 }) {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/local-board') {
      const values = await dataProvider();
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>分派演练看板</title><style>${STYLE}</style>
        <h1>分派演练看板</h1><p class="muted">重名卡、容量竞争、确认取消、前置失败与补选时段在本页展示；所有结果都读自演练门户的页面最终归属。</p>
        ${SCENARIOS.map(scenario => renderScenario(scenario, values.scenarios?.[scenario.id]?.view)).join('')}
      </html>`);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: '页面不存在' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { url: `http://127.0.0.1:${server.address().port}/local-board`, scenarios: SCENARIOS, close: () => new Promise(resolve => { server.close(() => resolve()); server.closeIdleConnections(); }) };
}
