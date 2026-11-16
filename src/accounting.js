/**
 * 排放核算与项目归属（全部为虚构数据，仅用于演示方法与治理）。
 *
 * 模型：
 *   条目 item = { id, label, unit, factorId, activity: {base, report}, projectIds[] }
 *   因子 factor = { kgPerUnit: 基准期版本, reportKgPerUnit: 报告期版本 }
 *
 *   E0 = Σ 基准活动 × 基准因子            实际基准排放
 *   E1 = Σ 报告活动 × 报告期因子          实际报告排放
 *   D  = E0 − E1                          实际变化（正数 = 减排）
 *
 * 项目效应按申报幅度构造反事实：
 *   aExp(item, S) = 基准活动 × Π_{i∈S∩linked}(1 − r_i)
 *   E(S) = Σ aExp(item, S) × 报告期因子
 *   B = E(∅) = Σ 基准活动 × 报告期因子    「项目全不实施」的基线估算
 *   P = B − E(N)                          全部项目联合的项目效应
 *   O = E(N) − E1                         项目未解释的活动变化（可正可负）
 *   F = E0 − B                            因子更新效应（基准活动上的因子差）
 *
 * 恒等式：D = P + O + F（无截断时精确成立）。
 *
 * 单独效应 s_i = B − E({i})。乘性叠加下 Σs_i ≥ P，差额即两个项目对同一
 * 变化重复申报的交互作用；它绝不能通过“两份申报直接相加”再次计入。
 *
 * 归属方法只分配 P，不分配 D：
 *   - 顺序优先：依次从 P 中扣各自申报量，结果依赖顺序；
 *   - 比例分摊：按 s_i 占比分 P；
 *   - Shapley：对 v(S)=B−E(S) 取平均边际贡献，与顺序无关且合计恰为 P；
 *   - 保守归属：只给每个项目的边际贡献 E(N∖i)−E(N)，重叠部分不归属。
 */
import { createHash } from 'node:crypto';

export const EPS = 1e-9;

export const METHODS = Object.freeze({
  priority: {
    key: 'priority',
    label: '按申报顺序优先扣除',
    short: '顺序优先',
    note: '各项目按申报顺位依次从项目总效应中取走自己的申报量，后申报者只能拿剩余。结果依赖申报顺序。',
    orderFree: false,
    interactionHandling: '先申报者先拿满，重叠影响后申报者',
    caution: '必须冻结申报顺位；换一个顺序，归属就会变。',
  },
  proportional: {
    key: 'proportional',
    label: '按单独效应比例分摊',
    short: '比例分摊',
    note: '按各项目单独效应占单独效应之和的比例分摊项目总效应。交互作用按比例分给各项目，与顺序无关。',
    orderFree: true,
    interactionHandling: '重叠部分按单独效应比例分给各项目',
    caution: '重叠越大，两个项目的可归属量都被同比例压缩，容易掩盖重叠本身。',
  },
  shapley: {
    key: 'shapley',
    label: 'Shapley 对称分摊',
    short: 'Shapley',
    note: '取各项目在所有申报组合中的平均边际贡献。与顺序无关，交互作用对称拆分，合计恰为项目总效应。',
    orderFree: true,
    interactionHandling: '按所有申报组合的平均边际贡献对称拆分',
    caution: '分摊结果依赖“每个项目单独实施”的反事实假设；假设本身仍可争论。',
  },
  residual: {
    key: 'residual',
    label: '保守归属（重叠部分不归属任何一方）',
    short: '保守归属',
    note: '只把每个项目在其它项目均已实施前提下的增量效应计入项目；被重复申报的重叠部分单列为“不归属”。',
    orderFree: true,
    interactionHandling: '重叠部分不归属，单列披露',
    caution: '项目合计会低于项目总效应，差额必须明确披露，不能悄悄丢弃。',
  },
});

export const METHOD_KEYS = Object.freeze(Object.keys(METHODS));

