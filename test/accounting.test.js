/**
 * 测试：核算恒等式、归属方法性质、治理不变量。
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  actualDeltaKg,
  attribute,
  baselineEstimateKg,
  boundaryImpact,
  decomposeDelta,
  expectedEmissionsKg,
  overlapDetails,
  periodEmissions,
  projectPoolKg,
  shapleyValues,
  summarize,
} from '../src/accounting.js';
import { buildSeedState, defaultSnapshot } from '../src/seed.js';
import {
  GovernanceError,
  batchBaseFingerprint,
  activityCsv,
  batchHash,
  closeDraft,
  confirmBatch,
  createDraft,
  createWorkspace,
  exportWorkspace,
  ingestActivity,
  importWorkspace,
  parseActivityCsv,
  rebaseDraft,
  restateBoundary,
  retractReport,
  retroCorrectFactor,
  supersedeBatch,
  updateAssumptions,
} from '../src/ledger.js';

const close = (a, b, eps = 1) =>
  assert.ok(Math.abs(a - b) <= eps, `期望 ${a} ≈ ${b}（差 ${(a - b).toFixed(4)}）`);

function freshDraft(overrides = {}) {
  const ws = createWorkspace({ sites: [{ id: 's1', name: '测试站点', defaultSnapshot }], batches: [], reports: [] });
  const batch = createDraft(ws, {
    siteId: 's1',
    caliber: '测试口径',
    label: '测试任务',
    actor: '测试员',
    ...overrides,
  });
  return { ws, batch };
}

const snapshotOf = (batch) => batch.snapshot;

/* ------------------------------ 核算 ------------------------------ */

test('实际变化 = 活动效应 + 因子效应', () => {
  const d = decomposeDelta(defaultSnapshot);
  close(d.totalKg, actualDeltaKg(defaultSnapshot));
  close(d.activityEffectKg + d.factorEffectKg, d.totalKg, 1e-6);
});

test('排放按两期各自因子版本计算', () => {
  const base = periodEmissions(defaultSnapshot, 'base').kg;
  const report = periodEmissions(defaultSnapshot, 'report').kg;
  close(base - report, actualDeltaKg(defaultSnapshot));
  assert.ok(base > report);
});

test('基线估算 = 所有项目不实施时按报告期因子计算的排放', () => {
  const baseline = baselineEstimateKg(defaultSnapshot);
  const cf = expectedEmissionsKg(defaultSnapshot, []);
  close(baseline, cf);
  // 基线使用基准活动量，应高于实际报告排放（项目与其它因素都降低了活动）
  assert.ok(baseline > periodEmissions(defaultSnapshot, 'report').kg);
});

test('项目总效应 = 单独效应之和 − 交互作用', () => {
  const a = attribute(defaultSnapshot, 'shapley');
  const sum = Object.values(a.standalone).reduce((s, v) => s + v, 0);
  close(sum - a.interactionKg, a.projectPoolKg, 2);
});

test('所有归属方法账目闭合且不超额', () => {
  for (const method of ['priority', 'proportional', 'shapley', 'residual']) {
    const a = attribute(defaultSnapshot, method);
    close(a.deltaKg, a.projectPoolKg + a.otherActivityKg + a.factorEffectKg, 2);
    if (method !== 'residual') {
      close(a.allocatedTotalKg + a.interactionUnallocatedKg, a.projectPoolKg, 2);
    } else {
      close(a.allocatedTotalKg + a.interactionUnallocatedKg, a.projectPoolKg, 2);
      assert.ok(a.interactionUnallocatedKg > 0, '保守归属必须单列重叠部分');
    }
    assert.ok(a.allocatedTotalKg <= Math.max(0, a.projectPoolKg) + 1);
    for (const v of Object.values(a.allocations)) assert.ok(v >= 0, `${method} 出现负归属`);
  }
});

