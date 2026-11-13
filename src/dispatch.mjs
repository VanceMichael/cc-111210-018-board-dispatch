import { BoardPage, BoardError } from './board.mjs';

const IDENTITY_FLAGS = ['key', 'voyage', 'version', 'lane', 'title'];

export function parseStatus(text) {
  const raw = (text ?? '').trim();
  if (!raw) return { raw, state: 'none' };
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object') return { raw, ...value, state: value.state ?? 'unknown' };
  } catch { /* 纯文本状态 */ }
  if (raw === '已取消') return { raw, state: 'cancelled' };
  return { raw, state: 'text' };
}

function identity(card) {
  return Object.fromEntries(IDENTITY_FLAGS.map(flag => [flag, card?.[flag] ?? null]));
}

function duplicateOf(items, key, own) {
  return items.filter(item => item.key === key).length > 1 && items.indexOf(own) !== items.findIndex(item => item.key === key);
}

/**
 * 基于业务键（key + 航次 + 页面版本 + 当前泳道）生成分派预览。
 * 只读页面证据；不触碰页面数据，不按标题匹配。
 * request: { target, cards:[{key, voyage?}], slots?, confirm?:{key:'cancel'}, depends?:{key:other}, zones? }
 */
export async function previewPlan(board, request) {
  const mark = board.mark();
  const target = request.target;
  if (!target || target === 'pending') throw new BoardError('分派目标必须是一个班组泳道');
  if (!Array.isArray(request.cards) || request.cards.length === 0) throw new BoardError('分派计划没有作业卡');
  const laneNames = await board.laneNames();
  if (!laneNames.includes(target)) throw new BoardError(`目标泳道不存在：${target}`, { laneNames });

  const snapshot = await board.snapshot();
  const readEvidence = board.evidenceSince(mark);
  const targetBefore = snapshot.lanes[target];
  const pageCards = new Map(snapshot.cards.map(card => [card.key, card]));
  const requested = request.cards.map(order => ({
    key: order.key,
    voyage: order.voyage ?? null,
    slot: request.slots?.[order.key] ?? order.slot ?? null,
    cancelConfirm: Boolean(request.confirm?.[order.key] === 'cancel'),
    zone: request.zones?.[order.key] === 'placeholder' ? 'placeholder' : 'accept'
  }));

  const items = requested.map(own => {
    const pageCard = pageCards.get(own.key);
    const reasons = [];
    let status = 'ready';
    const conflict = code => { status = 'conflict'; reasons.push({ code, message: reasonText[code] }); };
    if (!own.key) conflict('missing-key');
    else if (duplicateOf(requested, own.key, own)) conflict('duplicate-item');
    else if (!pageCard) conflict('not-on-page');
    else if (own.voyage && pageCard.voyage !== own.voyage) {
      reasons.push({ code: 'voyage-mismatch', message: `航次不符：计划 ${own.voyage}，页面 ${pageCard.voyage}` });
      status = 'conflict';
    } else if (pageCard.lane === target) {
      status = 'already';
      reasons.push({ code: 'already-in-target', message: '页面最终归属已在目标泳道，无需拖动' });
    } else if (pageCard.lane !== 'pending') {
      reasons.push({ code: 'external-attribution', message: `页面归属 ${pageCard.lane}，可能已由人工派走，不拉回` });
      status = 'conflict';
    } else if (pageCard.requiresSlot && !own.slot) {
      reasons.push({ code: 'slot-required', message: '页面要求补选作业时段，计划未提供时段' });
      status = 'conflict';
    }
    const effectiveVoyage = own.voyage ?? pageCard?.voyage ?? null;
    return {
      ...own,
      voyage: effectiveVoyage,
      title: pageCard?.title ?? null,
      pageVoyage: pageCard?.voyage ?? null,
      version: pageCard?.version ?? null,
      pageLane: pageCard?.lane ?? null,
      requiresSlot: Boolean(pageCard?.requiresSlot),
      status,
      reasons,
      dependencies: [],
      batch: null,
      evidence: pageCard ? { atPreview: identity(pageCard), targetLaneBefore: laneBrief(targetBefore) } : null
    };
  });

  linkDependencies(items, pageCards, request, target);

  assignBatches(items);
  assignCapacity(items, targetBefore);
  blockDependents(items);

  const batches = [...new Set(items.filter(item => item.status === 'ready').map(item => item.batch))].sort((a, b) => a - b)
    .map(batch => ({
      batch,
      keys: items.filter(item => item.status === 'ready' && item.batch === batch && !item.dependencies.some(dependency => items.find(other => other.key === dependency && other.status !== 'ready' && other.status !== 'already')))
        .map(item => item.key)
    }))
    .filter(level => level.keys.length > 0);
  return {
    target,
    requestedAt: new Date().toISOString(),
    targetLaneBefore: laneBrief(targetBefore),
    lanes: snapshot.lanes,
    pageCards: snapshot.cards.map(identity),
    items,
    batches,
    ready: items.filter(item => item.status === 'ready'),
    already: items.filter(item => item.status === 'already'),
    conflicts: items.filter(item => item.status === 'conflict'),
    readEvidence
  };
}