const round = (value) => {
  const r = Math.round(value * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
};

export const factorIndex = (snapshot) => new Map(snapshot.factors.map((f) => [f.id, f]));
export const projectIndex = (snapshot) => new Map(snapshot.projects.map((p) => [p.id, p]));

export function activeProjects(snapshot) {
  return snapshot.projects.filter((p) => p.active !== false);
}

const reportFactor = (factor) =>
  Number.isFinite(factor.reportKgPerUnit) ? factor.reportKgPerUnit : factor.kgPerUnit;

/** 某条目在项目集合 S 实施后的预期活动。 */
export function expectedActivity(item, implemented, projectMap) {
  const linked = (item.projectIds ?? []).filter((id) => implemented.has(id));
  let retained = 1;
  for (const id of linked) {
    const project = projectMap.get(id);
    if (!project) continue;
    const r = Math.min(0.95, Math.max(0, project.activityReduction ?? 0));
    retained *= 1 - r;
  }
  return {
    activity: (item.activity?.base ?? 0) * retained,
    retained,
    projects: linked,
  };
}

/** 实际排放：period='base' 用基准因子，'report' 用报告期因子。 */
export function periodEmissions(snapshot, period) {
  const factors = factorIndex(snapshot);
  if (!['base', 'report'].includes(period)) throw new Error(`未知期间 ${period}`);
  let total = 0;
  const rows = [];
  for (const item of snapshot.items) {
    const factor = factors.get(item.factorId);
    if (!factor) throw new Error(`活动「${item.label}」引用了不存在的因子 ${item.factorId}`);
    const activity = item.activity?.[period] ?? 0;
    const kgPerUnit = period === 'base' ? factor.kgPerUnit : reportFactor(factor);
    const kg = activity * kgPerUnit;
    total += kg;
    rows.push({ itemId: item.id, label: item.label, activity, factorId: factor.id, kg });
  }
  return { kg: round(total), rows };
}

export function actualDeltaKg(snapshot) {
  return round(periodEmissions(snapshot, 'base').kg - periodEmissions(snapshot, 'report').kg);
}

/** 给定“已实施项目集合”的预期报告期活动所对应的排放（报告期因子）。 */
export function expectedEmissionsKg(snapshot, implementedIds) {
  const factors = factorIndex(snapshot);
  const pm = projectIndex(snapshot);
  const implemented = new Set(implementedIds);
  let total = 0;
  for (const item of snapshot.items) {
    const factor = factors.get(item.factorId);
    if (!factor) throw new Error(`活动「${item.label}」引用了不存在的因子 ${item.factorId}`);
    total += expectedActivity(item, implemented, pm).activity * reportFactor(factor);
  }
  return round(total);
}

/** 基线估算 B：所有项目都不实施时，按报告期因子计算的报告期排放。 */
export function baselineEstimateKg(snapshot) {
  return expectedEmissionsKg(snapshot, []);
}

/** 项目总效应 P：基线估算 − 全部项目都实施后的预期排放。 */
export function projectPoolKg(snapshot) {
  return round(baselineEstimateKg(snapshot) - expectedEmissionsKg(snapshot, activeProjects(snapshot).map((p) => p.id)));
}

/** 单独效应：只有项目 i 实施时的减排量。 */
export function standaloneEffectKg(snapshot, projectId) {
  const base = baselineEstimateKg(snapshot);
  return round(base - expectedEmissionsKg(snapshot, [projectId]));
}

/**
 * 实际变化的两路拆分（精确）：
 *   活动效应 A = Σ (基准活动 − 报告活动) × 报告期因子
 *   因子效应 F = Σ (基准因子 − 报告期因子) × 基准活动
 *   D = A + F
 * 另按因子给出明细，便于解释“因子追溯更新”与“真实活动变化”。
 */
export function decomposeDelta(snapshot) {
  const factors = factorIndex(snapshot);
  let activityEffect = 0;
  let factorEffect = 0;
  const byFactor = new Map();
  for (const item of snapshot.items) {
    const factor = factors.get(item.factorId);
    const a0 = item.activity?.base ?? 0;
    const a1 = item.activity?.report ?? 0;
    const f0 = factor.kgPerUnit;
    const f1 = reportFactor(factor);
    const act = (a0 - a1) * f1;
    const fac = (f0 - f1) * a0;
    activityEffect += act;
    factorEffect += fac;
    const entry = byFactor.get(factor.id) ?? {
      factorId: factor.id,
      factorLabel: factor.label,
      unit: factor.unit,
      baseKgPerUnit: f0,
      reportKgPerUnit: f1,
      baseVersion: factor.baseVersion ?? null,
      reportVersion: factor.reportVersion ?? null,
      activityEffectKg: 0,
      factorEffectKg: 0,
    };
    entry.activityEffectKg += act;
    entry.factorEffectKg += fac;
    byFactor.set(factor.id, entry);
  }
  const total = round(activityEffect + factorEffect);
  return {
    totalKg: total,
    activityEffectKg: round(activityEffect),
    factorEffectKg: round(factorEffect),
    byFactor: [...byFactor.values()]
      .map((e) => ({
        ...e,
        activityEffectKg: round(e.activityEffectKg),
        factorEffectKg: round(e.factorEffectKg),
      }))
      .sort((a, b) => Math.abs(b.factorEffectKg) - Math.abs(a.factorEffectKg)),
  };
}

/** 组织边界调整对基准期的影响；重述部分不得计入项目归属。 */
export function boundaryImpact(snapshot) {
  const factors = factorIndex(snapshot);
  const entries = snapshot.boundaryChanges ?? [];
  let baseRemoved = 0;
  let baseAdded = 0;
  const rows = [];
  for (const entry of entries) {
    const item = snapshot.items.find((i) => i.id === entry.itemId);
    if (!item) continue;
    const factor = factors.get(item.factorId);
    // 用记录下来的调整前后活动量计算净重述量，避免同一基准量被多条记录重复计入。
    const from = Number.isFinite(entry.fromActivity) ? entry.fromActivity : item.activity?.base ?? 0;
    const to = Number.isFinite(entry.toActivity) ? entry.toActivity : item.activity?.base ?? 0;
    const delta = (to - from) * factor.kgPerUnit;
    if (entry.kind === 'removed') baseRemoved += Math.abs(delta);
    else if (entry.kind === 'added') baseAdded += Math.abs(delta);
    else if (delta >= 0) baseAdded += delta;
    else baseRemoved += -delta;
    rows.push({
      ...entry,
      label: item.label,
      fromActivity: from,
      toActivity: to,
      kg: round(delta * 1000) / 1000,
    });
  }
  return {
    entries: rows,
    baseRemovedKg: round(baseRemoved),
    baseAddedKg: round(baseAdded),
    netRestatedBaseKg: round(baseAdded - baseRemoved),
    note: entries.length
      ? '基准期已按现行边界重述；重述部分不得计入任何项目归属，也不应与活动效应重复计算。'
      : '未记录组织边界调整，两期按同一组织边界比较。',
  };
}

/** 因子版本/追溯更正提示。 */
export function factorLineageWarnings(snapshot) {
  const warnings = [];
  const seen = new Map();
  for (const factor of snapshot.factors) {
    const key = `${factor.label}|${factor.unit}`;
    if (seen.has(key)) warnings.push(`因子「${factor.label}」存在多个条目，请确认各活动条目引用同一版本`);
    seen.set(key, factor);
    if (factor.baseVersion && factor.reportVersion && factor.baseVersion !== factor.reportVersion) {
      warnings.push(
        `因子「${factor.label}」基准期 ${factor.baseVersion} → 报告期 ${factor.reportVersion}；因子更新效应已单列`,
      );
    }
    if (factor.retroactive && !factor.retroNote) {
      warnings.push(`因子「${factor.label}」标记为追溯更正但缺少说明`);
    }
  }
  return [...new Set(warnings)];
}

const popcount = (x) => {
  let count = 0;
  for (let v = x; v; v &= v - 1) count += 1;
  return count;
};

/** 精确 Shapley：v(S) = B − E(S)，v(∅)=0，Σφ = P。 */
export function shapleyValues(snapshot, ids) {
  const n = ids.length;
  if (n === 0) return {};
  if (n > 8) throw new Error('项目数超过 8 时 Shapley 计算成本过高，请改用其它方法');
  const baseline = baselineEstimateKg(snapshot);
  const cache = new Map();
  const value = (mask) => {
    if (cache.has(mask)) return cache.get(mask);
    const subset = ids.filter((_, i) => mask & (1 << i));
    const v = baseline - expectedEmissionsKg(snapshot, subset);
    cache.set(mask, v);
    return v;
  };
  const fact = [1];
  for (let i = 1; i <= n; i += 1) fact[i] = fact[i - 1] * i;
  const result = {};
  ids.forEach((id, i) => {
    let phi = 0;
    for (let mask = 0; mask < 1 << n; mask += 1) {
      if (mask & (1 << i)) continue;
      const size = popcount(mask);
      const weight = (fact[size] * fact[n - size - 1]) / fact[n];
      phi += weight * (value(mask | (1 << i)) - value(mask));
    }
    result[id] = round(phi);
  });
  return result;
}

/**
 * 具体的重复贡献：逐活动条目拆开。
 * 对每个被 ≥2 个项目关联的条目：
 *   单独贡献_i = 基准活动 × r_i × 报告期因子
 *   联合贡献   = 基准活动 × (1 − Π(1 − r_i)) × 报告期因子
 *   重复贡献   = Σ 单独贡献_i − 联合贡献
 * 这样用户能看到“重叠究竟落在哪条活动、金额是多少”。
 */
export function overlapDetails(snapshot, ids) {
  const factors = factorIndex(snapshot);
  const pm = projectIndex(snapshot);
  const active = new Set(ids);
  const rows = [];
  for (const item of snapshot.items) {
    const linked = (item.projectIds ?? []).filter((id) => active.has(id) && pm.has(id));
    if (linked.length < 2) continue;
    const factor = factors.get(item.factorId);
    const a0 = item.activity?.base ?? 0;
    const perProject = {};
    let retained = 1;
    for (const id of linked) {
      const r = Math.min(0.95, Math.max(0, pm.get(id).activityReduction ?? 0));
      perProject[id] = round(a0 * r * reportFactor(factor));
      retained *= 1 - r;
    }
    const joint = round(a0 * (1 - retained) * reportFactor(factor));
    const sumAlone = round(Object.values(perProject).reduce((sum, v) => sum + v, 0));
    rows.push({
      itemId: item.id,
      itemLabel: item.label,
      unit: item.unit,
      baseActivity: a0,
      factorId: factor.id,
      factorLabel: factor.label,
      projectIds: linked,
      perProject,
      sumAloneKg: sumAlone,
      jointKg: joint,
      overlapKg: round(sumAlone - joint),
    });
  }
  return rows.sort((a, b) => b.overlapKg - a.overlapKg);
}

function permutations(items) {
  if (items.length <= 1) return [items];
  const result = [];
  items.forEach((head, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const tail of permutations(rest)) result.push([head, ...tail]);
  });
  return result;
}