test('Shapley 合计等于项目总效应且与顺序无关', () => {
  const ids = ['proj-energy', 'proj-process', 'proj-refrig'];
  const phi = shapleyValues(defaultSnapshot, ids);
  const pool = projectPoolKg(defaultSnapshot);
  close(Object.values(phi).reduce((s, v) => s + v, 0), pool, 2);
  // 交换项目顺序不应改变各自的值
  const reversed = shapleyValues(defaultSnapshot, [...ids].reverse());
  for (const id of ids) close(phi[id], reversed[id], 1e-6);
});

test('顺序优先法的结果确实依赖申报顺序', () => {
  const a = attribute(defaultSnapshot, 'priority');
  const orders = a.orderDependence;
  assert.ok(orders.length >= 2);
  const firsts = new Set(orders.map((o) => JSON.stringify(o.allocation)));
  assert.ok(firsts.size > 1, '不同顺位应产生不同分配');
});

test('同一变化不能通过两份申报重复计入', () => {
  const a = attribute(defaultSnapshot, 'shapley');
  const sumStandalone = a.standalone['proj-energy'] + a.standalone['proj-process'];
  const pair = a.combos.find(
    (c) => c.projectIds.includes('proj-energy') && c.projectIds.includes('proj-process'),
  );
  assert.ok(pair, '应能找到两个重叠项目的组合');
  assert.ok(pair.interactionKg > 0, '重叠项目应有正的重复申报量');
  close(pair.standaloneSumKg - pair.interactionKg, pair.jointEffectKg, 1);
  assert.ok(sumStandalone > pair.jointEffectKg);
});

test('逐条目重复贡献的金额与组合交互一致', () => {
  const a = attribute(defaultSnapshot, 'shapley');
  const overlaps = overlapDetails(defaultSnapshot, a.projects.map((p) => p.id));
  assert.ok(overlaps.length >= 1);
  for (const row of overlaps) {
    close(row.sumAloneKg - row.jointKg, row.overlapKg, 1);
    for (const kg of Object.values(row.perProject)) assert.ok(kg > 0);
  }
});

test('关闭项目后不再参与归属', () => {
  const snapshot = structuredClone(defaultSnapshot);
  snapshot.projects.find((p) => p.id === 'proj-refrig').active = false;
  const a = attribute(snapshot, 'shapley');
  assert.equal(a.allocations['proj-refrig'], undefined);
  assert.equal(a.projects.length, 2);
});

test('申报幅度极小时归属仍非负且不超过项目总效应', () => {
  const snapshot = structuredClone(defaultSnapshot);
  snapshot.projects.forEach((p) => (p.activityReduction = 0.0001));
  snapshot.items.forEach((item) => {
    item.activity.report = item.activity.base * 1.5;
  });
  const a = attribute(snapshot, 'shapley');
  for (const v of Object.values(a.allocations)) assert.ok(v >= 0);
  const sum = Object.values(a.allocations).reduce((s, v) => s + v, 0);
  close(sum, Math.max(0, a.projectPoolKg), 2);
  // 项目效应只由申报幅度与基准活动决定，与报告期实际活动无关
  assert.ok(a.projectPoolKg > 0);
  assert.ok(a.otherActivityKg < 0, '未被项目解释的活动上升应单独列为负的其它活动变化');
});

test('边界重述量使用调整前后差额，不重复计入', () => {
  const snapshot = structuredClone(defaultSnapshot);
  snapshot.boundaryChanges = [
    { itemId: 'item-line-b', kind: 'restated', fromActivity: 6400, toActivity: 5400, note: '测试' },
    { itemId: 'item-line-b', kind: 'restated', fromActivity: 5400, toActivity: 5400, note: '测试重复记录' },
  ];
  const b = boundaryImpact(snapshot);
  close(b.netRestatedBaseKg, -1000 * 570);
  close(b.baseRemovedKg, 1000 * 570);
  close(b.baseAddedKg, 0);
});

test('因子版本不一致会给出提示', () => {
  const a = summarize(defaultSnapshot, 'shapley');
  assert.ok(a.warnings.some((w) => w.includes('外购电力')));
  assert.ok(a.factorRows.every((f) => f.baseVersion));
});

/* ------------------------------ 治理 ------------------------------ */

