/**
 * 版本化账本与治理规则。全部数据为虚构演示。
 *
 * 不变量：
 * 1. 已确认批次不可修改（内容哈希封存），其报告只读，只能撤回或标记被取代。
 * 2. 每个批次记录基准指纹；跨批次对照要求基准指纹完全一致（同版）。
 * 3. 基准期的追溯更正（组织边界重述、因子更正）会改变基准指纹，
 *    必须显式操作并留痕；旧任务不会自动“漂移”到新基准。
 * 4. 编辑带乐观锁（expectedHash）；并发任务不会静默覆盖彼此。
 */
import { createHash, randomUUID } from 'node:crypto';

export const SCHEMA = 'emissions-attribution-lab/1';

export const STATUS = Object.freeze({
  DRAFT: 'draft',
  CONFIRMED: 'confirmed',
  SUPERSEDED: 'superseded',
  CLOSED: 'closed',
});

export const STATUS_LABEL = Object.freeze({
  draft: '草稿',
  confirmed: '已确认',
  superseded: '已被取代',
  closed: '已关闭',
});

export class GovernanceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GovernanceError';
    this.code = code;
    this.details = details;
    this.statusCode =
      {
        NOT_FOUND: 404,
        VALIDATION: 422,
        BATCH_CONFIRMED: 409,
        STALE_BATCH: 409,
        VERSION_MISMATCH: 409,
        REPORT_IMMUTABLE: 409,
        DUPLICATE_REPORT: 409,
        IMPORT_INVALID: 422,
        PROTECTED: 403,
      }[code] ?? 400;
  }
}

const clone = (v) => JSON.parse(JSON.stringify(v));
const round = (v) => Math.round(v * 1e6) / 1e6;
const nowIso = () => new Date().toISOString();

