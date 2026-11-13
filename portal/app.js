/* 本地演练门户：只实现页面自身的正常拖放、确认、折叠与虚拟列表行为。
   automation 不得直接改写 window 状态，也不得调用 /state 代替界面操作。 */
const INITIAL_CARDS = [
  { key: 'V1-LOAD', title: '装卸', voyage: 'V1', lane: 'pending', version: 1, depends: null, requiresSlot: false },
  { key: 'V1-CHECK', title: '查验', voyage: 'V1', lane: 'pending', version: 1, depends: 'V1-LOAD', requiresSlot: false },
  { key: 'V2-LOAD', title: '装卸', voyage: 'V2', lane: 'pending', version: 1, depends: null, requiresSlot: false },
  { key: 'V2-CHECK', title: '查验', voyage: 'V2', lane: 'pending', version: 1, depends: 'V2-LOAD', requiresSlot: false },
  { key: 'V3-LOAD', title: '装卸', voyage: 'V3', lane: 'pending', version: 1, depends: null, requiresSlot: false },
  { key: 'V4-LOAD', title: '装卸', voyage: 'V4', lane: 'pending', version: 1, depends: null, requiresSlot: false },
  { key: 'V5-LOAD', title: '装卸', voyage: 'V5', lane: 'pending', version: 1, depends: null, requiresSlot: false },
  { key: 'V6-LOAD', title: '装卸', voyage: 'V6', lane: 'pending', version: 1, depends: null, requiresSlot: true },
  { key: 'V6-CHECK', title: '查验', voyage: 'V6', lane: 'pending', version: 1, depends: 'V6-LOAD', requiresSlot: false }
];
const LANES = ['pending', 'team-a', 'team-b'];
const VIRTUAL_LIMIT = 5;
const ROW_HEIGHT = 64;
const VISIBLE_ROWS = 3;
const SLOTS = ['08:00-10:00', '14:00-16:00', '20:00-22:00'];

let state = {
  cards: INITIAL_CARDS.map(card => ({ ...card })),
  capacity: { 'team-a': 2, 'team-b': 3 },
  collapsed: { 'team-a': false, 'team-b': true },
  scroll: { pending: 0, 'team-a': 0, 'team-b': 0 }
};
let dragging = null;
let pendingDrop = null;
let refreshGuard = false;
let saving = Promise.resolve();
let saveGeneration = 0;