const reasonText = {
  'missing-key': '分派项缺少业务键',
  'duplicate-item': '同一业务键在计划中出现多次',
  'not-on-page': '当前页面找不到该作业卡',
  'dependency-unknown': '前置作业不在页面',
  'dependency-pending': '前置作业仍在待分派栏，计划未包含它',
  'dependency-cycle': '依赖形成环，不能排定先后',
  capacity: '目标泳道容量不足',
  'dependency-conflicted': '前置作业在预览中不可执行'
};

function laneBrief(lane) {
  return lane ? { count: lane.count, capacity: lane.capacityLabel, collapsed: lane.collapsed, virtual: lane.virtual } : null;
}

function linkDependencies(items, pageCards, request, target) {
  const byKey = new Map(items.map(item => [item.key, item]));
  for (const item of items) {
    if (!item.key) continue;
    const pageCard = pageCards.get(item.key);
    const declared = request.depends?.[item.key];
    const dependency = declared ?? pageCard?.depends ?? null;
    if (!dependency) continue;
    item.dependencies = [dependency];
    if (byKey.has(dependency)) continue;
    const pagePrerequisite = pageCards.get(dependency);
    item.evidence = { ...item.evidence, prerequisite: pagePrerequisite ? identity(pagePrerequisite) : null };
    if (!pagePrerequisite) {
      item.status = 'conflict';
      item.reasons.push({ code: 'dependency-unknown', message: `前置作业 ${dependency} 不在页面` });
    } else if (pagePrerequisite.lane === 'pending') {
      item.status = 'conflict';
      item.reasons.push({ code: 'dependency-pending', message: `前置作业 ${dependency} 仍在待分派栏，计划未包含它` });
    } else if (pagePrerequisite.lane !== target) {
      item.status = 'conflict';
      item.reasons.push({ code: 'dependency-elsewhere', message: `前置作业 ${dependency} 当前在 ${pagePrerequisite.lane}，不在目标泳道` });
    }
  }
}

/** 按计划内依赖拓扑分层。已判冲突的前置卡不参与分层，其依赖者由 blockDependents 处理。 */
function assignBatches(items) {
  const included = items.filter(item => item.status !== 'conflict' && item.status !== 'already').map(item => item.key);
  const byKey = new Map(items.map(item => [item.key, item]));
  const includedSet = new Set(included);
  const placed = new Set();
  let remaining = included.slice();
  let level = 0;
  while (remaining.length > 0) {
    const ready = remaining.filter(key => byKey.get(key).dependencies.every(dependency => (
      !includedSet.has(dependency) || placed.has(dependency)
    )));
    if (ready.length === 0) {
      for (const key of remaining) {
        const item = byKey.get(key);
        item.status = 'conflict';
        item.reasons.push({ code: 'dependency-cycle', message: '依赖形成环，不能排定先后' });
      }
      return;
    }
    for (const key of ready) {
      byKey.get(key).batch = level;
      placed.add(key);
    }
    remaining = remaining.filter(key => !placed.has(key));
    level += 1;
  }
}

