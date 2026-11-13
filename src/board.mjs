import { openBrowser } from './browser.mjs';

export class BoardError extends Error {
  constructor(message, evidence) {
    super(message);
    this.name = 'BoardError';
    this.evidence = evidence;
  }
}

const CARD_FIELDS = elements => elements.map(element => ({
  key: element.dataset.key,
  title: element.dataset.title ?? element.textContent.trim(),
  voyage: element.dataset.voyage,
  version: Number(element.dataset.version),
  depends: element.dataset.depends || null,
  requiresSlot: element.dataset.requiresSlot === 'true',
  lane: element.closest('[data-lane]')?.dataset.lane ?? null,
  text: element.textContent.trim()
}));

const STEP_WAIT = 120;

function attributes(element) {
  return {
    key: element.dataset.key,
    title: element.dataset.title ?? element.textContent.trim(),
    voyage: element.dataset.voyage,
    version: Number(element.dataset.version),
    depends: element.dataset.depends || null,
    requiresSlot: element.dataset.requiresSlot === 'true',
    lane: element.closest('[data-lane]')?.dataset.lane ?? null,
    text: element.textContent.trim()
  };
}

const jsonSelector = value => JSON.stringify(String(value));

/**
 * 门户页面适配层。只读取页面公开展示的卡片和泳道属性；所有变更都通过用户
 * 可执行的界面动作完成：点击展开、滚轮滚动虚拟列表、HTML5 拖放、浏览器
 * 确认框、时段下拉与确认。不调用 /state，也不改写页面内数据。
 */
export class BoardPage {
  static async open(base, options = {}) {
    const session = await openBrowser(base);
    return new BoardPage(session, options);
  }

  constructor(session, { settleTimeout = 3000, saveTimeout = 15000 } = {}) {
    this.session = session;
    this.page = session.page;
    this.settleTimeout = settleTimeout;
    this.saveTimeout = saveTimeout;
    this.rowHeight = 64;
    this.steps = [];
  }

  async close() { await this.session.close(); }

  mark() { return this.steps.length; }

  evidence(step, detail) {
    const entry = { step, detail, at: new Date().toISOString() };
    this.steps.push(entry);
    return entry;
  }

  evidenceSince(mark) { return this.steps.slice(mark); }

  laneLocator(lane) { return this.page.locator(`[data-lane=${jsonSelector(lane)}]`); }

  listLocator(lane) { return this.laneLocator(lane).locator('[data-list]'); }

  cardLocator(lane, key) { return this.laneLocator(lane).locator(`[data-card][data-key=${jsonSelector(key)}]`); }

  async lane(lane) {
    const element = this.laneLocator(lane);
    if (await element.count() === 0) throw new BoardError(`泳道不存在：${lane}`);
    const rawCapacity = await element.getAttribute('data-capacity');
    return {
      lane,
      collapsed: await element.getAttribute('data-collapsed') === 'true',
      virtual: await element.getAttribute('data-virtual') === 'true',
      capacity: rawCapacity === '∞' ? Infinity : Number(rawCapacity),
      capacityLabel: rawCapacity,
      count: Number(await element.getAttribute('data-count')),
      rendered: await element.locator('[data-card]').count()
    };
  }

  async laneNames() {
    return this.page.locator('[data-lane]').evaluateAll(elements => elements.map(element => element.dataset.lane));
  }

  renderedCard(lane, key) { return this.cardLocator(lane, key).evaluate(attributes); }

  /** 页面当前渲染出的卡片（不含虚拟窗口外的卡片）。 */
  async renderedCards() {
    const cards = [];
    for (const lane of await this.laneNames()) {
      cards.push(...await this.laneLocator(lane).locator('[data-card]').evaluateAll(CARD_FIELDS));
    }
    return cards;
  }

  async statusText() { return (await this.page.locator('#status').textContent()) ?? ''; }

  async savedMarker() { return this.page.locator('#app').getAttribute('data-saved'); }