function cardsIn(lane) { return state.cards.filter(card => card.lane === lane); }
function isVirtual(lane) { return cardsIn(lane).length > VIRTUAL_LIMIT; }
function setStatus(value) { document.querySelector('#status').textContent = value; }
function escapeAttribute(value) { return String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;'); }

function cardHtml(card) {
  return `<article class="card" draggable="true" data-card data-key="${escapeAttribute(card.key)}" data-version="${card.version}" data-voyage="${escapeAttribute(card.voyage)}" data-title="${escapeAttribute(card.title)}" data-depends="${escapeAttribute(card.depends ?? '')}" data-requires-slot="${card.requiresSlot}">${card.title} ${card.voyage} · v${card.version}</article>`;
}

function renderList(lane) {
  const list = cardsIn(lane);
  if (!isVirtual(lane)) return list.map(cardHtml).join('');
  const maxStart = Math.max(0, list.length - VISIBLE_ROWS);
  const start = Math.min(maxStart, Math.floor((state.scroll[lane] || 0) / ROW_HEIGHT));
  const shown = list.slice(start, start + VISIBLE_ROWS);
  const above = start * ROW_HEIGHT;
  const below = Math.max(0, (list.length - start - shown.length) * ROW_HEIGHT);
  const top = above ? `<div class="list-spacer" data-placeholder style="height:${above}px">虚拟占位（非接收区）</div>` : '';
  const bottom = below ? `<div class="list-spacer" data-placeholder style="height:${below}px">虚拟占位（非接收区）</div>` : '';
  return top + shown.map(cardHtml).join('') + bottom;
}

function render() {
  const lanes = LANES.map(lane => {
    const collapsed = lane === 'pending' ? false : Boolean(state.collapsed[lane]);
    const capacity = lane === 'pending' ? '∞' : state.capacity[lane];
    const list = cardsIn(lane);
    return `<section class="lane" data-lane="${lane}" data-capacity="${capacity}" data-count="${list.length}" data-collapsed="${collapsed}" data-virtual="${isVirtual(lane)}">
      <header><h2>${lane}</h2>
        <button type="button" data-collapse="${lane}">${collapsed ? '展开' : '折叠'}</button>
        <button type="button" data-compete="${lane}">占用一个名额</button>
      </header>
      <div class="lane-body"${collapsed ? ' hidden' : ''}>
        ${collapsed ? '<p class="folded">泳道已折叠</p>' : `<div class="lane-list" data-list="${lane}">${renderList(lane)}</div>
        <div class="lane-spacer" data-placeholder>虚拟占位（拖到此处不会被接受）</div>
        <div class="accept-zone" data-accept-zone>拖放至此区域</div>`}
      </div>
    </section>`;
  }).join('');
  document.querySelector('#app').innerHTML = `<h1>作业看板</h1><p>重名卡按航次区分；折叠泳道、虚拟滚动与占位区都需按页面实际结果核对。</p><p>每个泳道名额：${state.capacity['team-a']} / ${state.capacity['team-b']}</p>` + lanes;
  // 虚拟列表按保存的偏移重建窗口；重建后必须把真实滚动位置放回去，否则卡片在
  // DOM 里却位于列表可视区外，用户无法拖动、也无法看到。
  for (const list of document.querySelectorAll('[data-list]')) {
    const lane = list.dataset.list;
    const offset = state.scroll[lane] || 0;
    if (offset && isVirtual(lane)) list.scrollTop = offset;
  }
  bindLanes();
  persist();
}

function bindStatic() {
  const app = document.querySelector('#app');
  app.addEventListener('dragstart', event => {
    const card = event.target.closest('[data-card]');
    if (!card) return;
    dragging = card.dataset.key;
    event.dataTransfer.setData('text/plain', dragging);
    event.dataTransfer.effectAllowed = 'move';
  });
  app.addEventListener('click', event => {
    const collapse = event.target.closest('[data-collapse]');
    if (collapse) {
      const lane = collapse.dataset.collapse;
      state.collapsed[lane] = !state.collapsed[lane];
      render();
      return;
    }
    const compete = event.target.closest('[data-compete]');
    if (compete) {
      const lane = compete.dataset.compete;
      if (lane === 'pending') return;
      state.capacity[lane] = Math.max(0, state.capacity[lane] - 1);
      render();
    }
  });
}

function bindLanes() {
  for (const lane of document.querySelectorAll('[data-lane]')) {
    lane.addEventListener('dragover', event => event.preventDefault());
    lane.addEventListener('drop', event => {
      event.preventDefault();
      const targetLane = lane.dataset.lane;
      const placeholder = event.target.closest('[data-placeholder]');
      const key = event.dataTransfer.getData('text/plain') || dragging;
      if (placeholder) {
        setStatus(JSON.stringify({ key, state: 'invalid-drop', reason: 'placeholder', message: '占位区不是作业卡归属，服务器未接受' }));
        return;
      }
      if (lane.dataset.collapsed === 'true') {
        setStatus(JSON.stringify({ key, state: 'rejected', reason: 'collapsed', message: '目标泳道已折叠，请先展开' }));
        return;
      }
      if (targetLane === 'pending') {
        setStatus(JSON.stringify({ key, state: 'rejected', reason: 'pending-target', message: '待分派栏不是分派目标' }));
        return;
      }
      handleDrop(key, targetLane);
    });
  }
  for (const list of document.querySelectorAll('[data-list]')) {
    const lane = list.dataset.list;
    list.addEventListener('scroll', () => {
      state.scroll[lane] = list.scrollTop;
      if (refreshGuard) return;
      refreshGuard = true;
      const top = list.scrollTop;
      list.innerHTML = renderList(lane);
      list.scrollTop = top;
      refreshGuard = false;
    });
  }
}

function handleDrop(key, lane) {
  const card = state.cards.find(item => item.key === key);
  if (!card) { setStatus(JSON.stringify({ key, state: 'rejected', reason: 'unknown-card' })); return; }
  if (cardsIn(lane).length >= state.capacity[lane]) {
    setStatus(JSON.stringify({ key, state: 'rejected', reason: 'capacity', message: '容量变化，分派未接受' }));
    return;
  }
  if (card.depends) {
    const prerequisite = state.cards.find(item => item.key === card.depends);
    if (!prerequisite || prerequisite.lane === 'pending') {
      setStatus(JSON.stringify({ key, state: 'blocked', reason: 'prerequisite', message: '前置作业未完成' }));
      return;
    }
  }
  pendingDrop = { key, lane };
  if (!window.confirm('确认分派 ' + key + ' 到 ' + lane + '？')) {
    pendingDrop = null;
    setStatus('已取消');
    return;
  }
  if (card.requiresSlot) {
    setStatus(JSON.stringify({ key, to: lane, state: 'needs-slot', reason: 'slot', message: '需要补选作业时段' }));
    openSlotDialog(key, lane);
    return;
  }
  applyDispatch(key, lane);
}

function openSlotDialog(key, lane) {
  const app = document.querySelector('#app');
  const box = document.createElement('div');
  box.id = 'slot-dialog';
  box.setAttribute('data-slot-dialog', '');
  box.setAttribute('role', 'dialog');
  box.innerHTML = `<p>请补充 ${escapeAttribute(key)} 到 ${escapeAttribute(lane)} 的作业时段</p>
    <select data-slot-select><option value="">请选择作业时段</option>${SLOTS.map(slot => `<option value="${slot}">${slot}</option>`).join('')}</select>
    <p data-slot-error></p>
    <button type="button" data-slot-cancel>取消</button>
    <button type="button" data-slot-confirm>确认</button>`;
  app.appendChild(box);
  box.querySelector('[data-slot-cancel]').onclick = () => { box.remove(); pendingDrop = null; setStatus('已取消'); };
  box.querySelector('[data-slot-confirm]').onclick = () => {
    const slot = box.querySelector('[data-slot-select]').value;
    if (!slot) { box.querySelector('[data-slot-error]').textContent = '需要补选作业时段'; return; }
    box.remove();
    applyDispatch(key, lane, { slot });
  };
}

function applyDispatch(key, lane, extra = {}) {
  const card = state.cards.find(item => item.key === key);
  const from = card.lane;
  card.lane = lane;
  card.version += 1;
  pendingDrop = null;
  const version = card.version;
  render();
  setStatus(JSON.stringify({ key, from, to: lane, state: 'accepted', version, ...extra }));
}

function persist() {
  const generation = ++saveGeneration;
  const payload = JSON.stringify({ cards: state.cards, capacity: state.capacity });
  const app = document.querySelector('#app');
  app.dataset.saved = 'false';
  saving = saving
    .then(() => fetch('/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }))
    .then(response => {
      if (!response.ok) throw Error('门户保存失败');
      if (generation === saveGeneration) app.dataset.saved = 'true';
    })
    .catch(error => { setStatus(error.message); });
}

async function boot() {
  const app = document.querySelector('#app');
  app.dataset.saved = 'false';
  bindStatic();
  const saved = await (await fetch('/state')).json();
  if (saved?.cards) {
    state.cards = saved.cards.map(card => ({ ...card, requiresSlot: Boolean(card.requiresSlot) }));
    if (typeof saved.capacity === 'number') state.capacity = { 'team-a': saved.capacity, 'team-b': saved.capacity };
    else if (saved.capacity) state.capacity = { ...state.capacity, ...saved.capacity };
  }
  render();
  app.dataset.ready = 'true';
}

boot();