/** 容量竞争：现有占位 + 按批次先后累计；一旦超容量，其依赖者也不能越过它继续。 */
function assignCapacity(items, targetBefore) {
  if (targetBefore.capacity === Infinity) return;
  let projected = targetBefore.count;
  const ordered = items.filter(item => item.status !== 'conflict' && item.status !== 'already').sort((a, b) => a.batch - b.batch);
  for (const item of ordered) {
    if (projected + 1 > targetBefore.capacity) {
      item.status = 'conflict';
      item.reasons.push({
        code: 'capacity',
        message: `目标泳道名额不足：现有 ${projected}，容量 ${targetBefore.capacityLabel}`,
        projected, capacity: targetBefore.capacityLabel
      });
      continue;
    }
    projected += 1;
  }
}

function blockDependents(items) {
  const failed = new Set(items.filter(item => item.status === 'conflict').map(item => item.key));
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (item.status === 'conflict' || item.status === 'already') continue;
      const dependency = item.dependencies.find(key => failed.has(key));
      if (!dependency) continue;
      item.status = 'conflict';
      item.reasons.push({ code: 'dependency-conflicted', message: `前置作业 ${dependency} 在预览中不可执行` });
      failed.add(item.key);
      changed = true;
    }
  }
}

async function verifyAttribution(board, item, target, sourceLane, versionBefore) {
  const located = await board.locateCard(item.key);
  const targetLane = await board.lane(target);
  const sourceHas = sourceLane === target ? false : await board.cardLocator(sourceLane, item.key).count() > 0;
  const targetKeys = await board.laneLocator(target).locator('[data-card]').evaluateAll(elements => elements.map(element => element.dataset.key));
  return {
    found: located.found,
    pageLane: located.found ? located.card.lane : null,
    card: located.found ? identity(located.card) : null,
    matchedTarget: Boolean(located.found && located.card.lane === target),
    sourceStillHasCard: sourceHas,
    versionBefore,
    versionAfter: located.found ? located.card.version : null,
    versionAdvanced: Boolean(located.found && located.card.version > versionBefore),
    targetKeys,
    targetLane: laneBrief(targetLane)
  };
}

/**
 * 按预览批次执行。每张卡的动作前后都从页面取证；单卡失败不阻断无关卡，
 * 但依赖失败卡的后继会被标记 blocked。最终归属一律以页面快照为准。
 */
export async function executePlan(board, plan, { dryRun = false } = {}) {
  const mark = board.mark();
  const outcomes = new Map();
  for (const item of plan.items) {
    if (item.status === 'already') outcomes.set(item.key, { status: 'already-in-target', reason: 'preview-already', evidence: { atPreview: item.evidence?.atPreview ?? null } });
    else if (item.status === 'conflict') outcomes.set(item.key, { status: 'skipped-conflict', reason: item.reasons.map(reason => reason.code).join(','), evidence: { reasons: item.reasons } });
  }

  if (!dryRun) {
    for (const batch of plan.batches) {
      for (const key of batch.keys) {
        const item = plan.items.find(candidate => candidate.key === key);
        const failedDependencies = item.dependencies.filter(dependency => {
          const outcome = outcomes.get(dependency);
          // 只有确认落在目标泳道的卡（提交成功或预览时已在目标）才算前置完成；
          // 被人工派到别处、取消、冲突或跳过的前置都不能让后继越过去继续。
          return !outcome || !['committed', 'already-in-target'].includes(outcome.status);
        });
        if (failedDependencies.length > 0) {
          outcomes.set(item.key, {
            status: 'blocked',
            reason: 'dependency-failed',
            evidence: {
              dependencies: failedDependencies.map(dependency => ({ key: dependency, status: outcomes.get(dependency)?.status ?? 'not-run' }))
            }
          });
          continue;
        }
        const itemMark = board.mark();
        const outcome = await dispatchItem(board, plan, item);
        outcome.actions = board.evidenceSince(itemMark);
        outcomes.set(item.key, outcome);
      }
    }
  } else {
    for (const batch of plan.batches) {
      for (const key of batch.keys) outcomes.set(key, { status: 'planned' });
    }
  }

  const finalSnapshot = await board.snapshot();
  const attribution = {};
  for (const item of plan.items) {
    const card = finalSnapshot.cards.find(candidate => candidate.key === item.key) ?? null;
    const outcome = outcomes.get(item.key);
    const pageLane = card?.lane ?? null;
    let verdict;
    if (!card) verdict = 'not-on-page';
    else if (pageLane === plan.target) verdict = outcome?.status === 'committed' ? 'confirmed-in-target' : 'in-target-not-by-this-run';
    else if (outcome?.status === 'committed') verdict = 'moved-after-commit';
    else verdict = 'not-in-target';
    attribution[item.key] = {
      pageLane,
      title: card?.title ?? null,
      voyage: card?.voyage ?? null,
      version: card?.version ?? null,
      outcome: outcome?.status ?? 'not-run',
      verdict,
      pageEvidence: identity(card)
    };
  }
  return {
    target: plan.target,
    dryRun,
    outcomes: [...outcomes.entries()].map(([key, value]) => ({ key, ...value })),
    attribution,
    finalSnapshot,
    evidence: board.evidenceSince(mark)
  };
}