test('已确认批次不可修改，且不能重复确认', () => {
  const ws = createWorkspace({ sites: [{ id: 's1', name: '测试站点', defaultSnapshot }], batches: [], reports: [] });
  const batch = createDraft(ws, { siteId: 's1', caliber: '口径', label: '任务', actor: '测试员' });
  confirmBatch(ws, batch.id, { actor: '测试员', reportLabel: '报告', method: 'shapley' });
  assert.throws(
    () => updateAssumptions(ws, batch.id, { activity: { 'item-gas': { report: 1 } } }, { actor: '测试员' }),
    (error) => error.code === 'BATCH_CONFIRMED',
  );
  assert.throws(
    () => updateAssumptions(
      ws,
      batch.id,
      { projects: { 'proj-energy': { activityReduction: 5 } } },
      { actor: '测试员' },
    ),
    (error) => error.code === 'BATCH_CONFIRMED',
  );
  assert.throws(
    () => confirmBatch(ws, batch.id, { actor: '测试员', reportLabel: '另一个报告', method: 'priority' }),
    (error) => error.code === 'BATCH_CONFIRMED' || error.code === 'DUPLICATE_REPORT',
  );
  assert.equal(ws.reports.length, 1);
});

test('确认时锁定内容哈希；导入时校验哈希', () => {
  const ws = createWorkspace({ sites: [{ id: 's1', name: '测试站点', defaultSnapshot }], batches: [], reports: [] });
  const batch = createDraft(ws, { siteId: 's1', caliber: '口径', label: '任务', actor: '测试员' });
  const report = confirmBatch(ws, batch.id, { actor: '测试员', reportLabel: '报告', method: 'shapley' });
  assert.equal(report.hash, batchHash(batch));
  const exported = exportWorkspace(ws);
  // 正常导入
  const restored = importWorkspace(exported, { actor: '测试员' });
  assert.equal(restored.reports.length, 1);
  // 篡改内容后导入应失败
  const tampered = exportWorkspace(ws);
  tampered.batches[0].snapshot.items[0].activity.report = 1;
  assert.throws(() => importWorkspace(tampered), (error) => error.code === 'IMPORT_INVALID');
});

test('报告不可编辑，只能撤回并保留原哈希', () => {
  const { ws, batch } = freshDraft();
  const report = confirmBatch(ws, batch.id, { actor: '测试员', reportLabel: '报告', method: 'shapley' });
  const before = report.hash;
  assert.throws(() => retractReport(ws, report.id, { actor: '测试员', reason: '' }), /原因/);
  retractReport(ws, report.id, { actor: '测试员', reason: '数据有误' });
  assert.equal(report.status, 'retracted');
  assert.equal(report.hash, before);
  assert.throws(
    () => retractReport(ws, report.id, { actor: '测试员', reason: '再撤回一次' }),
    (error) => error.code === 'REPORT_IMMUTABLE',
  );
});

test('追溯更正只创建新草稿，旧批次与旧报告保持不变', () => {
  const { ws, batch } = freshDraft();
  const report = confirmBatch(ws, batch.id, { actor: '测试员', reportLabel: '报告', method: 'shapley' });
  const oldHash = report.hash;
  const replacement = supersedeBatch(ws, batch.id, { actor: '测试员', reason: '因子更正' });
  assert.equal(batch.status, 'superseded');
  assert.equal(batch.confirmed.hash, oldHash);
  assert.equal(report.hash, oldHash);
  assert.equal(report.supersededBy, replacement.id);
  assert.equal(replacement.status, 'draft');
  assert.equal(replacement.basedOn, batch.id);
  // 新草稿可编辑
  updateAssumptions(ws, replacement.id, { activity: { 'item-gas': { report: 2400 } } }, { actor: '测试员' });
});

