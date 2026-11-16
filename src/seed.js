/**
 * 虚构演示数据。任何与真实企业、设施、认证体系的重合均属巧合。
 * 数值仅用于展示归属方法，不构成任何实际排放声明。
 */
import {
  confirmBatch,
  createDraft,
  createWorkspace,
  restateBoundary,
  updateAssumptions,
  exportWorkspace,
} from './ledger.js';

export const SITE_ID = 'site-demo-1';

export const seedSite = {
  id: SITE_ID,
  name: '晨雾化工（虚构）· 临江基地',
  sector: '精细化工（虚构）',
  boundaryText:
    '组织边界：临江基地全部生产装置、公用工程与厂内物流；江北包装车间于 2025 年并入。',
  note: '站点名称、组织边界与全部数据均为虚构演示。',
};

const factors = [
  {
    id: 'fac-grid',
    label: '外购电力',
    unit: 'MWh',
    kgPerUnit: 570,
    reportKgPerUnit: 512,
    baseVersion: '电网因子 2024（虚构 v1）',
    reportVersion: '电网因子 2025（虚构 v2）',
    source: '虚构区域电网因子库',
  },
  {
    id: 'fac-steam',
    label: '外购蒸汽',
    unit: 'GJ',
    kgPerUnit: 78,
    reportKgPerUnit: 74,
    baseVersion: '热力因子 v2（虚构）',
    reportVersion: '热力因子 v3（虚构）',
    source: '虚构热力因子库',
  },
  {
    id: 'fac-gas',
    label: '天然气',
    unit: '千立方米',
    kgPerUnit: 2160,
    reportKgPerUnit: 2160,
    baseVersion: '燃气因子 v1（虚构）',
    reportVersion: '燃气因子 v1（虚构）',
    source: '虚构燃料因子表',
  },
  {
    id: 'fac-refrig',
    label: '制冷剂补充 R-134a',
    unit: 'kg',
    kgPerUnit: 1430,
    reportKgPerUnit: 1430,
    baseVersion: 'GWP 2024（虚构）',
    reportVersion: 'GWP 2024（虚构）',
    source: '虚构 GWP 表',
  },
];

const items = [
  {
    id: 'item-power-process',
    label: '反应与精馏装置用电',
    unit: 'MWh',
    factorId: 'fac-grid',
    activity: { base: 42000, report: 33000 },
    projectIds: ['proj-energy', 'proj-process'],
  },
  {
    id: 'item-power-utility',
    label: '公用工程与照明用电',
    unit: 'MWh',
    factorId: 'fac-grid',
    activity: { base: 12000, report: 9000 },
    projectIds: ['proj-energy'],
  },
  {
    id: 'item-steam',
    label: '外购蒸汽（干燥与伴热）',
    unit: 'GJ',
    factorId: 'fac-steam',
    activity: { base: 26000, report: 18000 },
    projectIds: ['proj-energy'],
  },
  {
    id: 'item-gas',
    label: '天然气（备用锅炉与焚烧）',
    unit: '千立方米',
    factorId: 'fac-gas',
    activity: { base: 1800, report: 2350 },
    projectIds: [],
  },
  {
    id: 'item-refrig',
    label: '制冷剂补充与泄漏',
    unit: 'kg',
    factorId: 'fac-refrig',
    activity: { base: 240, report: 150 },
    projectIds: ['proj-refrig'],
  },
  {
    id: 'item-line-b',
    label: 'B 线溶剂回收（2025 年并入边界）',
    unit: 'MWh',
    factorId: 'fac-grid',
    activity: { base: 6400, report: 5200 },
    projectIds: ['proj-process'],
  },
];