async function dispatchItem(board, plan, item) {
  const target = plan.target;
  const record = (step, detail) => board.evidence(step, detail);

  // 执行前重新核对：归属、航次、版本都可能已变化。
  const located = await board.locateCard(item.key);
  record('recheck-card', { planned: identity(item.evidence?.atPreview), page: located.found ? identity(located.card) : null });
  if (!located.found) return { status: 'failed', reason: 'not-on-page' };
  if (item.voyage && located.card.voyage !== item.voyage) return { status: 'conflict', reason: 'voyage-mismatch' };
  if (located.card.lane === target) return { status: 'already-in-target', reason: 'page-already-in-target' };
  if (located.card.lane !== 'pending') {
    return { status: 'skipped-external', reason: 'external-attribution', current: identity(located.card) };
  }
  if (item.version != null && located.card.version !== item.version) return { status: 'conflict', reason: 'version-changed' };

  // 目标泳道折叠时先按页面展开按钮打开；展开失败也不能继续拖到隐藏区域。
  const targetLane = await board.lane(target);
  if (targetLane.collapsed) {
    const expanded = await board.openLane(target);
    record('expand-target-lane', { before: laneBrief(expanded.before), after: laneBrief(expanded.after) });
    if (!expanded.changed) return { status: 'conflict', reason: 'lane-collapsed', pageStatus: { state: 'collapsed' } };
  }
  const targetNow = await board.lane(target);
  const sourceNow = await board.lane('pending');
  record('lane-check', { target: laneBrief(targetNow), source: laneBrief(sourceNow) });
  if (targetNow.count >= targetNow.capacity) {
    return { status: 'conflict', reason: 'capacity', detail: { count: targetNow.count, capacity: targetNow.capacityLabel } };
  }

  // 待分派栏可能虚拟滚动：先滚到该卡真实渲染位置，拖放源必须是页面上的真实卡片节点。
  // dragCardToLane 内部会再次确保可见（拖动时不再触发列表滚动）。
  const revealed = await board.revealCard(located.card.lane, item.key);
  record('reveal-source-card', {
    sourceLane: located.card.lane,
    virtual: (await board.lane(located.card.lane)).virtual,
    scanned: revealed.scanned,
    seen: revealed.seen,
    scroll: revealed.scroll,
    card: identity(revealed.card)
  });

  const dialogChoice = item.cancelConfirm ? 'cancel' : 'accept';
  const dialogPromise = board.confirmDialog(dialogChoice, 5000);
  const drag = await board.dragCardToLane({ key: item.key, from: located.card.lane, target, zone: item.zone });
  const dialog = await dialogPromise;

  return await settleDispatch(board, { item, target, drag, dialog, versionBefore: revealed.card.version, sourceLane: located.card.lane, record });
}