test('基准指纹：同版才能对照，追溯更正会改变指纹', () => {
  const ws = createWorkspace({ sites: [{ id: 's1', name: '测试站点', defaultSnapshot }], batches: [], reports: [] });
  const a = createDraft(ws, { siteId: 's1', caliber: '口径', label: 'A', actor: '测试员' });
  const b = createDraft(ws, { siteId: 's1', caliber: '口径', label: 'B', actor: '测试员' });
  assert.equal(batchBaseFingerprint(a), batchBaseFingerprint(b));
  retroCorrectFactor(ws, b.id, {
    factorId: 'fac-grid',
    baseKgPerUnit: 600,
    note: '虚构因子库更正',
    actor: '测试员',
  });
  assert.notEqual(batchBaseFingerprint(a), batchBaseFingerprint(b));
  assert.equal(a.snapshot.factors.find((f) => f.id === 'fac-grid').kgPerUnit, 570, '另一个任务不应被改动');
  // 同步基准后恢复同版
  rebaseDraft(ws, a.id, { sourceBatchId: b.id, actor: '测试员' });
  assert.equal(batchBaseFingerprint(a), batchBaseFingerprint(b));
});

test('基准同步保留报告期假设', () => {
  const ws = createWorkspace({ sites: [{ id: 's1', name: '测试站点', defaultSnapshot }], batches: [], reports: [] });
  const a = createDraft(ws, { siteId: 's1', caliber: '口径', label: 'A', actor: '测试员' });
  const b = createDraft(ws, { siteId: 's1', caliber: '口径', label: 'B', actor: '测试员' });
  updateAssumptions(ws, a.id, { activity: { 'item-gas': { report: 2000 } } }, { actor: '测试员' });
  restateBoundary(ws, b.id, {
    itemId: 'item-line-b',
    newBaseActivity: 5400,
    kind: 'restated',
    note: '重述',
    actor: '测试员',
  });
  rebaseDraft(ws, a.id, { sourceBatchId: b.id, actor: '测试员' });
  assert.equal(a.snapshot.items.find((i) => i.id === 'item-gas').activity.report, 2000);
  assert.equal(a.snapshot.items.find((i) => i.id === 'item-line-b').activity.base, 5400);
});

test('基准期不能通过常规编辑修改', () => {
  const { ws, batch } = freshDraft();
  assert.throws(
    () => updateAssumptions(ws, batch.id, { activity: { 'item-gas': { base: 1 } } }, { actor: '测试员' }),
    /基准期/,
  );
  assert.throws(
    () => updateAssumptions(ws, batch.id, { factors: { 'fac-grid': { kgPerUnit: 1 } } }, { actor: '测试员' }),
    /基准期/,
  );
});

test('乐观锁阻止陈旧写入', () => {
  const { ws, batch } = freshDraft();
  const oldHash = batchHash(batch);
  updateAssumptions(ws, batch.id, { activity: { 'item-gas': { report: 2000 } } }, { actor: '测试员' });
  assert.throws(
    () => updateAssumptions(
      ws,
      batch.id,
      { activity: { 'item-gas': { report: 2100 } } },
      { actor: '测试员', expectedHash: oldHash },
    ),
    (error) => error.code === 'STALE_BATCH',
  );
});

test('审计记录追加且修订号递增', () => {
  const { ws, batch } = freshDraft();
  const before = ws.revision;
  updateAssumptions(ws, batch.id, { activity: { 'item-gas': { report: 2000 } } }, { actor: '测试员 A' });
  assert.ok(ws.revision > before);
  assert.equal(ws.audit[0].action, 'batch.edit');
  assert.equal(ws.audit[0].actor, '测试员 A');
});

test('关闭的草稿不可再编辑或确认', () => {
  const { ws, batch } = freshDraft();
  closeDraft(ws, batch.id, { actor: '测试员', reason: '改为新任务' });
  assert.throws(
    () => updateAssumptions(ws, batch.id, { activity: { 'item-gas': { report: 1 } } }, { actor: '测试员' }),
    (error) => error.code === 'BATCH_CONFIRMED',
  );
});