export function sha256(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function createWorkspace({ sites = [], batches = [], reports = [], audit = [] } = {}) {
  return {
    schema: SCHEMA,
    revision: 0,
    sites: clone(sites),
    batches: clone(batches),
    reports: clone(reports),
    audit: clone(audit).slice(0, 400),
  };
}

export function touch(ws, entry) {
  ws.revision += 1;
  ws.audit.unshift({ id: randomUUID(), at: nowIso(), revision: ws.revision, ...entry });
  if (ws.audit.length > 400) ws.audit.length = 400;
}

export function findBatch(ws, batchId) {
  const batch = ws.batches.find((b) => b.id === batchId);
  if (!batch) throw new GovernanceError('NOT_FOUND', `找不到任务 ${batchId}`);
  return batch;
}

export function findReport(ws, reportId) {
  const report = ws.reports.find((r) => r.id === reportId);
  if (!report) throw new GovernanceError('NOT_FOUND', `找不到报告 ${reportId}`);
  return report;
}

/** 完整的批次内容哈希：站点、口径、快照。 */
export function batchHash(batch) {
  return sha256({ siteId: batch.siteId, caliber: batch.caliber, snapshot: batch.snapshot });
}

/**
 * 基准指纹：决定两个任务是否“同版”。
 * 只包含基准期口径下的量，不含报告期假设。
 */
export function baseFingerprint(snapshot, siteId, caliber) {
  return sha256({
    siteId,
    caliber,
    baseVersion: snapshot.baseVersion ?? 'v1',
    boundaryText: snapshot.boundaryText ?? '',
    basePeriodLabel: snapshot.basePeriodLabel ?? '',
    factors: snapshot.factors
      .map((f) => ({ id: f.id, kgPerUnit: f.kgPerUnit, version: f.baseVersion ?? '' }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    items: snapshot.items
      .map((i) => ({ id: i.id, base: i.activity?.base ?? 0 }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    boundaryChanges: snapshot.boundaryChanges ?? [],
  });
}

export function batchBaseFingerprint(batch) {
  return baseFingerprint(batch.snapshot, batch.siteId, batch.caliber);
}

/** 基准期逐字段差异，用于解释“为什么不同版”。 */
export function baseDiff(a, b) {
  const diffs = [];
  if (a.siteId !== b.siteId) diffs.push('站点不同');
  if (a.caliber !== b.caliber) diffs.push('核算口径不同');
  if ((a.snapshot.baseVersion ?? '') !== (b.snapshot.baseVersion ?? '')) {
    diffs.push(`基准版本 ${a.snapshot.baseVersion ?? 'v1'} → ${b.snapshot.baseVersion ?? 'v1'}`);
  }
  if ((a.snapshot.boundaryText ?? '') !== (b.snapshot.boundaryText ?? '')) diffs.push('组织边界描述不同');
  const fa = new Map(a.snapshot.factors.map((f) => [f.id, f]));
  for (const f of b.snapshot.factors) {
    const other = fa.get(f.id);
    if (!other) {
      diffs.push(`因子 ${f.label} 仅存在于对照任务`);
      continue;
    }
    if (other.kgPerUnit !== f.kgPerUnit) {
      diffs.push(`因子「${f.label}」基准值 ${other.kgPerUnit} → ${f.kgPerUnit} ${f.unit}`);
    }
  }
  const ia = new Map(a.snapshot.items.map((i) => [i.id, i]));
  for (const item of b.snapshot.items) {
    const other = ia.get(item.id);
    if (!other) {
      diffs.push(`活动「${item.label}」仅存在于对照任务`);
      continue;
    }
    if ((other.activity?.base ?? 0) !== (item.activity?.base ?? 0)) {
      diffs.push(`活动「${item.label}」基准量 ${other.activity?.base ?? 0} → ${item.activity?.base ?? 0} ${item.unit}`);
    }
  }
  const ca = JSON.stringify(a.snapshot.boundaryChanges ?? []);
  const cb = JSON.stringify(b.snapshot.boundaryChanges ?? []);
  if (ca !== cb) diffs.push('组织边界重述记录不同');
  return diffs;
}

function normalizeSnapshot(snapshot) {
  const s = clone(snapshot);
  s.factors ??= [];
  s.items ??= [];
  s.projects ??= [];
  s.boundaryChanges ??= [];
  s.baseVersion ??= 'v1';
  for (const item of s.items) {
    item.activity = { base: Number(item.activity?.base ?? 0), report: Number(item.activity?.report ?? 0) };
    item.projectIds = Array.isArray(item.projectIds) ? item.projectIds : [];
  }
  for (const project of s.projects) {
    project.activityReduction = Number(project.activityReduction ?? 0);
    project.itemIds = Array.isArray(project.itemIds) ? project.itemIds : [];
  }
  return s;
}

export function createDraft(ws, { siteId, caliber, label, actor, copyFrom = null }) {
  const site = ws.sites.find((s) => s.id === siteId);
  if (!site) throw new GovernanceError('NOT_FOUND', `找不到站点 ${siteId}`);
  if (!caliber?.trim()) throw new GovernanceError('VALIDATION', '核算口径不能为空');
  const source = copyFrom ? findBatch(ws, copyFrom) : null;
  if (source && source.siteId !== siteId) {
    throw new GovernanceError('VALIDATION', '复制来源与目标任务不在同一站点');
  }
  const batch = {
    id: randomUUID(),
    siteId,
    caliber: caliber.trim(),
    label: label?.trim() || '未命名复核任务',
    createdAt: nowIso(),
    createdBy: actor || '分析员',
    status: STATUS.DRAFT,
    lock: null,
    basedOn: source?.id ?? null,
    derivedFromHash: source ? batchHash(source) : null,
    snapshot: normalizeSnapshot(source ? source.snapshot : site.defaultSnapshot),
    confirmed: null,
    superseded: null,
  };
  ws.batches.push(batch);
  touch(ws, {
    action: 'batch.create',
    actor,
    batchId: batch.id,
    summary: `新建任务「${batch.label}」${source ? `（复制自「${source.label}」）` : ''}`,
  });
  return batch;
}

export function assertDraftEditable(batch) {
  if (batch.status === STATUS.CONFIRMED) {
    throw new GovernanceError('BATCH_CONFIRMED', '该任务已确认并封存，不能修改已确认报告的数据');
  }
  if (batch.status !== STATUS.DRAFT) {
    throw new GovernanceError('BATCH_CONFIRMED', `任务状态为「${STATUS_LABEL[batch.status] ?? batch.status}」，不可编辑`);
  }
  if (batch.lock) throw new GovernanceError('BATCH_CONFIRMED', '任务已锁定');
}

function checkExpectedHash(batch, expectedHash) {
  if (!expectedHash) return;
  const current = batchHash(batch);
  if (expectedHash !== current) {
    throw new GovernanceError('STALE_BATCH', '任务已被其他操作更新，请刷新后再修改', {
      expectedHash,
      currentHash: current,
    });
  }
}

const assertFiniteNonNegative = (value, field) => {
  if (!Number.isFinite(value) || value < 0) {
    throw new GovernanceError('VALIDATION', `${field} 必须是大于等于 0 的数值`);
  }
  return round(value);
};

/**
 * 修改报告期假设（活动量、报告期因子、项目申报比例）。
 * 基准期数值不在此处修改；追溯更正必须走 retroCorrect 或 boundaryRestate。
 */
export function updateAssumptions(ws, batchId, patch, { actor, expectedHash } = {}) {
  const batch = findBatch(ws, batchId);
  assertDraftEditable(batch);
  checkExpectedHash(batch, expectedHash);
  const s = batch.snapshot;
  const notes = [];

  for (const [itemId, change] of Object.entries(patch.activity ?? {})) {
    const item = s.items.find((i) => i.id === itemId);
    if (!item) throw new GovernanceError('VALIDATION', `未知活动条目 ${itemId}`);
    if (change.report !== undefined) {
      item.activity.report = assertFiniteNonNegative(Number(change.report), `「${item.label}」报告期活动`);
      notes.push(`${item.label} 报告期活动 → ${item.activity.report} ${item.unit}`);
    }
    if (change.base !== undefined) {
      throw new GovernanceError('VALIDATION', '基准期活动不可直接修改；请使用“组织边界重述”流程');
    }
  }

  for (const [factorId, change] of Object.entries(patch.factors ?? {})) {
    const factor = s.factors.find((f) => f.id === factorId);
    if (!factor) throw new GovernanceError('VALIDATION', `未知因子 ${factorId}`);
    if (change.kgPerUnit !== undefined) {
      throw new GovernanceError('VALIDATION', '基准期因子不可直接修改；请使用“因子追溯更正”流程');
    }
    if (change.reportKgPerUnit !== undefined) {
      factor.reportKgPerUnit = assertFiniteNonNegative(
        Number(change.reportKgPerUnit),
        `「${factor.label}」报告期因子`,
      );
      notes.push(`${factor.label} 报告期因子 → ${factor.reportKgPerUnit} kg/${factor.unit}`);
    }
  }

  for (const [projectId, change] of Object.entries(patch.projects ?? {})) {
    const project = s.projects.find((p) => p.id === projectId);
    if (!project) throw new GovernanceError('VALIDATION', `未知项目 ${projectId}`);
    if (change.activityReduction !== undefined) {
      const pct = Number(change.activityReduction);
      if (!Number.isFinite(pct) || pct < 0 || pct > 95) {
        throw new GovernanceError('VALIDATION', `「${project.label}」申报幅度须在 0–95% 之间`);
      }
      project.activityReduction = round(pct / 100);
      notes.push(`${project.label} 申报幅度 → ${pct}%`);
    }
    if (change.active !== undefined) {
      project.active = !!change.active;
      notes.push(`${project.label} ${project.active ? '纳入' : '排除'}归属比较`);
    }
  }

  if (patch.assumptions && typeof patch.assumptions === 'object') {
    s.assumptions = { ...(s.assumptions ?? {}), ...patch.assumptions };
    notes.push('更新假设说明');
  }

  if (notes.length === 0) throw new GovernanceError('VALIDATION', '没有可应用的修改');
  touch(ws, { action: 'batch.edit', actor, batchId, summary: notes.join('；') });
  return batch;
}

/**
 * 因子追溯更正：改变基准期因子，从而改变基准指纹。
 * 这是“同版”要求的来源之一——并行任务不会自动获得更正。
 */
export function retroCorrectFactor(ws, batchId, { factorId, baseKgPerUnit, reportKgPerUnit, note, actor, expectedHash }) {
  const batch = findBatch(ws, batchId);
  assertDraftEditable(batch);
  checkExpectedHash(batch, expectedHash);
  if (!note?.trim()) throw new GovernanceError('VALIDATION', '追溯更正必须填写依据说明');
  const factor = batch.snapshot.factors.find((f) => f.id === factorId);
  if (!factor) throw new GovernanceError('NOT_FOUND', `找不到因子 ${factorId}`);
  const oldBase = factor.kgPerUnit;
  factor.kgPerUnit = assertFiniteNonNegative(Number(baseKgPerUnit), '更正后的基准期因子');
  if (reportKgPerUnit !== undefined) {
    factor.reportKgPerUnit = assertFiniteNonNegative(Number(reportKgPerUnit), '更正后的报告期因子');
  }
  factor.retroactive = true;
  factor.retroNote = note.trim();
  factor.baseVersion = `${factor.baseVersion ?? 'v1'} → 更正 ${new Date().toISOString().slice(0, 10)}`;
  batch.snapshot.baseVersion = bumpBaseVersion(batch.snapshot.baseVersion);
  touch(ws, {
    action: 'factor.retro',
    actor,
    batchId,
    summary: `因子「${factor.label}」基准值 ${oldBase} → ${factor.kgPerUnit} kg/${factor.unit}；${note.trim()}`,
  });
  return batch;
}

function bumpBaseVersion(current = 'v1') {
  const match = /^v(\d+)/.exec(current);
  return match ? `v${Number(match[1]) + 1}` : `${current}·r${Date.now().toString(36)}`;
}

/**
 * 组织边界重述：调整基准期某活动量并记录原因。
 * 重述后的基准指纹变化，与旧任务不再同版。
 */
export function restateBoundary(ws, batchId, { itemId, newBaseActivity, kind = 'restated', note, actor, expectedHash }) {
  const batch = findBatch(ws, batchId);
  assertDraftEditable(batch);
  checkExpectedHash(batch, expectedHash);
  if (!note?.trim()) throw new GovernanceError('VALIDATION', '组织边界调整必须填写原因');
  const item = batch.snapshot.items.find((i) => i.id === itemId);
  if (!item) throw new GovernanceError('NOT_FOUND', `找不到活动条目 ${itemId}`);
  if (!['added', 'removed', 'restated'].includes(kind)) {
    throw new GovernanceError('VALIDATION', '边界调整类型须为 added / removed / restated');
  }
  const old = item.activity.base;
  item.activity.base = assertFiniteNonNegative(Number(newBaseActivity), '重述后的基准期活动');
  batch.snapshot.boundaryChanges = [
    ...(batch.snapshot.boundaryChanges ?? []),
    {
      id: randomUUID(),
      itemId,
      kind,
      note: note.trim(),
      at: nowIso(),
      fromActivity: old,
      toActivity: item.activity.base,
    },
  ];
  batch.snapshot.baseVersion = bumpBaseVersion(batch.snapshot.baseVersion);
  touch(ws, {
    action: 'boundary.restate',
    actor,
    batchId,
    summary: `基准期「${item.label}」${old} → ${item.activity.base} ${item.unit}（${note.trim()}）`,
  });
  return batch;
}

/** 把另一任务的基准内容同步到本任务（解决不同版问题的唯一方式）。 */
export function rebaseDraft(ws, batchId, { sourceBatchId, actor, expectedHash }) {
  const batch = findBatch(ws, batchId);
  assertDraftEditable(batch);
  checkExpectedHash(batch, expectedHash);
  const source = findBatch(ws, sourceBatchId);
  if (source.siteId !== batch.siteId || source.caliber !== batch.caliber) {
    throw new GovernanceError('VALIDATION', '只能在同一站点、同一口径的任务之间同步基准');
  }
  if (batchBaseFingerprint(batch) === batchBaseFingerprint(source)) {
    throw new GovernanceError('VALIDATION', '两个任务的基准已经同版，无需同步');
  }
  const fromFingerprint = batchBaseFingerprint(batch);
  const reportState = new Map(
    batch.snapshot.items.map((i) => [i.id, { report: i.activity?.report ?? 0, projectIds: [...(i.projectIds ?? [])] }]),
  );
  const reportFactors = new Map(
    batch.snapshot.factors.map((f) => [f.id, { reportKgPerUnit: f.reportKgPerUnit, retroactive: f.retroactive, retroNote: f.retroNote }]),
  );
  const reportProjects = new Map(
    batch.snapshot.projects.map((p) => [p.id, { activityReduction: p.activityReduction, active: p.active }]),
  );
  const ownAssumptions = { ...(batch.snapshot.assumptions ?? {}) };
  const ownIngestions = batch.snapshot.ingestions ?? [];

  const synced = normalizeSnapshot(source.snapshot);
  for (const item of synced.items) {
    const own = reportState.get(item.id);
    if (own) {
      item.activity.report = own.report;
      item.projectIds = own.projectIds;
    }
  }
  for (const factor of synced.factors) {
    const own = reportFactors.get(factor.id);
    if (own?.reportKgPerUnit !== undefined) factor.reportKgPerUnit = own.reportKgPerUnit;
    if (own?.retroactive) {
      factor.retroactive = own.retroactive;
      factor.retroNote = own.retroNote;
    }
  }
  for (const project of synced.projects) {
    const own = reportProjects.get(project.id);
    if (own) Object.assign(project, own);
  }
  synced.assumptions = { ...(synced.assumptions ?? {}), ...ownAssumptions };
  synced.ingestions = ownIngestions;
  batch.snapshot = synced;
  batch.basedOn = source.id;
  batch.derivedFromHash = batchHash(source);
  touch(ws, {
    action: 'batch.rebase',
    actor,
    batchId,
    summary: `基准同步自「${source.label}」；原基准指纹 ${fromFingerprint.slice(0, 10)}… → ${batchBaseFingerprint(source).slice(0, 10)}…`,
  });
  return batch;
}

/**
 * 单行 CSV 解析：支持双引号包裹的字段（如 "2,350"）与转义引号 ""。
 * 不使用第三方库，避免为演示引入依赖。
 */
function parseCsvLine(line) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

/** 数值列的宽松解析：允许千分位逗号与全角空格。 */
const parseNumber = (raw) => {
  const cleaned = String(raw ?? '')
    .replaceAll(',', '')
    .replaceAll('，', '')
    .replaceAll(' ', '')
    .trim();
  if (cleaned === '') return NaN;
  return Number(cleaned);
};

/**
 * 解析 CSV 文本。格式：itemId,period,activity（表头可选，允许 # 注释与空行）。
 * 只接受报告期数据；基准期数据属于治理流程，不能在此接入。
 */
export function parseActivityCsv(text) {
  const rows = [];
  const problems = [];
  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const cells = parseCsvLine(trimmed);
    if (/^item[\s_-]?id$/i.test(cells[0])) return;
    if (cells.length < 3) {
      problems.push(`第 ${index + 1} 行：需要 3 列（itemId,period,activity）`);
      return;
    }
    const [itemId, period, rawActivity] = cells;
    if (!itemId) {
      problems.push(`第 ${index + 1} 行：缺少 itemId`);
      return;
    }
    if (period !== 'report') {
      problems.push(`第 ${index + 1} 行：期间为「${period}」；数据接入只接受 report（基准期请使用组织边界重述或因子追溯更正）`);
      return;
    }
    const activity = parseNumber(rawActivity);
    if (!Number.isFinite(activity) || activity < 0) {
      problems.push(`第 ${index + 1} 行：活动量「${rawActivity}」不是非负数`);
      return;
    }
    rows.push({ itemId, period, activity, line: index + 1 });
  });
  return { rows, problems };
}

/**
 * 数据接入：把外部台账（CSV）写入草稿的报告期活动。
 * - 仅草稿、带乐观锁；
 * - 只允许报告期；基准期必须走治理流程；
 * - 记录来源、行数、变更行数与内容哈希，供审计与导出后追溯。
 */
export function ingestActivity(ws, batchId, { csv, sourceLabel, note, actor, expectedHash }) {
  const batch = findBatch(ws, batchId);
  assertDraftEditable(batch);
  checkExpectedHash(batch, expectedHash);
  if (!sourceLabel?.trim()) throw new GovernanceError('VALIDATION', '数据接入必须填写来源说明');
  const { rows, problems } = parseActivityCsv(csv);
  if (problems.length > 0) {
    throw new GovernanceError('VALIDATION', `数据文件有 ${problems.length} 处问题`, { problems });
  }
  if (rows.length === 0) throw new GovernanceError('VALIDATION', '数据文件没有可接入的数据行');

  const seen = new Set();
  const changes = [];
  for (const row of rows) {
    const item = batch.snapshot.items.find((i) => i.id === row.itemId);
    if (!item) {
      throw new GovernanceError('VALIDATION', `第 ${row.line} 行：未知活动条目 ${row.itemId}`, {
        itemId: row.itemId,
      });
    }
    if (seen.has(row.itemId)) continue; // 同一文件内重复行：以最后一行为准
    seen.add(row.itemId);
    const from = item.activity.report;
    item.activity.report = round(row.activity);
    if (from !== item.activity.report) {
      changes.push({ itemId: item.id, label: item.label, from, to: item.activity.report, unit: item.unit });
    }
  }

  const ingestion = {
    id: randomUUID(),
    at: nowIso(),
    by: actor || '分析员',
    sourceLabel: sourceLabel.trim(),
    note: note?.trim() || '',
    rowCount: rows.length,
    changedCount: changes.length,
    rowsHash: sha256(rows.map((r) => ({ itemId: r.itemId, activity: r.activity }))),
  };
  batch.snapshot.ingestions = [...(batch.snapshot.ingestions ?? []), ingestion];
  touch(ws, {
    action: 'data.ingest',
    actor,
    batchId,
    summary: `接入「${ingestion.sourceLabel}」：${rows.length} 行，改动 ${changes.length} 条活动；基准未变`,
  });
  return { batch, ingestion, changes };
}

/** 导出当前任务的活动数据模板（含两期数值与条目说明）。 */
export function activityCsv(batch) {
  const escape = (value) => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const header = 'itemId,period,activity,label,unit';
  const lines = batch.snapshot.items.map((item) =>
    [item.id, 'report', item.activity.report, item.label, item.unit].map(escape).join(','),
  );
  return [header, ...lines].join('\n') + '\n';
}

/** 确认批次并出具报告。 */
export function confirmBatch(ws, batchId, { actor, reportLabel, method, expectedHash }) {
  const batch = findBatch(ws, batchId);
  if (batch.status === STATUS.CONFIRMED) {
    throw new GovernanceError('DUPLICATE_REPORT', '该任务已有确认报告，不能重复出具');
  }
  assertDraftEditable(batch);
  checkExpectedHash(batch, expectedHash);
  if (!reportLabel?.trim()) throw new GovernanceError('VALIDATION', '报告名称不能为空');
  if (!method) throw new GovernanceError('VALIDATION', '必须选择一个归属方法');
  const hash = batchHash(batch);
  const fingerprint = batchBaseFingerprint(batch);
  const at = nowIso();
  batch.status = STATUS.CONFIRMED;
  batch.lock = 'immutable';
  batch.confirmed = { at, by: actor || '分析员', hash, baseFingerprint: fingerprint, method };
  const report = {
    id: randomUUID(),
    batchId,
    siteId: batch.siteId,
    caliber: batch.caliber,
    label: reportLabel.trim(),
    method,
    hash,
    baseFingerprint: fingerprint,
    issuedAt: at,
    issuedBy: actor || '分析员',
    status: 'issued',
    supersededBy: null,
    supersededReason: null,
    retractedAt: null,
    retractedBy: null,
    retractedReason: null,
  };
  ws.reports.push(report);
  touch(ws, {
    action: 'report.issue',
    actor,
    batchId,
    reportId: report.id,
    summary: `出具报告「${report.label}」，方法 ${method}，内容哈希 ${hash.slice(0, 12)}…`,
  });
  return report;
}

export function retractReport(ws, reportId, { actor, reason }) {
  const report = findReport(ws, reportId);
  if (report.status !== 'issued') {
    throw new GovernanceError('REPORT_IMMUTABLE', '只有“已出具”的报告可以撤回；报告内容本身不可编辑');
  }
  if (!reason?.trim()) throw new GovernanceError('VALIDATION', '撤回报告必须填写原因');
  report.status = 'retracted';
  report.retractedAt = nowIso();
  report.retractedBy = actor || '分析员';
  report.retractedReason = reason.trim();
  touch(ws, {
    action: 'report.retract',
    actor,
    reportId,
    batchId: report.batchId,
    summary: `撤回报告「${report.label}」：${reason.trim()}`,
  });
  return report;
}

/** 追溯更正一个已确认批次：旧批次/旧报告保持不变，另建新草稿。 */
export function supersedeBatch(ws, batchId, { actor, reason }) {
  const batch = findBatch(ws, batchId);
  if (batch.status !== STATUS.CONFIRMED) {
    throw new GovernanceError('VALIDATION', '只有已确认任务可以发起追溯更正');
  }
  if (!reason?.trim()) throw new GovernanceError('VALIDATION', '追溯更正必须填写原因');
  const previousHash = batch.confirmed.hash;
  batch.status = STATUS.SUPERSEDED;
  batch.superseded = { at: nowIso(), by: actor || '分析员', reason: reason.trim(), previousHash };
  const replacement = {
    id: randomUUID(),
    siteId: batch.siteId,
    caliber: batch.caliber,
    label: `${batch.label}（追溯更正）`,
    createdAt: nowIso(),
    createdBy: actor || '分析员',
    status: STATUS.DRAFT,
    lock: null,
    basedOn: batch.id,
    derivedFromHash: previousHash,
    snapshot: normalizeSnapshot(batch.snapshot),
    confirmed: null,
    superseded: null,
  };
  // 更正草稿冻结原确认哈希，便于在 UI 中对照“改了什么”。
  replacement.snapshot.assumptions = {
    ...(replacement.snapshot.assumptions ?? {}),
    correctionOf: { batchId: batch.id, hash: previousHash, reason: reason.trim() },
  };
  ws.batches.push(replacement);
  for (const report of ws.reports) {
    if (report.batchId === batch.id && report.status === 'issued') {
      report.supersededBy = replacement.id;
      report.supersededReason = reason.trim();
    }
  }
  touch(ws, {
    action: 'batch.supersede',
    actor,
    batchId: batch.id,
    summary: `取代任务「${batch.label}」，创建更正草稿「${replacement.label}」：${reason.trim()}`,
  });
  return replacement;
}

/** 关闭草稿（不产生报告）。 */
export function closeDraft(ws, batchId, { actor, reason }) {
  const batch = findBatch(ws, batchId);
  if (batch.status !== STATUS.DRAFT) {
    throw new GovernanceError('VALIDATION', '只有草稿可以关闭');
  }
  batch.status = STATUS.CLOSED;
  batch.closed = { at: nowIso(), by: actor || '分析员', reason: reason?.trim() || '主动关闭' };
  touch(ws, { action: 'batch.close', actor, batchId, summary: `关闭草稿「${batch.label}」` });
  return batch;
}

function validateImported(parsed) {
  if (!parsed || parsed.schema !== SCHEMA) {
    throw new GovernanceError('IMPORT_INVALID', '不是本工具的导出文件（schema 不匹配）');
  }
  if (!Array.isArray(parsed.sites) || !Array.isArray(parsed.batches) || !Array.isArray(parsed.reports)) {
    throw new GovernanceError('IMPORT_INVALID', '导入文件缺少 sites/batches/reports');
  }
  const problems = [];
  const ids = new Set();
  for (const batch of parsed.batches) {
    if (ids.has(batch.id)) problems.push(`任务 ID 重复：${batch.id}`);
    ids.add(batch.id);
    if (!parsed.sites.some((s) => s.id === batch.siteId)) problems.push(`任务「${batch.label}」引用不存在的站点`);
    if (batch.status === STATUS.CONFIRMED && batch.confirmed) {
      if (batchHash(batch) !== batch.confirmed.hash) problems.push(`任务「${batch.label}」内容与确认哈希不符`);
      if (batchBaseFingerprint(batch) !== batch.confirmed.baseFingerprint) {
        problems.push(`任务「${batch.label}」基准期内容与确认时的基准指纹不符`);
      }
    }
  }
  for (const report of parsed.reports) {
    const batch = parsed.batches.find((b) => b.id === report.batchId);
    if (!batch) problems.push(`报告「${report.label}」引用不存在的任务`);
    else if (report.hash !== batch.confirmed?.hash) problems.push(`报告「${report.label}」哈希与任务不符`);
  }
  if (problems.length > 0) throw new GovernanceError('IMPORT_INVALID', problems.join('；'), { problems });
}

export function importWorkspace(raw, { actor } = {}) {
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : clone(raw);
  } catch {
    throw new GovernanceError('IMPORT_INVALID', '文件不是合法的 JSON');
  }
  validateImported(parsed);
  const ws = createWorkspace(parsed);
  ws.revision = Number.isFinite(parsed.revision) ? parsed.revision : 0;
  touch(ws, { action: 'workspace.import', actor, summary: '从导出文件恢复工作区' });
  return ws;
}

export function exportWorkspace(ws) {
  return {
    ...clone(ws),
    exportedAt: nowIso(),
    notice: '虚构演示数据；不代表任何真实排放声明或认证结论。',
  };
}

export function stateSummary(ws) {
  return {
    schema: ws.schema,
    revision: ws.revision,
    sites: ws.sites.map((s) => ({
      id: s.id,
      name: s.name,
      sector: s.sector,
      boundaryText: s.boundaryText,
    })),
    batches: ws.batches
      .map((b) => ({
        id: b.id,
        siteId: b.siteId,
        caliber: b.caliber,
        label: b.label,
        createdAt: b.createdAt,
        createdBy: b.createdBy,
        status: b.status,
        statusLabel: STATUS_LABEL[b.status] ?? b.status,
        basedOn: b.basedOn,
        derivedFromHash: b.derivedFromHash ?? null,
        baseVersion: b.snapshot.baseVersion ?? 'v1',
        baseFingerprint: batchBaseFingerprint(b),
        contentHash: batchHash(b),
        confirmed: b.confirmed
          ? { at: b.confirmed.at, by: b.confirmed.by, method: b.confirmed.method, hash: b.confirmed.hash }
          : null,
        superseded: b.superseded ?? null,
        closed: b.closed ?? null,
        reportId: ws.reports.find((r) => r.batchId === b.id)?.id ?? null,
      }))
      .sort((a, b) => {
        const rank = { draft: 0, confirmed: 1, superseded: 2, closed: 3 };
        return rank[a.status] - rank[b.status] || b.createdAt.localeCompare(a.createdAt);
      }),
    seededAt: ws.seededAt ?? null,
    reports: ws.reports.map((r) => ({ ...r })),
    audit: ws.audit.slice(0, 60),
  };
}