async function settleDispatch(board, { item, target, drag, dialog, versionBefore, sourceLane, record }) {
  record('confirm-dialog', dialog);
  const settled = await board.settleAfterDrop(drag.statusBefore);
  const status = parseStatus(settled.status);
  record('drop-settled', { status, saved: settled.saved });
  if (!dialog.seen) {
    const conflictLike = ['rejected', 'blocked', 'invalid-drop'].includes(status.state);
    return {
      status: conflictLike ? 'conflict' : 'failed',
      reason: status.reason ?? status.state ?? 'no-confirm-dialog',
      pageStatus: status,
      saved: settled.saved
    };
  }

  if (status.state === 'needs-slot') {
    const present = await board.slotDialogPresent();
    record('slot-dialog', { present });
    if (present && !item.slot) {
      await board.cancelSlot();
      const after = await board.settleAfterDrop(settled.status);
      record('slot-cancelled', { status: parseStatus(after.status) });
      return { status: 'conflict', reason: 'slot-required' };
    }
    if (!item.slot) return { status: 'conflict', reason: 'slot-required', pageStatus: status };
    if (!present) return { status: 'failed', reason: 'slot-dialog-missing' };
    const filled = await board.fillSlot(item.slot);
    record('slot-select', filled);
    await board.confirmSlot();
    const afterSlot = await board.settleAfterDrop(settled.status);
    const slotStatus = parseStatus(afterSlot.status);
    record('slot-settled', { status: slotStatus, saved: afterSlot.saved });
    if (slotStatus.state !== 'accepted') return { status: 'conflict', reason: slotStatus.reason ?? slotStatus.state, pageStatus: slotStatus };
    const verification = await verifyAttribution(board, item, target, sourceLane, versionBefore);
    record('verify-final-attribution', verification);
    if (!verification.matchedTarget || !verification.versionAdvanced || verification.sourceStillHasCard) {
      return { status: 'failed', reason: 'verification-mismatch', verification };
    }
    return { status: 'committed', slot: item.slot, verification };
  }

  if (dialog.choice === 'cancel' || status.state === 'cancelled') return { status: 'cancelled', reason: 'confirm-cancelled', pageStatus: status };
  if (status.state === 'rejected' || status.state === 'blocked' || status.state === 'invalid-drop') {
    return { status: 'conflict', reason: status.reason ?? status.state, pageStatus: status };
  }
  if (status.state !== 'accepted') return { status: 'failed', reason: status.state ?? 'not-accepted', pageStatus: status };
  const verification = await verifyAttribution(board, item, target, sourceLane, versionBefore);
  record('verify-final-attribution', verification);
  if (!verification.matchedTarget || verification.sourceStillHasCard) {
    return { status: 'failed', reason: 'verification-mismatch', verification };
  }
  return { status: 'committed', verification };
}

/** 恢复核对：只读页面最终归属。人工已派走或已改归属的卡保留页面结果，不拉回。 */
export async function recoverPlan(board, plan, previous) {
  const mark = board.mark();
  const snapshot = await board.snapshot();
  const report = [];
  for (const item of plan.items) {
    const card = snapshot.cards.find(candidate => candidate.key === item.key) ?? null;
    const before = previous?.attribution?.[item.key];
    const pageLane = card?.lane ?? null;
    let note;
    if (!card) note = 'missing';
    else if (pageLane === plan.target) note = before?.pageLane === pageLane ? 'confirmed-in-target' : 'now-in-target-outside-this-run';
    else if (before && before.pageLane === plan.target) note = 'moved-away-after-plan';
    else if (pageLane !== 'pending') note = 'external-attribution-kept';
    else note = 'still-pending';
    report.push({
      key: item.key,
      pageLane,
      version: card?.version ?? null,
      plannedVersion: item.version,
      plannedLane: item.pageLane,
      previousPageLane: before?.pageLane ?? null,
      note,
      pageEvidence: card ? identity(card) : null
    });
  }
  return { target: plan.target, report, lanes: snapshot.lanes, evidence: board.evidenceSince(mark) };
}

export { BoardPage, BoardError };