  /** 展开折叠泳道；以页面折叠状态是否真的改变作为成功依据。 */
  async openLane(lane) {
    const before = await this.lane(lane);
    if (!before.collapsed) return { changed: false, before, after: before };
    await this.laneLocator(lane).locator(`[data-collapse=${jsonSelector(lane)}]`).click({ timeout: 5000 });
    const after = await this.waitLaneFlag(lane, 'collapsed', 'false');
    return { changed: !after.collapsed, before, after };
  }

  async collapseLane(lane) {
    const before = await this.lane(lane);
    if (before.collapsed) return { changed: false, before, after: before };
    await this.laneLocator(lane).locator(`[data-collapse=${jsonSelector(lane)}]`).click({ timeout: 5000 });
    const after = await this.waitLaneFlag(lane, 'collapsed', 'true');
    return { changed: after.collapsed, before, after };
  }

  /** 轮询页面属性，返回页面上观测到的最终值（不做页面内等待或断言）。 */
  async waitLaneFlag(lane, flag, expected) {
    let value = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      value = await this.laneLocator(lane).getAttribute(`data-${flag}`);
      if (value === expected) break;
      await this.page.waitForTimeout(100);
    }
    return this.lane(lane);
  }

  /** 用真实滚轮事件把虚拟列表滚到顶部，等待页面自身的滚动渲染完成。 */
  async scrollListToTop(lane) {
    const list = this.listLocator(lane);
    await list.hover();
    await this.page.mouse.wheel(0, -20000);
    await this.page.waitForTimeout(STEP_WAIT);
    return list.evaluate(element => element.scrollTop);
  }

  /** 卡片是否真的处在虚拟列表的可视裁剪区内（DOM 存在不等于可见）。 */
  async cardVisibleInList(lane, key) {
    const list = this.listLocator(lane);
    if (await list.count() === 0) return false;
    const card = this.cardLocator(lane, key);
    if (await card.count() === 0) return false;
    const listBox = await list.boundingBox();
    const cardBox = await card.boundingBox();
    if (!listBox || !cardBox) return false;
    return cardBox.y >= listBox.y - 2 && cardBox.y + cardBox.height <= listBox.y + listBox.height + 2;
  }

  /** 滚动虚拟列表直到目标卡进入渲染窗口且真正可见；返回该卡页面属性与滚动证据。 */
  async revealCard(lane, key) {
    const info = await this.lane(lane);
    if (info.collapsed) throw new BoardError(`泳道 ${lane} 已折叠，无法看到卡片 ${key}`, { lane, info });
    if (!info.virtual) {
      if (await this.cardLocator(lane, key).count() === 0) throw new BoardError(`泳道 ${lane} 中找不到卡片 ${key}`, { lane, key });
      return { key, lane, card: await this.renderedCard(lane, key), scanned: 1, seen: [key], scroll: null, reshown: false };
    }
    const list = this.listLocator(lane);
    const seen = new Map();
    const scans = [];
    let reshown = false;
    // 页面整体重渲染后，虚拟窗口可能仍停在旧偏移而列表 scrollTop 已归零，
    // 此时 DOM 里有卡却不可见；先回到顶部，再逐屏滚到真正可见。
    if (await this.cardLocator(lane, key).count() > 0 && !await this.cardVisibleInList(lane, key)) reshown = true;
    await this.scrollListToTop(lane);
    for (let step = 0; step < 80; step++) {
      const values = await list.locator('[data-card]').evaluateAll(CARD_FIELDS);
      for (const value of values) seen.set(value.key, value);
      const visible = await this.cardVisibleInList(lane, key);
      if (seen.has(key) && visible) {
        return { key, lane, card: await this.renderedCard(lane, key), scanned: step + 1, seen: [...seen.keys()], scans, reshown };
      }
      const state = await list.evaluate(element => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }));
      scans.push(state);
      if (state.top >= state.max - 1) break;
      await this.page.mouse.wheel(0, this.rowHeight);
      await this.page.waitForTimeout(STEP_WAIT);
      const next = await list.evaluate(element => element.scrollTop);
      if (next <= state.top) break;
    }
    throw new BoardError(`虚拟列表滚动后仍未出现可见的卡片 ${key}`, { lane, key, scans, seen: [...seen.keys()] });
  }

  /**
   * 清点一个泳道。虚拟泳道逐屏滚动收集，结束后回到顶部。
   * 折叠泳道会临时展开读取页面、随后恢复折叠；临时展开属于界面读取动作。
   */
  async scanLane(lane) {
    let info = await this.lane(lane);
    let temporarilyExpanded = false;
    if (info.collapsed) {
      const expanded = await this.openLane(lane);
      this.evidence('expand-lane-for-read', { lane, before: expanded.before, after: expanded.after });
      temporarilyExpanded = true;
      info = await this.lane(lane);
    }
    const list = info.virtual ? this.listLocator(lane) : null;
    const seen = new Map();
    const scrolls = [];
    if (list) await this.scrollListToTop(lane);
    for (let step = 0; step < 80; step++) {
      const values = await this.laneLocator(lane).locator('[data-card]').evaluateAll(CARD_FIELDS);
      for (const value of values) seen.set(value.key, value);
      if (!list) break;
      const state = await list.evaluate(element => ({ top: element.scrollTop, max: element.scrollHeight - element.clientHeight }));
      scrolls.push(state);
      if (state.top >= state.max - 1) break;
      await this.page.mouse.wheel(0, this.rowHeight * 2);
      await this.page.waitForTimeout(STEP_WAIT);
      const next = await list.evaluate(element => element.scrollTop);
      if (next <= state.top) break;
    }
    if (list) await this.scrollListToTop(lane);
    if (temporarilyExpanded) {
      const restored = await this.collapseLane(lane);
      this.evidence('collapse-lane-restored', { lane, after: restored.after });
    }
    const finalInfo = await this.lane(lane);
    return { lane, collapsed: finalInfo.collapsed, virtual: info.virtual, capacity: info.capacity, cards: [...seen.values()], scrolls, steps: scrolls.length };
  }

  /** 完整看板快照：泳道状态 + 所有能通过页面读到的卡片（含虚拟滚动与临时展开）。 */
  async snapshot() {
    await this.waitIdle();
    const laneNames = await this.laneNames();
    const lanes = {};
    const cards = new Map();
    for (const lane of laneNames) lanes[lane] = await this.lane(lane);
    for (const lane of laneNames) {
      const result = await this.scanLane(lane);
      for (const card of result.cards) cards.set(card.key, { ...card, lane });
    }
    return { lanes, cards: [...cards.values()], at: new Date().toISOString() };
  }

  /** 页面最终归属查询。非虚拟泳道直接读；虚拟泳道通过滚动逐屏查找。 */
  async locateCard(key, lanes) {
    await this.waitIdle();
    const names = lanes ?? await this.laneNames();
    for (const lane of names) {
      if (await this.cardLocator(lane, key).count() > 0) {
        return { found: true, card: await this.renderedCard(lane, key), viaScroll: false };
      }
    }
    for (const lane of names) {
      const info = await this.lane(lane);
      if (info.collapsed || !info.virtual) continue;
      try {
        const revealed = await this.revealCard(lane, key);
        return { found: true, card: revealed.card, viaScroll: true };
      } catch (error) {
        if (!(error instanceof BoardError)) throw error;
      }
    }
    return { found: false, card: null, viaScroll: false };
  }

  /**
   * 执行一次真实 HTML5 拖放。zone 可选 accept（泳道正常接收区）或
   * placeholder（虚拟占位，用于演练“占位区不是服务器接受”）。
   */
  async dragCardToLane({ key, from, target, zone = 'accept' }) {
    // 先保证源卡在可视位置且页面已保存：拖动过程中一旦发生自动滚动，门户会
    // 重建虚拟列表节点，正在拖的卡片会被换掉，drop 永远不会到达目标泳道。
    const revealed = await this.revealCard(from, key);
    await this.waitIdle(2);
    const card = this.cardLocator(from, key);
    if (await card.count() === 0) throw new BoardError(`拖放源卡片不在 ${from}：${key}`);
    const zoneLocator = zone === 'placeholder'
      ? this.laneLocator(target).locator('[data-placeholder]').first()
      : this.laneLocator(target).locator('[data-accept-zone]');
    if (await zoneLocator.count() === 0) {
      throw new BoardError(zone === 'placeholder' ? `泳道 ${target} 没有虚拟占位` : `目标泳道 ${target} 没有可接收区域（可能已折叠）`);
    }
    const source = await card.evaluate(attributes);
    const targetLane = await this.lane(target);
    const statusBefore = await this.statusText();
    const savedBefore = await this.savedMarker();
    await card.dragTo(zoneLocator);
    this.evidence('drag', {
      key, from, target, zone,
      source,
      revealed: { scanned: revealed.scanned, virtual: revealed.reshown !== undefined },
      targetLane: { count: targetLane.count, capacity: targetLane.capacityLabel, collapsed: targetLane.collapsed },
      statusBefore, savedBefore
    });
    return { statusBefore, savedBefore, source, targetLane, revealed };
  }

  /** 处理浏览器确认框：accept 或 cancel；返回确认框原文作为证据。 */
  confirmDialog(choice, timeout = 2000) {
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        this.page.removeListener('dialog', handler);
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ seen: false, timedOut: true }), timeout);
      const handler = async dialog => {
        const message = dialog.message();
        try {
          if (choice === 'cancel') await dialog.dismiss();
          else await dialog.accept();
          finish({ seen: true, type: dialog.type(), message, choice });
        } catch (error) {
          finish({ seen: true, type: dialog.type(), message, choice, error: error.message });
        }
      };
      this.page.once('dialog', handler);
    });
  }

  async waitStatusChange(statusBefore) {
    await this.page.waitForFunction(
      before => document.querySelector('#status').textContent !== before,
      statusBefore,
      { timeout: this.settleTimeout }
    ).catch(() => {});
  }

  async waitSaved() {
    await this.page.waitForFunction(
      () => document.querySelector('#app').dataset.saved === 'true',
      null,
      { timeout: this.saveTimeout }
    ).catch(() => {});
    return this.savedMarker();
  }

  /**
   * 等到页面自身保存结束且结构稳定。门户每次渲染都会重建卡片节点；
   * 若在重建途中开始拖放，会拖到已脱离文档的旧节点。
   */
  async waitIdle(rounds = 4) {
    await this.waitSaved();
    let previous = null;
    let stable = 0;
    for (let attempt = 0; attempt < rounds * 4 && stable < rounds; attempt++) {
      const markup = await this.page.locator('#app').innerHTML();
      const saved = await this.savedMarker();
      if (markup === previous && saved === 'true') stable += 1;
      else stable = 0;
      previous = markup;
      if (stable < rounds) await this.page.waitForTimeout(100);
    }
    return { saved: await this.savedMarker(), stable: stable >= rounds };
  }

  /** 等待页面结束一次落点：状态栏更新，并等门户自身保存标记回到 true。 */
  async settleAfterDrop(statusBefore) {
    await this.waitStatusChange(statusBefore);
    await this.page.waitForTimeout(STEP_WAIT);
    if (await this.savedMarker() !== 'true') await this.waitSaved();
    return { status: await this.statusText(), saved: await this.savedMarker() };
  }

  async slotDialogPresent(timeout = 600) {
    return this.page.locator('[data-slot-dialog]').waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
  }

  slotOptions() {
    return this.page.locator('[data-slot-dialog] [data-slot-select] option')
      .evaluateAll(options => options.map(option => ({ value: option.value, label: option.textContent.trim() })));
  }

  async fillSlot(slot) {
    const options = await this.slotOptions();
    const match = options.find(option => option.value === slot);
    if (!match) throw new BoardError(`页面上没有作业时段：${slot}`, { options });
    await this.page.locator('[data-slot-dialog] [data-slot-select]').selectOption(slot);
    return { options, selected: match };
  }

  confirmSlot() { return this.page.locator('[data-slot-dialog] [data-slot-confirm]').click(); }

  cancelSlot() { return this.page.locator('[data-slot-dialog] [data-slot-cancel]').click(); }
}

export { CARD_FIELDS, attributes };