/** 顺序依赖：所有申报顺序下优先扣除法的分配。 */
export function priorityOrders(ids, pool, standalone) {
  if (ids.length > 4) return [];
  return permutations(ids).map((order) => {
    let remaining = pool;
    const allocation = {};
    for (const id of order) {
      const take = Math.max(0, Math.min(remaining, Math.max(0, standalone[id] ?? 0)));
      allocation[id] = round(take);
      remaining = round(remaining - take);
    }
    return {
      order,
      allocation,
      unallocatedKg: round(remaining),
      firstKg: allocation[order[0]] ?? 0,
      lastKg: allocation[order[order.length - 1]] ?? 0,
    };
  });
}

/**
 * 归属比较入口。关系恒等式：
 *   allocatedTotalKg + interactionUnallocatedKg = projectPoolKg
 *   projectPoolKg + otherActivityKg + factorEffectKg = deltaKg
 *   unattributedKg = otherActivityKg + interactionUnallocatedKg
 */
export function attribute(snapshot, methodKey = 'priority') {
  if (!METHODS[methodKey]) throw new Error(`未知归属方法 ${methodKey}`);
  const projects = activeProjects(snapshot);
  const ids = projects.map((p) => p.id);
  const baseEmissions = periodEmissions(snapshot, 'base').kg;
  const reportEmissions = periodEmissions(snapshot, 'report').kg;
  const delta = round(baseEmissions - reportEmissions);
  const baseline = baselineEstimateKg(snapshot);
  const withAll = expectedEmissionsKg(snapshot, ids);
  const pool = round(baseline - withAll);
  const otherActivity = round(withAll - reportEmissions);
  const factorEffect = round(baseEmissions - baseline);

  const standalone = Object.fromEntries(
    projects.map((p) => [p.id, standaloneEffectKg(snapshot, p.id)]),
  );
  const standaloneSum = round(ids.reduce((sum, id) => sum + Math.max(0, standalone[id]), 0));

  const allocations = {};
  const rationale = {};

  if (methodKey === 'priority') {
    let remaining = Math.max(0, pool);
    ids.forEach((id, index) => {
      const claim = Math.max(0, standalone[id]);
      const take = Math.max(0, Math.min(remaining, claim));
      allocations[id] = round(take);
      remaining = round(remaining - take);
      rationale[id] = `第 ${index + 1} 顺位申报：单独效应 ${round(claim)} kg，在剩余项目效应中取得 ${round(take)} kg`;
    });
  } else if (methodKey === 'proportional') {
    const usable = Math.max(0, pool);
    const denom = ids.reduce((sum, id) => sum + Math.max(0, standalone[id]), 0);
    ids.forEach((id) => {
      const share = denom > 0 ? Math.max(0, standalone[id]) / denom : 0;
      allocations[id] = round(usable * share);
      rationale[id] = `单独效应占全部单独效应的 ${(share * 100).toFixed(1)}%，分摊项目总效应 ${allocations[id]} kg`;
    });
  } else if (methodKey === 'shapley') {
    const values = shapleyValues(snapshot, ids);
    ids.forEach((id) => {
      allocations[id] = values[id] ?? 0;
      rationale[id] =
        ids.length > 1
          ? `在所有 ${ids.length} 个项目的实施组合中取平均边际贡献 ${allocations[id]} kg；与顺序无关`
          : `唯一项目时等于单独效应 ${allocations[id]} kg`;
    });
  } else if (methodKey === 'residual') {
    ids.forEach((id) => {
      const others = ids.filter((other) => other !== id);
      const without = expectedEmissionsKg(snapshot, others);
      const marginal = round(without - withAll);
      allocations[id] = marginal;
      rationale[id] = `其它项目均已实施时，本项目的增量效应为 ${marginal} kg；与单独效应 ${standalone[id]} kg 的差额属于重叠申报，不归属任何一方`;
    });
  }

  let allocatedTotal = round(ids.reduce((sum, id) => sum + allocations[id], 0));
  const cap = Math.max(0, pool);
  if (allocatedTotal > cap + EPS) {
    const scale = cap > 0 ? cap / allocatedTotal : 0;
    ids.forEach((id) => {
      allocations[id] = round(allocations[id] * scale);
      rationale[id] = `${rationale[id]}；因总和超过项目总效应，按 ${(scale * 100).toFixed(1)}% 压缩`;
    });
    allocatedTotal = round(ids.reduce((sum, id) => sum + allocations[id], 0));
  }
  if (allocatedTotal < 0) allocatedTotal = 0;

  const interactionUnallocated = round(Math.max(0, pool) - allocatedTotal);
  const unattributed = round(otherActivity + interactionUnallocated);

  const combos = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const pair = [ids[i], ids[j]];
      const joint = round(baseline - expectedEmissionsKg(snapshot, pair));
      const sumAlone = round(Math.max(0, standalone[ids[i]]) + Math.max(0, standalone[ids[j]]));
      combos.push({
        projectIds: pair,
        jointEffectKg: joint,
        standaloneSumKg: sumAlone,
        interactionKg: round(sumAlone - joint),
      });
    }
  }

  return {
    method: methodKey,
    methodMeta: METHODS[methodKey],
    deltaKg: delta,
    baseKg: baseEmissions,
    reportKg: reportEmissions,
    baselineEstimateKg: baseline,
    withAllProjectsKg: withAll,
    projectPoolKg: pool,
    otherActivityKg: otherActivity,
    factorEffectKg: factorEffect,
    allocatedTotalKg: allocatedTotal,
    interactionUnallocatedKg: interactionUnallocated,
    unattributedKg: unattributed,
    standalone,
    standaloneSumKg: standaloneSum,
    interactionKg: round(standaloneSum - Math.max(0, pool)),
    allocations: Object.fromEntries(ids.map((id) => [id, round(allocations[id])])),
    rationale,
    combos,
    overlaps: overlapDetails(snapshot, ids),
    orderDependence: priorityOrders(ids, Math.max(0, pool), standalone),
    projects: projects.map((p) => ({
      id: p.id,
      label: p.label,
      team: p.team,
      claimedReductionPct: round((p.activityReduction ?? 0) * 100),
      itemIds: p.itemIds ?? [],
      note: p.note ?? '',
    })),
  };
}