const projects = [
  {
    id: 'proj-energy',
    label: '蒸汽冷凝水与电机系统节能改造',
    team: '能源管理部（虚构）',
    activityReduction: 0.15,
    itemIds: ['item-power-process', 'item-power-utility', 'item-steam'],
    active: true,
    note: '申报口径：2025 全年相对 2024 的节能量，含电机替换与蒸汽疏水阀改造。',
  },
  {
    id: 'proj-process',
    label: 'B 线精馏工艺优化',
    team: '工艺技术部（虚构）',
    activityReduction: 0.13,
    itemIds: ['item-power-process', 'item-line-b'],
    active: true,
    note: '申报口径：精馏装置单位电耗下降；与节能改造在「反应与精馏装置用电」上重叠。',
  },
  {
    id: 'proj-refrig',
    label: '制冷剂泄漏检测与回收计划',
    team: '设备保障部（虚构）',
    activityReduction: 0.15,
    itemIds: ['item-refrig'],
    active: true,
    note: '独立项目，用于对照：与其它项目无活动重叠。',
  },
];

const boundaryChanges = [
  {
    id: 'bc-line-b',
    itemId: 'item-line-b',
    kind: 'added',
    note: '江北包装车间于 2025 年并入临江基地；基准期已按现行边界重述。',
    at: '2025-01-05T00:00:00.000Z',
    fromActivity: 0,
    toActivity: 6400,
  },
];

export const defaultSnapshot = {
  periods: ['base', 'report'],
  basePeriodLabel: '2024 基准年',
  reportPeriodLabel: '2025 报告年',
  baseVersion: 'v1',
  boundaryText: seedSite.boundaryText,
  factors,
  items,
  projects,
  boundaryChanges,
  assumptions: {
    factorTrend: '报告期因子按虚构因子库更新；基准期不追溯重算。',
    activitySource: '虚构计量台账与班组报表。',
    ownershipMethod: '运营控制法（虚构演示口径）',
  },
};

/** 初始工作区：一份已确认清单、一份草稿、一份已重述边界的并行草稿。 */
export function buildSeedState() {
  const ws = createWorkspace({
    sites: [{ ...seedSite, defaultSnapshot }],
    batches: [],
    reports: [],
  });
  const confirmedBatch = createDraft(ws, {
    siteId: SITE_ID,
    caliber: '组织温室气体 · 运营控制法（虚构）',
    label: '2024 年度排放清单',
    actor: '演示管理员',
  });
  const report = confirmBatch(ws, confirmedBatch.id, {
    actor: '演示管理员',
    reportLabel: '2024 年度排放清单（已确认）',
    method: 'shapley',
  });
  // 给初始报告补一份方法快照说明，便于演示“旧报告不被改写”。
  report.note = '演示用已确认报告；内容哈希锁定。';

  const draft = createDraft(ws, {
    siteId: SITE_ID,
    caliber: confirmedBatch.caliber,
    label: '2025 年度复核',
    actor: '分析员 A',
    copyFrom: confirmedBatch.id,
  });
  updateAssumptions(ws, draft.id, {
    assumptions: {
      reviewStage: '数据接入完成，等待归属方法确认。',
    },
  }, { actor: '分析员 A' });

  const parallel = createDraft(ws, {
    siteId: SITE_ID,
    caliber: confirmedBatch.caliber,
    label: '并行试算：边界重述后',
    actor: '分析员 B',
    copyFrom: confirmedBatch.id,
  });
  restateBoundary(ws, parallel.id, {
    itemId: 'item-line-b',
    newBaseActivity: 5400,
    kind: 'restated',
    note: '并行试算：发现并入边界时重复计入 1000 MWh，据计量台账重述基准期。',
    actor: '分析员 B',
  });

  ws.seededAt = '2025-03-01T08:00:00.000Z';
  return {
    workspace: ws,
    primaryBatchId: draft.id,
    reportBatchId: confirmedBatch.id,
    parallelBatchId: parallel.id,
  };
}

/** 导出初始状态（CLI/测试用）。 */
export function seedExport() {
  return exportWorkspace(buildSeedState().workspace);
}