test('产物可完整导出并恢复，且恢复后归属结果一致', () => {
  const { workspace } = buildSeedState();
  const before = summarize(
    workspace.batches.find((b) => b.label === '2025 年度复核').snapshot,
    'shapley',
  );
  const restored = importWorkspace(exportWorkspace(workspace), { actor: '测试员' });
  const after = summarize(
    restored.batches.find((b) => b.label === '2025 年度复核').snapshot,
    'shapley',
  );
  assert.deepEqual(after.allocations, before.allocations);
  assert.equal(restored.reports.length, workspace.reports.length);
});

test('导入非法 schema 会被拒绝', () => {
  assert.throws(
    () => importWorkspace({ schema: 'something-else' }),
    (error) => error.code === 'IMPORT_INVALID',
  );
  assert.throws(() => importWorkspace('not json'), (error) => error.code === 'IMPORT_INVALID');
});

test('治理错误带有可用的 HTTP 状态码', () => {
  const error = new GovernanceError('STALE_BATCH', 'x');
  assert.equal(error.statusCode, 409);
});

/* ------------------------------ 数据接入 ------------------------------ */

test('CSV 接入只写报告期，并记录来源与行哈希', () => {
  const { ws, batch } = freshDraft();
  const csv = [
    'itemId,period,activity,label,unit',
    'item-gas,report,"2,400",天然气,千立方米',
    'item-steam,report,20000,蒸汽,GJ',
  ].join('\n');
  const baseBefore = JSON.stringify(batch.snapshot.items.map((i) => i.activity.base));
  const result = ingestActivity(ws, batch.id, {
    csv,
    sourceLabel: '虚构台账导出',
    actor: '测试员',
  });
  assert.equal(result.ingestion.rowCount, 2);
  assert.equal(result.changes.length, 2);
  assert.equal(batch.snapshot.items.find((i) => i.id === 'item-gas').activity.report, 2400);
  assert.equal(batch.snapshot.items.find((i) => i.id === 'item-gas').activity.base, 1800);
  assert.equal(JSON.stringify(batch.snapshot.items.map((i) => i.activity.base)), baseBefore);
  assert.equal(batch.snapshot.ingestions.length, 1);
  assert.match(batch.snapshot.ingestions[0].sourceLabel, /虚构台账/);
  assert.equal(batch.snapshot.baseVersion, 'v1', '接入报告期数据不应改变基准版本');
});

test('CSV 接入拒绝基准期行与未知条目', () => {
  const { ws, batch } = freshDraft();
  assert.throws(
    () => ingestActivity(ws, batch.id, {
      csv: 'item-gas,base,1000',
      sourceLabel: 'x',
      actor: '测试员',
    }),
    (error) => error.code === 'VALIDATION' && error.details.problems[0].includes('report'),
  );
  const { problems, rows } = parseActivityCsv('item-unknown,report,10');
  assert.equal(problems.length, 0);
  assert.equal(rows.length, 1);
  assert.throws(
    () => ingestActivity(ws, batch.id, {
      csv: 'item-unknown,report,10',
      sourceLabel: 'x',
      actor: '测试员',
    }),
    (error) => error.code === 'VALIDATION',
  );
});

test('CSV 接入受治理约束：已确认批次不可接入', () => {
  const { ws, batch } = freshDraft();
  confirmBatch(ws, batch.id, { actor: '测试员', reportLabel: '报告', method: 'shapley' });
  assert.throws(
    () => ingestActivity(ws, batch.id, {
      csv: 'item-gas,report,2000',
      sourceLabel: 'x',
      actor: '测试员',
    }),
    (error) => error.code === 'BATCH_CONFIRMED',
  );
});

test('导出的活动模板可原样接入且不改变数值', () => {
  const { ws, batch } = freshDraft();
  const csv = activityCsv(batch);
  const result = ingestActivity(ws, batch.id, {
    csv,
    sourceLabel: '回读模板',
    actor: '测试员',
  });
  assert.equal(result.changes.length, 0);
});

test('CSV 解析容忍注释、空行与千分位', () => {
  const { rows, problems } = parseActivityCsv(`
# 这是注释
item-gas,report,"2,350"
 
item-steam,report,18000
`);
  assert.deepEqual(problems, []);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].activity, 2350);
});