export function summarize(snapshot, methodKey) {
  const attribution = attribute(snapshot, methodKey);
  return {
    ...attribution,
    decomposition: decomposeDelta(snapshot),
    boundary: boundaryImpact(snapshot),
    warnings: factorLineageWarnings(snapshot),
    factorRows: snapshot.factors.map((f) => ({
      id: f.id,
      label: f.label,
      unit: f.unit,
      kgPerUnit: f.kgPerUnit,
      reportKgPerUnit: reportFactor(f),
      baseVersion: f.baseVersion ?? null,
      reportVersion: f.reportVersion ?? null,
      source: f.source ?? '虚构因子库',
      retroactive: !!f.retroactive,
      retroNote: f.retroNote ?? '',
    })),
    lineItems: snapshot.items.map((item) => ({
      id: item.id,
      label: item.label,
      unit: item.unit,
      factorId: item.factorId,
      activityBase: item.activity?.base ?? 0,
      activityReport: item.activity?.report ?? 0,
      projectIds: item.projectIds ?? [],
    })),
    digest: createHash('sha256')
      .update(
        JSON.stringify({
          methodKey,
          delta: attribution.deltaKg,
          pool: attribution.projectPoolKg,
          allocations: attribution.allocations,
        }),
      )
      .digest('hex'),
  };
}
