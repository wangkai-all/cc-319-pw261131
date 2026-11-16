/**
 * 前端：零依赖 ES 模块。所有数据均来自本地 API，全部为虚构演示。
 */
import { esc, fmtT, fmtTDelta, fmtKg, fmtPct, fmtNum, shortHash, relTime } from './format.js';

const PROJECT_COLORS = ['var(--project-1)', 'var(--project-2)', 'var(--project-3)', 'var(--project-4)', 'var(--project-5)'];
const COLOR_BASE = 'var(--ink-3)';
const COLOR_FACTOR = 'var(--factor)';
const COLOR_PROJECT = 'var(--accent)';
const COLOR_OTHER = 'var(--warn)';
const COLOR_INTERACTION = 'var(--danger)';

const state = {
  meta: null,
  summary: null,
  batchId: null,
  batch: null,
  attribution: null,
  method: 'shapley',
  compareTo: '',
  tab: 'overview',
  dirty: new Map(),
  actor: '分析员 A',
};

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      // HTTP 头只能是 ISO-8859-1；中文操作人先编码，服务端再解码。
      'x-actor': encodeURIComponent(state.actor),
      ...(options.headers ?? {}),
    },
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const error = new Error(data?.error?.message ?? `请求失败（${res.status}）`);
    error.code = data?.error?.code ?? 'HTTP';
    error.details = data?.error?.details ?? {};
    error.status = res.status;
    throw error;
  }
  return data;
}

function toast(title, body = '', tone = 'ok', ttl = 5200) {
  const stack = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast${tone === 'error' ? ' is-error' : tone === 'warn' ? ' is-warn' : ''}`;
  el.innerHTML = `<div class="t-title">${esc(title)}</div>${body ? `<div class="t-body">${esc(body)}</div>` : ''}`;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 200ms';
    setTimeout(() => el.remove(), 220);
  }, ttl);
}

function showError(error) {
  const detail =
    error.details?.currentHash && error.code === 'STALE_BATCH'
      ? '任务已在别处更新。页面将刷新为最新版本，请重新应用你的修改。'
      : '';
  toast(error.message ?? '操作失败', detail, 'error', 7200);
  if (error.code === 'STALE_BATCH') refreshAll();
}

/** 有输入框的对话框；无输入时返回 true / null。 */
function openDialog({ title, body, input = null, okLabel = '确定', danger = false }) {
  return new Promise((resolve) => {
    const dialog = $('#dialog');
    $('#dialog-title').textContent = title;
    $('#dialog-body').innerHTML = `
      <p>${body}</p>
      ${
        input
          ? `<label>${esc(input.label)}<input id="dialog-input" type="text" ${
              input.placeholder ? `placeholder="${esc(input.placeholder)}"` : ''
            } /></label>`
          : ''
      }
    `;
    const ok = $('#dialog-ok');
    ok.textContent = okLabel;
    ok.className = `btn ${danger ? 'btn-warn' : 'btn-primary'}`;
    const field = $('#dialog-input');
    const finish = (value) => {
      dialog.close();
      resolve(value);
    };
    dialog.onclose = () => {
      const returned = dialog.returnValue;
      dialog.returnValue = '';
      if (returned !== 'ok') return resolve(null);
      if (!input) return resolve(true);
      const value = field?.value?.trim() ?? '';
      if (!value) {
        toast('需要填写内容', input.label, 'warn');
        return resolve(null);
      }
      resolve(value);
    };
    dialog.returnValue = '';
    dialog.showModal();
    setTimeout(() => (field ?? ok).focus(), 30);
    if (field) {
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (field.value.trim()) {
            dialog.returnValue = 'ok';
            finish(field.value.trim());
          }
        }
      });
    }
  });
}

/* ------------------------------------------------------------------ */
/* 数据加载                                                             */
/* ------------------------------------------------------------------ */

async function boot() {
  try {
    const [meta, summary] = await Promise.all([api('/api/meta'), api('/api/state')]);
    state.meta = meta;
    state.summary = summary;
    state.actor = localStorage.getItem('actor') || '分析员 A';
    $('#actor').value = state.actor;
    const preferred =
      summary.batches.find((b) => b.status === 'draft' && b.baseVersion === 'v1') ??
      summary.batches.find((b) => b.status === 'draft') ??
      summary.batches.find((b) => b.status === 'confirmed') ??
      summary.batches[0];
    if (preferred) state.batchId = preferred.id;
    await loadBatch();
    wireEvents();
    renderAll();
    checkUrlHash();
  } catch (error) {
    showError(error);
    $('#context-bar').innerHTML = `<span class="badge badge-danger">初始化失败</span><span>${esc(error.message)}</span>`;
  }
}

async function refreshSummary() {
  state.summary = await api('/api/state');
}

async function loadBatch() {
  if (!state.batchId) return;
  const compare = state.compareTo && state.compareTo !== state.batchId ? state.compareTo : '';
  const query = new URLSearchParams({ method: state.method });
  if (compare) query.set('compareTo', compare);
  const attribution = await api(`/api/batches/${state.batchId}/attribution?${query}`);
  state.attribution = attribution;
  state.batch = attribution.batch;
  state.method = attribution.method;
}

async function refreshAll({ keepDirty = false } = {}) {
  try {
    if (!keepDirty) state.dirty.clear();
    await refreshSummary();
    if (!state.summary.batches.some((b) => b.id === state.batchId)) {
      state.batchId =
        state.summary.batches.find((b) => b.status === 'draft' && b.baseVersion === 'v1')?.id ??
        state.summary.batches.find((b) => b.status === 'draft')?.id ??
        state.summary.batches[0]?.id ??
        null;
    }
    await loadBatch();
    renderAll();
  } catch (error) {
    showError(error);
  }
}

async function openBatch(batchId) {
  if (state.dirty.size > 0) {
    const ok = await openDialog({
      title: '有未应用的修改',
      body: '切换任务会丢弃这些修改。继续吗？',
      okLabel: '放弃并切换',
      danger: true,
    });
    if (!ok) return;
  }
  state.dirty.clear();
  state.batchId = batchId;
  state.compareTo = '';
  setTab('overview');
  try {
    await loadBatch();
    renderAll();
  } catch (error) {
    showError(error);
  }
}

function setTab(tab) {
  state.tab = tab;
  $$('.tab').forEach((btn) => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  $$('.view').forEach((view) => {
    view.hidden = view.id !== `view-${tab}`;
  });
  if (location.hash !== `#${tab}`) history.replaceState(null, '', `#${tab}`);
}

function checkUrlHash() {
  const hash = location.hash.replace('#', '');
  if (['overview', 'attribution', 'data', 'governance'].includes(hash)) setTab(hash);
}

/* ------------------------------------------------------------------ */
/* 渲染：上下文                                                          */
/* ------------------------------------------------------------------ */

function projectColorMap() {
  const map = new Map();
  (state.attribution?.projects ?? []).forEach((p, index) => {
    map.set(p.id, PROJECT_COLORS[index % PROJECT_COLORS.length]);
  });
  return map;
}

function projectLabel(id) {
  return state.attribution?.projects.find((p) => p.id === id)?.label ?? id;
}

function renderContext() {
  const { batch, attribution, summary } = state;
  if (!batch) return;
  const statusTone = batch.status === 'draft' ? 'accent' : batch.status === 'confirmed' ? 'ok' : batch.status === 'superseded' ? 'warn' : 'muted';
  const site = summary.sites.find((s) => s.id === batch.siteId);
  const otherReports = batch.reports;
  const sameBaseBatches = summary.batches.filter(
    (b) => b.baseFingerprint === batch.baseFingerprint && b.id !== batch.id,
  );
  $('#context-bar').innerHTML = `
    <span class="ctx-item"><span class="ctx-label">站点</span><span class="ctx-value">${esc(site?.name ?? batch.siteId)}</span></span>
    <span class="ctx-item"><span class="ctx-label">任务</span><span class="ctx-value">${esc(batch.label)}</span>
      <span class="pill ${statusTone === 'muted' ? '' : statusTone}">${esc(batch.statusLabel)}</span></span>
    <span class="ctx-item"><span class="ctx-label">口径</span><span class="ctx-value">${esc(batch.caliber)}</span></span>
    <span class="ctx-item"><span class="ctx-label">基准</span><span class="ctx-value mono" title="${esc(batch.baseFingerprint)}">${esc(batch.baseVersion)} · ${esc(shortHash(batch.baseFingerprint))}</span></span>
    <span class="ctx-item"><span class="ctx-label">同版任务</span><span class="ctx-value">${sameBaseBatches.length}</span></span>
    <span class="ctx-item"><span class="ctx-label">修订</span><span class="ctx-value">${summary.revision}</span></span>
    <span class="ctx-item"><span class="ctx-label">归属方法</span><span class="ctx-value">${esc(attribution.methodMeta.short)}</span></span>
    ${otherReports.length ? `<span class="ctx-item"><span class="ctx-label">报告</span><span class="ctx-value">${otherReports.length}</span></span>` : ''}
    <span class="spacer"></span>
    <span class="badge badge-warn" title="${esc(state.meta.disclosure)}">不宣称符合任何认证标准</span>
  `;
}

/* ------------------------------------------------------------------ */
/* 渲染：概览                                                           */
/* ------------------------------------------------------------------ */

function renderOverview() {
  const a = state.attribution;
  if (!a) return;
  const pool = a.projectPoolKg;
  const allocated = a.allocatedTotalKg;
  const kpis = [
    {
      label: `${a.batch.periods.base}排放`,
      value: fmtT(a.baseKg),
      unit: 't CO₂e',
      sub: '实际活动 × 基准期因子版本',
      color: COLOR_BASE,
    },
    {
      label: `${a.batch.periods.report}排放`,
      value: fmtT(a.reportKg),
      unit: 't CO₂e',
      sub: '实际活动 × 报告期因子版本',
      color: 'var(--ink)',
    },
    {
      label: '实际排放变化',
      value: fmtTDelta(a.deltaKg),
      unit: 't',
      sub: '基准 − 报告；正数为减排',
      color: COLOR_PROJECT,
      emphasis: true,
    },
    {
      label: '其中：因子更新',
      value: fmtTDelta(a.factorEffectKg),
      unit: 't',
      sub: '仅因因子版本变化，不含活动变化',
      color: COLOR_FACTOR,
    },
    {
      label: '项目总效应',
      value: fmtTDelta(pool),
      unit: 't',
      sub: '基线估算 − 全部项目实施的预期排放',
      color: COLOR_PROJECT,
      emphasis: true,
    },
    {
      label: '不归属任何项目',
      value: fmtTDelta(a.unattributedKg),
      unit: 't',
      sub:
        a.method === 'residual'
          ? `项目未解释的活动变化 ${fmtTDelta(a.otherActivityKg)} t + 重叠不归属 ${fmtTDelta(a.interactionUnallocatedKg)} t`
          : `项目未解释的活动变化 ${fmtTDelta(a.otherActivityKg)} t；重叠部分已由所选方法分摊`,
      color: COLOR_OTHER,
    },
  ];
  $('#kpi-grid').innerHTML = kpis
    .map(
      (k) => `
      <div class="kpi${k.emphasis ? ' emphasis' : ''}" style="--kpi-color:${k.color}">
        <div class="kpi-label">${esc(k.label)}</div>
        <div class="kpi-value">${k.value}<span class="unit">${esc(k.unit)}</span></div>
        <div class="kpi-sub">${esc(k.sub)}</div>
      </div>`,
    )
    .join('');

  renderWaterfall(a);
  renderLenses(a);
  renderOverviewAllocations(a);
  renderLineage(a);
}

function fmtSignedValue(kg) {
  const t = kg / 1000;
  return `${t < 0 ? '−' : ''}${fmtNum(Math.abs(t), 1)}`;
}

function renderWaterfall(a) {
  const rows = [
    { key: 'base', label: `${a.batch.periods.base}排放`, kind: 'total', value: a.baseKg, color: COLOR_BASE },
    { key: 'factor', label: '因子更新', kind: 'delta', value: a.factorEffectKg, color: COLOR_FACTOR, direction: -1 },
    { key: 'projects', label: '项目效应', kind: 'delta', value: a.projectPoolKg, color: COLOR_PROJECT, direction: -1 },
    { key: 'other', label: '其它活动变化', kind: 'delta', value: a.otherActivityKg, color: COLOR_OTHER, direction: -1 },
    { key: 'report', label: `${a.batch.periods.report}排放`, kind: 'total', value: a.reportKg, color: 'var(--ink)' },
  ];
  const scale = Math.max(a.baseKg, a.reportKg, Math.abs(a.factorEffectKg) + a.reportKg, 1) * 1.02;
  let cursor = a.baseKg;
  const bars = rows.map((row) => {
    if (row.kind === 'total') {
      cursor = row.value;
      return { ...row, left: 0, width: (row.value / scale) * 100, labelValue: row.value, aria: `${row.label} ${fmtT(row.value)} 吨` };
    }
    const start = cursor;
    const end = start - row.value;
    cursor = end;
    const left = Math.min(start, end);
    const width = Math.abs(start - end);
    return {
      ...row,
      left: (left / scale) * 100,
      width: (width / scale) * 100,
      from: start,
      to: end,
      aria: `${row.label} ${fmtSignedValue(row.value)} 吨`,
    };
  });

  $('#waterfall').innerHTML = `
    <div class="wf" role="img" aria-label="排放变化瀑布：基准 ${fmtT(a.baseKg)} 吨，因子更新 ${fmtSignedValue(
      a.factorEffectKg,
    )} 吨，项目效应 ${fmtSignedValue(a.projectPoolKg)} 吨，其它活动变化 ${fmtSignedValue(
      a.otherActivityKg,
    )} 吨，报告 ${fmtT(a.reportKg)} 吨">
      ${bars
        .map(
          (b) => `
        <div class="wf-row${b.kind === 'total' ? ' is-total' : ''}">
          <div class="wf-label"><span class="dot" style="--bar-color:${b.color}"></span>${esc(b.label)}</div>
          <div class="wf-track">
            <div class="wf-bar${b.kind === 'total' ? ' total' : ''}" style="left:${b.left}%;width:${Math.max(
              b.width,
              b.kind === 'total' ? 100 : 0.4,
            )}%;--bar-color:${b.color}" title="${esc(b.aria)}"></div>
          </div>
          <div class="wf-value">${b.kind === 'total' ? fmtT(b.value) : fmtSignedValue(b.value)}</div>
        </div>`,
        )
        .join('')}
    </div>
    <div class="wf-legend">
      <span><i style="background:${COLOR_BASE}"></i>实际排放</span>
      <span><i style="background:${COLOR_FACTOR}"></i>因子更新</span>
      <span><i style="background:${COLOR_PROJECT}"></i>项目效应</span>
      <span><i style="background:${COLOR_OTHER}"></i>其它活动变化</span>
      <span>单位：t CO₂e；负值表示排放增加。</span>
    </div>
  `;

  $('#waterfall-table').innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>项目</th><th class="num">kg CO₂e</th><th class="num">t CO₂e</th><th>说明</th></tr></thead>
        <tbody>
          ${a.decomposition
            ? `<tr><td class="name">活动变化效应</td><td class="num">${fmtKg(a.deltaKg - a.factorEffectKg)}</td><td class="num">${fmtT(
                a.deltaKg - a.factorEffectKg,
              )}</td><td>按报告期因子计算的活动量变化</td></tr>
               <tr><td class="name">因子更新效应</td><td class="num">${fmtKg(a.factorEffectKg)}</td><td class="num">${fmtT(
                 a.factorEffectKg,
               )}</td><td>基准活动量 ×（基准因子 − 报告期因子）</td></tr>
               <tr class="is-total"><td class="name">实际变化</td><td class="num">${fmtKg(a.deltaKg)}</td><td class="num">${fmtT(
                 a.deltaKg,
               )}</td><td>两项之和，精确闭合</td></tr>`
            : ''}
          <tr><td class="name">项目总效应</td><td class="num">${fmtKg(a.projectPoolKg)}</td><td class="num">${fmtT(
            a.projectPoolKg,
          )}</td><td>基线估算 ${fmtT(a.baselineEstimateKg)} t − 全部实施 ${fmtT(a.withAllProjectsKg)} t</td></tr>
          <tr><td class="name">其它活动变化</td><td class="num">${fmtKg(a.otherActivityKg)}</td><td class="num">${fmtT(
            a.otherActivityKg,
          )}</td><td>全部项目预期之外的报告期活动变化，可为负（排放增加）</td></tr>
        </tbody>
      </table>
    </div>
  `;
}

function renderLenses(a) {
  const lenses = [
    {
      name: '实际排放变化',
      q: '报告期相对基准期，实际排放变了多少？',
      value: fmtTDelta(a.deltaKg),
      basis: `按两期各自因子版本计算，合计 ${fmtT(a.baseKg)} → ${fmtT(a.reportKg)} t。不判断原因，也不归属项目。`,
    },
    {
      name: '基线估算',
      q: '若这些项目都不实施，报告期会是多少？',
      value: fmtT(a.baselineEstimateKg),
      basis: `按项目申报幅度反推活动量，再按报告期因子计。它是项目效应的对照基线，不是“实际会发生的排放”。`,
    },
    {
      name: '可归属项目',
      q: '在上述变化中，每个项目能分到多少？',
      value: fmtTDelta(a.allocatedTotalKg),
      basis: `仅分配项目总效应（${fmtTDelta(a.projectPoolKg)} t），不分配实际变化中的其它部分。方法「${
        a.methodMeta.label
      }」：${
        a.method === 'residual'
          ? `重叠的 ${fmtTDelta(a.interactionUnallocatedKg)} t 不归属任何项目`
          : `重叠部分按此方法分摊，单列不归属 ${fmtTDelta(a.interactionUnallocatedKg)} t`
      }。`,
    },
  ];
  $('#lens-list').innerHTML = lenses
    .map(
      (l) => `
      <div class="lens">
        <div class="lens-name">${esc(l.name)}</div>
        <div class="lens-value">${l.value} <span style="font-family:var(--font);font-size:.7rem;color:var(--ink-3)">t</span></div>
        <div class="lens-q">${esc(l.q)}</div>
        <div class="lens-basis">${esc(l.basis)}</div>
      </div>`,
    )
    .join('');
}

function renderOverviewAllocations(a) {
  const colors = projectColorMap();
  $('#overview-method-note').textContent = `当前方法：${a.methodMeta.label}。浅色为项目单独申报量，实色为可归属量。`;
  const max = Math.max(
    1,
    ...a.projects.flatMap((p) => [a.standalone[p.id] ?? 0, a.allocations[p.id] ?? 0]),
  );
  $('#overview-allocations').innerHTML = `
    <div class="alloc-list">
      ${a.projects
        .map((p) => {
          const alloc = a.allocations[p.id] ?? 0;
          const standalone = a.standalone[p.id] ?? 0;
          const over = Math.round(standalone - alloc);
          return `
          <div class="alloc-row">
            <div class="alloc-head">
              <span class="alloc-name"><span class="swatch" style="--bar-color:${colors.get(p.id)}"></span>${esc(p.label)}</span>
              <span class="alloc-num">${fmtTDelta(alloc)} t ${over > 0 ? `<span class="pill warn">重叠 ${fmtT(over)}</span>` : ''}</span>
            </div>
            <div class="alloc-track">
              <div class="alloc-fill standalone" style="width:${(Math.max(0, standalone) / max) * 100}%;--bar-color:${colors.get(
                p.id,
              )}"></div>
            </div>
            <div class="alloc-track">
              <div class="alloc-fill" style="width:${(Math.max(0, alloc) / max) * 100}%;--bar-color:${colors.get(p.id)}"></div>
            </div>
          </div>`;
        })
        .join('')}
      <div class="alloc-row">
        <div class="alloc-head">
          <span class="alloc-name"><span class="swatch" style="--bar-color:${COLOR_OTHER}"></span>其它活动变化（不归属）</span>
          <span class="alloc-num">${fmtTDelta(a.otherActivityKg)} t</span>
        </div>
        <div class="alloc-track">
          <div class="alloc-fill" style="width:${(Math.abs(a.otherActivityKg) / max) * 100}%;--bar-color:${COLOR_OTHER}"></div>
        </div>
      </div>
    </div>
    <div class="alloc-legend">
      <span><i style="background:var(--ink-3);opacity:.28"></i>单独申报量</span>
      <span><i style="background:var(--accent)"></i>可归属量</span>
      <span>单位 t CO₂e</span>
    </div>
  `;

  const naive = a.projects.reduce((sum, p) => sum + Math.max(0, a.standalone[p.id] ?? 0), 0);
  const overclaim = Math.round(naive - Math.max(0, a.projectPoolKg));
  $('#overview-naive').innerHTML = `
    <strong>不能把申报直接相加</strong>
    <p>
      ${a.projects.length} 份申报的单独效应合计为 <span class="big">${fmtT(naive)} t</span>，而全部项目联合的项目总效应只有
      <span class="big">${fmtT(Math.max(0, a.projectPoolKg))} t</span>。
      两者相差 <span class="big">${fmtT(Math.max(0, overclaim))} t</span>，来自「
      ${esc(a.projects.map((p) => p.label).join('」与「'))}」在重叠活动上的重复申报。
      本页用「${esc(a.methodMeta.label)}」分配，重叠部分单列，不归任何一方。
    </p>
  `;
}

function renderLineage(a) {
  const b = a.batch;
  const rows = [
    { k: '基准版本', v: b.baseVersion, plain: true },
    { k: '基准指纹', v: shortHash(b.baseFingerprint), title: b.baseFingerprint },
    { k: '内容哈希', v: shortHash(b.contentHash), title: b.contentHash },
    { k: '组织边界', v: b.boundaryText || '未填写', plain: true },
    {
      k: '同版任务（其它）',
      v: String(
        state.summary.batches.filter((x) => x.baseFingerprint === b.baseFingerprint && x.id !== b.id).length,
      ),
      plain: true,
    },
    { k: '归属方法', v: a.methodMeta.label, plain: true },
    { k: '状态', v: b.statusLabel, plain: true },
  ];
  $('#lineage-list').innerHTML = rows
    .map(
      (r) => `<div class="lineage-item"><span class="k">${esc(r.k)}</span><span class="v${r.plain ? ' plain' : ''}" ${
        r.title ? `title="${esc(r.title)}"` : ''
      }>${esc(r.v)}</span></div>`,
    )
    .join('');
  const warnings = [...(a.warnings ?? [])];
  if (a.attributionWarning) warnings.push(a.attributionWarning);
  $('#warnings').innerHTML =
    warnings.length > 0
      ? warnings.map((w) => `<div class="warning-item">${esc(w)}</div>`).join('')
      : `<div class="callout ok"><strong>未发现因子版本或边界口径冲突</strong><p>这仅表示演示数据内部一致，不代表符合任何外部标准。</p></div>`;
}

/* ------------------------------------------------------------------ */
/* 渲染：归属比较                                                        */
/* ------------------------------------------------------------------ */

function renderAttribution() {
  const a = state.attribution;
  if (!a) return;

  $('#method-switch').innerHTML = state.meta.methods
    .map(
      (m) => `<button class="method-btn${m.key === a.method ? ' is-active' : ''}" role="radio" aria-checked="${
        m.key === a.method
      }" data-method="${m.key}">${esc(m.short)}</button>`,
    )
    .join('');

  const options = state.summary.batches.filter((b) => b.id !== state.batchId);
  $('#compare-select').innerHTML = `<option value="">不并排对照</option>${options
    .map(
      (b) =>
        `<option value="${b.id}"${b.id === state.compareTo ? ' selected' : ''}>${esc(b.label)}（${esc(
          b.statusLabel,
        )} · ${esc(shortHash(b.baseFingerprint))}）</option>`,
    )
    .join('')}`;

  $('#method-note').className = 'notice';
  $('#method-note').innerHTML = `
    <div>
      <h2>${esc(a.methodMeta.label)}</h2>
      <p>${esc(a.methodMeta.note)}</p>
      <p style="margin-top:.3rem">
        <strong>交互作用处理：</strong>${esc(a.methodMeta.interactionHandling ?? '—')}
        · <strong>顺序无关：</strong>${a.methodMeta.orderFree ? '是' : '否'}
        · <strong>注意：</strong>${esc(a.methodMeta.caution ?? '—')}
      </p>
    </div>
    <span class="notice-tag">${esc(a.methodMeta.short)}</span>
  `;

  renderComparison(a);
  renderAllocTable(a);
  renderCombos(a);
  renderUnattributed(a);
  renderOrders(a);
  renderDecomposition(a);
}

function renderComparison(a) {
  const c = a.comparison;
  const host = $('#comparison-banner');
  if (!c) {
    host.innerHTML = '';
    return;
  }
  if (c.sameBase) {
    host.innerHTML = `
      <div class="callout ok">
        <strong>对照任务基准同版：${esc(c.otherLabel)}</strong>
        <p>基准指纹 ${esc(shortHash(c.otherBaseFingerprint))} 与当前任务一致，可以直接对照。
        即使同版，也仍然只比较口径与结果，不把两个任务的申报相加。</p>
      </div>`;
    return;
  }
  host.innerHTML = `
    <div class="callout danger">
      <strong>对照任务基准不同版，已阻止并排比较</strong>
      <p>${esc(c.note)}</p>
      ${
        c.differences?.length
          ? `<ul style="margin:.35rem 0 0;padding-left:1.1rem;font-size:.79rem">${c.differences
              .map((d) => `<li>${esc(d)}</li>`)
              .join('')}</ul>`
          : ''
      }
      <p style="margin-top:.45rem">要对照，必须先把当前任务的基准同步为对照任务的基准（报告中已确认的内容不会被改动）。</p>
      <div class="form-actions" style="margin-top:.5rem">
        <button class="btn btn-warn" id="rebase-to-compare">将当前任务基准同步为对照任务</button>
        <button class="btn btn-quiet" id="clear-compare">取消对照</button>
      </div>
    </div>
  `;
  const rebase = $('#rebase-to-compare');
  if (rebase) {
    rebase.disabled = a.batch.status !== 'draft';
    rebase.addEventListener('click', async () => {
      const ok = await openDialog({
        title: '同步基准并保留报告期假设',
        body: '将把对照任务的基准期活动量、基准因子、边界与重述记录复制到当前任务，报告期活动与项目申报保持不变。这会生成新的基准指纹并写入审计。',
        okLabel: '同步基准',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/api/batches/${state.batchId}/rebase`, {
          method: 'POST',
          body: JSON.stringify({
            sourceBatchId: c.otherBatchId,
            expectedHash: a.batch.contentHash,
          }),
        });
        await refreshAll();
        toast('基准已同步', '报告期活动与项目申报保持不变；可以同版对照。');
      } catch (error) {
        showError(error);
      }
    });
  }
  $('#clear-compare')?.addEventListener('click', async () => {
    state.compareTo = '';
    await loadBatch();
    renderAll();
  });
}

function renderAllocTable(a) {
  const colors = projectColorMap();
  const rows = a.projects.map((p) => {
    const standalone = a.standalone[p.id] ?? 0;
    const alloc = a.allocations[p.id] ?? 0;
    const gap = Math.round(standalone - alloc);
    return `
      <tr>
        <td class="name"><span class="swatch" style="--bar-color:${colors.get(p.id)}"></span>${esc(p.label)}
          <span class="sub">${esc(p.team)}；申报幅度 ${fmtPct(p.claimedReductionPct)}；关联 ${p.itemIds.length} 条活动</span></td>
        <td class="num">${fmtTDelta(standalone)}<span class="sub">单独效应</span></td>
        <td class="num"><strong>${fmtTDelta(alloc)}</strong><span class="sub">可归属</span></td>
        <td class="num">${gap === 0 ? '0.0' : fmtTDelta(gap)}<span class="sub">${gap > 0 ? '含重叠扣减' : gap < 0 ? '高于单独效应' : '与单独效应一致'}</span></td>
        <td>${esc(a.rationale[p.id] ?? '')}</td>
      </tr>`;
  });
  $('#alloc-table').innerHTML = `
    <thead><tr><th>项目</th><th class="num">单独效应 t</th><th class="num">可归属 t</th><th class="num">差额 t</th><th>形成方式</th></tr></thead>
    <tbody>${rows.join('')}
      <tr class="is-total">
        <td class="name">合计</td>
        <td class="num">${fmtTDelta(a.standaloneSumKg)}</td>
        <td class="num">${fmtTDelta(a.allocatedTotalKg)}</td>
        <td class="num">${fmtTDelta(a.standaloneSumKg - a.allocatedTotalKg)}</td>
        <td>可归属合计 + 重叠不归属 = 项目总效应</td>
      </tr>
    </tbody>
  `;
  const identityOk =
    Math.abs(a.allocatedTotalKg + a.interactionUnallocatedKg - a.projectPoolKg) < 1 &&
    Math.abs(a.projectPoolKg + a.otherActivityKg + a.factorEffectKg - a.deltaKg) < 1;
  $('#totals-strip').innerHTML = `
    <span>项目总效应 <b>${fmtT(a.projectPoolKg)} t</b></span>
    <span>可归属 <b>${fmtT(a.allocatedTotalKg)} t</b></span>
    <span>交互未分配 <b>${fmtT(a.interactionUnallocatedKg)} t</b></span>
    <span>其它活动变化 <b>${fmtT(a.otherActivityKg)} t</b></span>
    <span>因子更新 <b>${fmtT(a.factorEffectKg)} t</b></span>
    <span>${identityOk ? '<span class="pill accent">账目闭合</span>' : '<span class="pill warn">存在舍入差</span>'} 差异 &lt; 1 kg</span>
  `;
}

function renderCombos(a) {
  if (a.combos.length === 0) {
    $('#combos').innerHTML = `<div class="empty-state">只有一个激活项目，不存在项目间交互。</div>`;
    return;
  }
  $('#combos').innerHTML = `
    <div class="combo-list">
      ${a.combos
        .map((c) => {
          const joint = Math.max(0, c.jointEffectKg);
          const inter = c.interactionKg;
          const max = Math.max(1, joint, c.standaloneSumKg);
          const shareA = joint > 0 ? (Math.max(0, joint - Math.max(0, inter)) / joint) * 100 : 0;
          const interShare = joint > 0 ? Math.max(0, (inter / joint) * 100) : 0;
          return `
          <div class="combo">
            <div class="combo-pair">${esc(projectLabel(c.projectIds[0]))} <span class="plus">+</span> ${esc(
              projectLabel(c.projectIds[1]),
            )}</div>
            <div class="combo-figures">
              <span>联合效应 <b>${fmtTDelta(joint)}</b> t</span>
              <span>各自单独之和 <b>${fmtTDelta(c.standaloneSumKg)}</b> t</span>
              <span>重复申报 <b>${inter > 0 ? fmtTDelta(inter) : '0.0'}</b> t</span>
            </div>
            <div class="combo-bar" style="--c1:var(--project-1);--c2:var(--project-2)">
              <div class="seg-a" style="width:${Math.min(100, shareA / 1.25)}%"></div>
              <div class="seg-x" style="width:${Math.min(100, (Math.max(0, interShare) / 50) * 50)}%"></div>
            </div>
            <div class="combo-note">
              ${
                inter > 0
                  ? `两份申报在重叠活动上重复解释了 <b>${fmtTDelta(inter)} t</b>；直接相加会高估这么多。`
                  : '无重叠：联合效应与单独效应之和一致。'
              }
            </div>
          </div>`;
        })
        .join('')}
    </div>
    ${renderOverlapTable(a)}
    <div class="callout warn" style="margin-top:.7rem">
      <strong>为什么单独效应不能相加</strong>
      <p>
        每个项目的单独效应都是在“其它项目都不实施”的假设下算的；当两个项目同时降低同一条活动量时，
        第二次降低的基数是已经被降低过的活动量，因此联合效应小于两者之和。
      </p>
    </div>
  `;
}

/** 逐条活动展示重复贡献落在哪里、金额多少。 */
function renderOverlapTable(a) {
  const rows = a.overlaps ?? [];
  if (rows.length === 0) return '';
  const colors = projectColorMap();
  return `
    <h3 style="margin-top:1rem">具体重复贡献（逐活动条目）</h3>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>活动条目</th><th class="num">基准活动</th><th>各项目单独贡献 t</th><th class="num">联合贡献 t</th><th class="num">重复贡献 t</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (r) => `
            <tr>
              <td class="name">${esc(r.itemLabel)}<span class="sub">${esc(r.unit)} × ${esc(r.factorLabel)}</span></td>
              <td class="num">${fmtNum(r.baseActivity, 0)}</td>
              <td>${r.projectIds
                .map(
                  (id) =>
                    `<div class="hint"><span class="swatch" style="--bar-color:${colors.get(id)}"></span>${esc(
                      projectLabel(id),
                    )}：<b style="font-family:var(--mono)">${fmtT(r.perProject[id])}</b></div>`,
                )
                .join('')}</td>
              <td class="num">${fmtT(r.jointKg)}</td>
              <td class="num"><strong>${fmtT(r.overlapKg)}</strong></td>
            </tr>`,
            )
            .join('')}
          <tr class="is-total">
            <td class="name">合计</td><td class="num">—</td>
            <td>单独贡献之和 ${fmtT(rows.reduce((s, r) => s + r.sumAloneKg, 0))} t</td>
            <td class="num">${fmtT(rows.reduce((s, r) => s + r.jointKg, 0))}</td>
            <td class="num">${fmtT(rows.reduce((s, r) => s + r.overlapKg, 0))}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="hint" style="margin-top:.35rem">
      重复贡献 = 各项目单独贡献之和 − 联合贡献。它正是两份申报不能直接相加的那部分；本页按所选方法处理，并在方法说明中写明处理方式。
    </div>
  `;
}

function renderUnattributed(a) {
  const items = [
    {
      label: '其它活动变化',
      kg: a.otherActivityKg,
      why: '报告期实际活动与“全部项目按申报幅度实施”的预期活动之间的差；可能来自产量、天气、原料或未申报措施。',
    },
    {
      label: '因子更新效应',
      kg: a.factorEffectKg,
      why: '因子版本更新带来的变化，与项目活动无关；不能算作项目减排。',
    },
    {
      label: '交互作用（不归属）',
      kg: a.interactionUnallocatedKg,
      why:
        a.method === 'residual'
          ? '两个项目重复申报的重叠部分；本方法选择不把它分给任何一方。'
          : '重叠申报部分已按所选方法分摊给项目，因此这里为 0。',
    },
  ];
  const total = a.unattributedKg;
  $('#unattributed').innerHTML = `
    <div class="split-list">
      ${items
        .map(
          (i) => `
        <div class="split-row">
          <span class="what">${esc(i.label)}</span>
          <span class="amt ${i.kg < 0 ? 'neg' : i.kg > 0 ? 'pos' : ''}">${fmtTDelta(i.kg)} t</span>
          <span class="why">${esc(i.why)}</span>
        </div>`,
        )
        .join('')}
      <div class="split-row split-total">
        <span class="what"><strong>不归属合计（其它活动变化 + 重叠）</strong></span>
        <span class="amt ${total < 0 ? 'neg' : 'pos'}">${fmtTDelta(total)} t</span>
        <span class="why">这些量既不进项目减排，也不应被忽略：它们是实际变化与可归属项目之间的桥。</span>
      </div>
    </div>
    ${
      total < 0
        ? `<div class="callout danger"><strong>不归属为负</strong><p>报告期存在项目未解释的排放增加（例如天然气用量上升），它抵消了部分减排。项目归属只解释正向的项目效应，不能把这块负值摊给项目。</p></div>`
        : ''
    }
  `;
}

function renderOrders(a) {
  const orders = a.orderDependence ?? [];
  if (orders.length === 0) {
    $('#order-panel').innerHTML = `<div class="empty-state">项目数超过 4，已跳过顺序穷举；顺序依赖仍然存在，但此处不展示全部顺位。</div>`;
    return;
  }
  const currentOrder = a.projects.map((p) => p.id);
  const spread = {};
  for (const p of a.projects) {
    const values = orders.map((o) => o.allocation[p.id] ?? 0);
    spread[p.id] = { min: Math.min(...values), max: Math.max(...values) };
  }
  const maxSpread = Math.max(0, ...Object.values(spread).map((s) => s.max - s.min));
  $('#order-panel').innerHTML = `
    <div class="order-grid">
      ${orders
        .map((o) => {
          const isCurrent = o.order.join('|') === currentOrder.join('|');
          return `
          <div class="order-card${isCurrent ? ' is-current' : ''}">
            <div class="order-seq">${isCurrent ? '<span class="pill accent">当前申报顺序</span>' : ''}
              ${o.order
                .map(
                  (id, index) =>
                    `${index > 0 ? '<span style="color:var(--ink-3)">→</span>' : ''}<span class="seq-num">${
                      index + 1
                    }</span><span>${esc(projectLabel(id))}</span>`,
                )
                .join('')}
            </div>
            <div class="order-alloc">
              ${o.order
                .map(
                  (id) =>
                    `<div><span>${esc(projectLabel(id))}</span><b>${fmtTDelta(o.allocation[id] ?? 0)} t</b></div>`,
                )
                .join('')}
            </div>
            <div class="order-spread${o.unallocatedKg > 0 ? ' warn' : ''}">
              ${o.unallocatedKg > 0 ? `剩余未分配 ${fmtTDelta(o.unallocatedKg)} t` : '申报量全部被解释'}
            </div>
          </div>`;
        })
        .join('')}
    </div>
    <div class="callout ${maxSpread > 1000 ? 'warn' : ''}" style="margin-top:.7rem">
      <strong>顺序依赖幅度：${fmtTDelta(maxSpread)} t</strong>
      <p>
        ${
          maxSpread > 0
            ? `同一组数据，仅改变申报顺位，单个项目的归属最多相差 ${fmtTDelta(maxSpread)} t。因此“谁先申报”必须作为方法的一部分被明确记录并冻结；不能把优先扣除法包装成客观事实。`
            : '该组数据下各顺位结果相同（单独效应之和未超过项目总效应）。'
        }
      </p>
      ${Object.entries(spread)
        .map(
          ([id, s]) =>
            `<div class="hint">${esc(projectLabel(id))}：${fmtTDelta(s.min)} – ${fmtTDelta(s.max)} t</div>`,
        )
        .join('')}
    </div>
  `;
}

function renderDecomposition(a) {
  const d = a.decomposition;
  const max = Math.max(1, ...d.byFactor.map((f) => Math.abs(f.factorEffectKg)));
  $('#decomposition').innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr><th>因子</th><th class="num">基准因子</th><th class="num">报告期因子</th><th class="num">活动效应 t</th><th class="num">因子效应 t</th><th>版本</th></tr>
        </thead>
        <tbody>
          ${d.byFactor
            .map(
              (f) => `
            <tr>
              <td class="name">${esc(f.factorLabel)}<span class="sub">kg CO₂e / ${esc(f.unit)}</span></td>
              <td class="num">${fmtNum(f.baseKgPerUnit)}</td>
              <td class="num">${fmtNum(f.reportKgPerUnit)}</td>
              <td class="num">${fmtTDelta(f.activityEffectKg)}</td>
              <td class="num">${fmtTDelta(f.factorEffectKg)}</td>
              <td><span class="hint">${esc(f.baseVersion ?? '—')} → ${esc(f.reportVersion ?? '—')}</span>
                <div class="alloc-track" style="margin-top:.25rem"><div class="alloc-fill" style="width:${
                  (Math.abs(f.factorEffectKg) / max) * 100
                }%;--bar-color:${COLOR_FACTOR}"></div></div>
              </td>
            </tr>`,
            )
            .join('')}
          <tr class="is-total">
            <td class="name">合计</td><td class="num">—</td><td class="num">—</td>
            <td class="num">${fmtTDelta(d.activityEffectKg)}</td>
            <td class="num">${fmtTDelta(d.factorEffectKg)}</td>
            <td>实际变化 ${fmtTDelta(d.totalKg)} t</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="callout">
      <strong>两种拆分，两种用途</strong>
      <p>
        这里按“基准活动 × 因子差”定义因子效应、按“报告期因子 × 活动差”定义活动效应，二者精确相加为实际变化。
        而归属于项目的是项目效应（${fmtTDelta(a.projectPoolKg)} t），它来自反事实，不等于活动效应
        （${fmtTDelta(d.activityEffectKg)} t）：项目只解释其中与其申报活动相关的一部分。
      </p>
      <p>
        报告期因子 ${fmtTDelta(d.factorEffectKg)} t 的变化不归任何项目；如果因子被追溯更正，基准指纹会改变，旧报告保持原样。
      </p>
    </div>
  `;
}

/* ------------------------------------------------------------------ */
/* 渲染：数据与假设                                                      */
/* ------------------------------------------------------------------ */

function pendingInput(key, fallback, attrs = '') {
  const entry = state.dirty.get(key);
  return {
    value: entry ? entry.value : fallback,
    dirty: Boolean(entry),
    attrs,
  };
}

function renderData() {
  const a = state.attribution;
  if (!a) return;
  const snap = a.batch.snapshot;
  const editable = a.batch.status === 'draft';
  const colors = projectColorMap();

  $('#activity-table').innerHTML = `
    <thead><tr><th>活动条目</th><th>因子</th><th class="num">${esc(a.batch.periods.base)}</th><th class="num">${esc(
      a.batch.periods.report,
    )}</th><th class="num">基准排放 t</th><th class="num">报告排放 t</th><th>关联项目</th></tr></thead>
    <tbody>
      ${snap.items
        .map((item) => {
          const factor = snap.factors.find((f) => f.id === item.factorId);
          const baseKg = item.activity.base * factor.kgPerUnit;
          const reportKg = item.activity.report * (factor.reportKgPerUnit ?? factor.kgPerUnit);
          const key = `activity:${item.id}`;
          const pending = pendingInput(key, item.activity.report);
          return `
          <tr>
            <td class="name">${esc(item.label)}<span class="sub">${esc(item.unit)}</span></td>
            <td>${esc(factor.label)}</td>
            <td class="num">${fmtNum(item.activity.base, 0)}</td>
            <td class="num"><input type="number" min="0" step="any" data-edit="activity" data-id="${item.id}" value="${pending.value}" class="${
              pending.dirty ? 'dirty' : ''
            }" ${editable ? '' : 'disabled'} aria-label="${esc(item.label)} 报告期活动" /></td>
            <td class="num">${fmtT(baseKg)}</td>
            <td class="num">${fmtT(reportKg)}</td>
            <td>${(item.projectIds ?? [])
              .map(
                (id) =>
                  `<span class="pill" style="border-color:${colors.get(id) ?? 'var(--line)'}">${esc(projectLabel(id))}</span>`,
              )
              .join(' ') || '<span class="hint">未关联</span>'}</td>
          </tr>`;
        })
        .join('')}
    </tbody>
  `;

  $('#factor-table').innerHTML = `
    <thead><tr><th>因子</th><th>单位</th><th class="num">基准期因子</th><th class="num">报告期因子</th><th>版本</th><th>来源</th></tr></thead>
    <tbody>
      ${snap.factors
        .map((factor) => {
          const key = `factor:${factor.id}`;
          const current = factor.reportKgPerUnit ?? factor.kgPerUnit;
          const pending = pendingInput(key, current);
          const changed = current !== factor.kgPerUnit;
          return `
          <tr>
            <td class="name">${esc(factor.label)}${factor.retroactive ? '<span class="pill warn" style="margin-left:.3rem">已追溯更正</span>' : ''}
              ${factor.retroNote ? `<span class="sub">${esc(factor.retroNote)}</span>` : ''}</td>
            <td>${esc(factor.unit)}</td>
            <td class="num">${fmtNum(factor.kgPerUnit)}<span class="sub">只读</span></td>
            <td class="num"><input type="number" min="0" step="0.01" data-edit="factor" data-id="${factor.id}" value="${pending.value}" class="${
              pending.dirty ? 'dirty' : ''
            }" ${editable ? '' : 'disabled'} aria-label="${esc(factor.label)} 报告期因子" />${
              changed ? '<span class="sub">与基准期不同</span>' : ''
            }</td>
            <td class="hint">${esc(factor.baseVersion ?? '—')}<br />→ ${esc(factor.reportVersion ?? '—')}</td>
            <td class="hint">${esc(factor.source ?? '虚构因子库')}</td>
          </tr>`;
        })
        .join('')}
    </tbody>
  `;

  $('#retro-factor').innerHTML = snap.factors
    .map((f) => `<option value="${f.id}">${esc(f.label)}（${fmtNum(f.kgPerUnit)} kg/${esc(f.unit)}）</option>`)
    .join('');
  $('#retro-form').querySelector('[name="baseKgPerUnit"]').value = '';
  $('#retro-form').querySelector('[name="reportKgPerUnit"]').value = '';
  $('#retro-form').querySelector('[name="note"]').value = '';
  $('#retro-form').querySelectorAll('input, select, button').forEach((el) => {
    el.disabled = !editable;
  });

  $('#project-table').innerHTML = `
    <thead><tr><th>项目</th><th>负责部门</th><th class="num">申报幅度</th><th>关联活动</th><th>申报说明</th><th>纳入归属</th></tr></thead>
    <tbody>
      ${snap.projects
        .map((p) => {
          const key = `project:${p.id}`;
          const pending = pendingInput(key, Math.round((p.activityReduction ?? 0) * 1000) / 10);
          const activeKey = `project-active:${p.id}`;
          const pendingActive = state.dirty.get(activeKey);
          const isActive = pendingActive ? pendingActive.value : p.active !== false;
          return `
          <tr>
            <td class="name"><span class="swatch" style="--bar-color:${colors.get(p.id)}"></span>${esc(p.label)}</td>
            <td class="hint">${esc(p.team)}</td>
            <td class="num"><div style="display:flex;align-items:center;gap:.3rem;justify-content:flex-end">
              <input type="number" min="0" max="95" step="0.5" data-edit="project" data-id="${p.id}" value="${pending.value}" class="${
                pending.dirty ? 'dirty' : ''
              }" ${editable ? '' : 'disabled'} aria-label="${esc(p.label)} 申报幅度百分比" style="width:5.5rem" /> <span>%</span></div></td>
            <td>${(p.itemIds ?? [])
              .map((id) => {
                const item = snap.items.find((i) => i.id === id);
                return `<div class="hint">${esc(item?.label ?? id)}</div>`;
              })
              .join('')}</td>
            <td class="hint">${esc(p.note ?? '')}</td>
            <td><label style="flex-direction:row;align-items:center;gap:.35rem;font-size:.78rem"><input type="checkbox" data-edit="project-active" data-id="${p.id}" ${
              isActive ? 'checked' : ''
            } ${editable ? '' : 'disabled'} style="width:auto" />${isActive ? '纳入' : '排除'}</label></td>
          </tr>`;
        })
        .join('')}
    </tbody>
  `;

  renderOverlap(snap);
  renderIngest(snap, editable);
  renderBoundary(snap, editable);
  const ASSUMPTION_LABELS = {
    factorTrend: '因子趋势假设',
    activitySource: '活动数据来源',
    ownershipMethod: '归属口径',
    reviewStage: '复核进度',
    correctionOf: '更正来源',
  };
  $('#assumption-list').innerHTML = Object.entries(snap.assumptions ?? {})
    .map(([k, v]) => {
      const label = ASSUMPTION_LABELS[k] ?? k;
      const value =
        k === 'correctionOf' && v && typeof v === 'object'
          ? `更正 ${shortHash(v.batchId)}（${v.reason ?? ''}）`
          : String(v);
      return `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`;
    })
    .join('');
  renderDirtySummary();
}

/** 数据接入历史与表单状态。 */
function renderIngest(snap, editable) {
  const ingestions = [...(snap.ingestions ?? [])].reverse();
  $('#ingest-history').innerHTML =
    ingestions.length === 0
      ? `<div class="empty-state">尚未接入外部数据；当前数值为演示初始值。</div>`
      : ingestions
          .map(
            (i) => `
        <div class="split-row">
          <span class="what">${esc(i.sourceLabel)}${i.note ? ` · ${esc(i.note)}` : ''}</span>
          <span class="amt" style="font-size:.76rem">${i.rowCount} 行 / 改动 ${i.changedCount} 条</span>
          <span class="why">${esc(relTime(i.at))} · ${esc(i.by)} · 行内容哈希 ${esc(shortHash(i.rowsHash))}</span>
        </div>`,
          )
          .join('');
  const form = $('#ingest-form');
  form.querySelectorAll('input, button').forEach((el) => {
    if (el.id === 'download-template') return;
    el.disabled = !editable;
  });
  $('#ingest-hint').textContent = editable
    ? '接入会直接写入草稿的报告期活动，并记录来源与行数。'
    : '当前任务不可编辑，数据接入已禁用。';
}

function renderOverlap(snap) {
  const colors = projectColorMap();
  const projectItems = snap.projects.map((p) => ({ p, items: new Set(p.itemIds ?? []) }));
  $('#project-overlap').innerHTML = `
    <h3 style="margin-bottom:.4rem">活动条目 × 项目关联</h3>
    ${snap.items
      .map((item) => {
        const linked = projectItems.filter((x) => x.items.has(item.id));
        const isOverlap = linked.length > 1;
        return `
        <div class="overlap-row">
          <span>${esc(item.label)} ${isOverlap ? '<span class="pill warn">重叠</span>' : ''}</span>
          <span class="overlap-track">
            ${snap.projects
              .map((p) => {
                const on = linked.some((x) => x.p.id === p.id);
                return `<span class="overlap-seg${on && isOverlap ? ' overlap' : ''}" title="${esc(p.label)}${
                  on ? '：关联' : '：未关联'
                }" style="background:${on ? colors.get(p.id) : 'var(--surface-2)'};opacity:${on ? 0.85 : 1}"></span>`;
              })
              .join('')}
          </span>
        </div>`;
      })
      .join('')}
    <div class="wf-legend">
      ${snap.projects
        .map((p) => `<span><i style="background:${colors.get(p.id)}"></i>${esc(p.label)}</span>`)
        .join('')}
      <span><i style="background:var(--surface-2);outline:1px solid var(--line)"></i>未关联</span>
    </div>
  `;
}

function renderBoundary(snap, editable) {
  const a = state.attribution;
  const entries = snap.boundaryChanges ?? [];
  $('#boundary-list').innerHTML =
    entries.length === 0
      ? `<div class="empty-state">没有记录组织边界调整。</div>`
      : `<div class="split-list">${entries
          .map(
            (entry) => `
          <div class="split-row">
            <span class="what">${esc(entry.note)}</span>
            <span class="amt">${entry.kind === 'removed' ? '剥离' : entry.kind === 'added' ? '并入' : '重述'}</span>
            <span class="why">${esc(
              snap.items.find((i) => i.id === entry.itemId)?.label ?? entry.itemId,
            )}${entry.fromActivity !== undefined ? `：基准量 ${fmtNum(entry.fromActivity, 0)} → ${fmtNum(entry.toActivity, 0)}` : ''}
            ${entry.at ? ` · ${esc(relTime(entry.at))}` : ''}</span>
          </div>`,
          )
          .join('')}</div>
        <div class="hint" style="margin-top:.4rem">边界调整改变基准指纹；${fmtT(
          a.boundary.netRestatedBaseKg,
        )} t 的重述量不计入任何项目归属。</div>`;
  $('#boundary-item').innerHTML = snap.items
    .map(
      (i) =>
        `<option value="${i.id}">${esc(i.label)}（基准 ${fmtNum(i.activity.base, 0)} ${esc(i.unit)}）</option>`,
    )
    .join('');
  $('#boundary-form').querySelector('[name="newBaseActivity"]').value = '';
  $('#boundary-form').querySelector('[name="note"]').value = '';
  $('#boundary-form').querySelectorAll('input, select, button').forEach((el) => {
    el.disabled = !editable;
  });
  $('#boundary-form').querySelector('[name="itemId"]')?.addEventListener('change', (event) => {
    const item = snap.items.find((i) => i.id === event.target.value);
    $('#boundary-form').querySelector('[name="newBaseActivity"]').value = item ? item.activity.base : '';
  });
}

function renderDirtySummary() {
  const n = state.dirty.size;
  const box = $('#dirty-summary');
  box.textContent = n === 0 ? '没有未应用的修改。' : `${n} 项未应用的修改（仅报告期假设与项目申报）。`;
  box.classList.toggle('has-changes', n > 0);
  $('#apply-edits').disabled = n === 0 || !state.attribution?.batch.editable;
  $('#discard-edits').disabled = n === 0;
}

/* ------------------------------------------------------------------ */
/* 渲染：版本治理                                                        */
/* ------------------------------------------------------------------ */

function renderGovernance() {
  const summary = state.summary;
  const a = state.attribution;
  const statusTone = { draft: 'accent', confirmed: 'ok', superseded: 'warn', closed: '' };
  $('#batch-list').innerHTML = summary.batches
    .map((b) => {
      const sameBase = a && b.baseFingerprint === a.batch.baseFingerprint;
      const isCurrent = b.id === state.batchId;
      return `
      <div class="batch-card${isCurrent ? ' is-active' : ''}">
        <div class="batch-title">
          <span class="pill ${statusTone[b.status] ?? ''}">${esc(b.statusLabel)}</span>
          ${esc(b.label)}
          ${isCurrent ? '<span class="pill accent">当前上下文</span>' : ''}
          ${sameBase && !isCurrent ? '<span class="pill">与当前同版</span>' : ''}
          ${!sameBase && !isCurrent ? '<span class="pill warn">基准不同版</span>' : ''}
        </div>
        <div class="batch-actions">
          ${!isCurrent ? `<button class="btn btn-sm" data-open="${b.id}">打开</button>` : ''}
          ${
            b.status === 'draft'
              ? `<button class="btn btn-sm btn-quiet" data-close="${b.id}">关闭草稿</button>
                 <button class="btn btn-sm btn-primary" data-confirm-batch="${b.id}">确认…</button>`
              : ''
          }
          ${
            b.status === 'confirmed'
              ? `<button class="btn btn-sm btn-warn" data-supersede="${b.id}">追溯更正…</button>`
              : ''
          }
        </div>
        <div class="batch-meta">
          <span>创建 ${esc(relTime(b.createdAt))} · ${esc(b.createdBy)}</span>
          <span>基准 <span class="mono">${esc(b.baseVersion)} · ${esc(shortHash(b.baseFingerprint))}</span></span>
          <span>内容 <span class="mono" title="${esc(b.contentHash)}">${esc(shortHash(b.contentHash))}</span></span>
          ${b.basedOn ? `<span>基于 <span class="mono">${esc(shortHash(b.basedOn))}</span></span>` : ''}
          ${b.reportId ? '<span>已有报告</span>' : ''}
        </div>
      </div>`;
    })
    .join('');

  $('#report-list').innerHTML =
    summary.reports.length === 0
      ? `<div class="empty-state">还没有报告。选择一个草稿并确认后会在此生成。</div>`
      : summary.reports
          .slice()
          .reverse()
          .map((r) => {
            const tone = r.status === 'retracted' ? 'is-retracted' : r.supersededBy ? 'is-superseded' : '';
            const batch = summary.batches.find((b) => b.id === r.batchId);
            return `
          <div class="report-card ${tone}">
            <div class="report-title">
              <span class="pill ${r.status === 'retracted' ? 'danger' : r.supersededBy ? 'warn' : 'accent'}">${
                r.status === 'retracted' ? '已撤回' : r.supersededBy ? '已被取代' : '已出具'
              }</span>
              ${esc(r.label)}
            </div>
            <div class="report-meta">
              <span>${esc(relTime(r.issuedAt))} · ${esc(r.issuedBy)}</span>
              <span>方法 ${esc(r.method)}</span>
              <span>内容 <span class="mono">${esc(shortHash(r.hash))}</span></span>
              <span>基准 <span class="mono">${esc(shortHash(r.baseFingerprint))}</span></span>
              <span>任务：${esc(batch?.label ?? r.batchId)}</span>
            </div>
            ${
              r.retractedReason
                ? `<div class="report-note">撤回原因：${esc(r.retractedReason)}</div>`
                : ''
            }
            ${r.supersededBy ? `<div class="report-note">已被更正草稿取代；原报告内容与哈希保持不变。</div>` : ''}
            ${
              r.status === 'issued'
                ? `<div class="form-actions" style="margin-top:.4rem"><button class="btn btn-sm btn-quiet" data-retract="${r.id}">撤回报告…</button></div>`
                : ''
            }
          </div>`;
          })
          .join('');

  const batchOptions = summary.batches
    .map((b) => `<option value="${b.id}">${esc(b.label)}（${esc(b.statusLabel)}）</option>`)
    .join('');
  const diffA = $('#diff-a');
  const diffB = $('#diff-b');
  const prevA = diffA.value;
  const prevB = diffB.value;
  diffA.innerHTML = batchOptions;
  diffB.innerHTML = batchOptions;
  diffA.value = summary.batches.some((b) => b.id === prevA) ? prevA : state.batchId;
  diffB.value =
    summary.batches.some((b) => b.id === prevB) && prevB !== diffA.value
      ? prevB
      : summary.batches.find((b) => b.id !== diffA.value)?.id ?? state.batchId;
  renderDiff();

  const draftBatches = summary.batches.filter((b) => b.status === 'draft');
  const currentIsDraft = a?.batch.status === 'draft';
  const confirmForm = $('#confirm-form');
  $('#confirm-method').innerHTML = state.meta.methods
    .map((m) => `<option value="${m.key}"${m.key === state.method ? ' selected' : ''}>${esc(m.label)}</option>`)
    .join('');
  $('#confirm-label').value = a ? `${a.batch.label}（确认稿 · ${a.methodMeta.short}）` : '';
  $('#confirm-hint').textContent = currentIsDraft
    ? '确认后任务封存，内容哈希锁定，不能再修改。'
    : draftBatches.length
      ? `当前任务不可确认；可选择一个草稿后确认（共 ${draftBatches.length} 个草稿）。`
      : '没有可确认的草稿。';
  confirmForm.querySelector('button[type="submit"]').disabled = !currentIsDraft;

  const confirmedBatches = summary.batches.filter((b) => b.status === 'confirmed');
  const supersedeForm = $('#supersede-form');
  supersedeForm.querySelector('button[type="submit"]').disabled = !(
    a && a.batch.status === 'confirmed'
  );
  $('#supersede-form h3').textContent = a?.batch.status === 'confirmed'
    ? `对「${a.batch.label}」发起追溯更正`
    : `追溯更正需要先打开一个已确认任务（当前有 ${confirmedBatches.length} 个）`;
  supersedeForm.querySelector('[name="reason"]').value = '';

  $('#audit-list').innerHTML = summary.audit
    .map(
      (e) => `
    <li class="audit-item">
      <span class="rev">#${e.revision}</span>
      <span class="when">${esc(new Date(e.at).toLocaleString('zh-CN', { hour12: false }))}</span>
      <span class="what"><span class="audit-action">${esc(e.action)}</span>${esc(e.summary ?? '')}
        <span class="hint">${esc(e.actor ?? '')}</span></span>
    </li>`,
    )
    .join('');
}

async function renderDiff() {
  const aId = $('#diff-a').value;
  const bId = $('#diff-b').value;
  const host = $('#diff-result');
  if (!aId || !bId) {
    host.innerHTML = '';
    return;
  }
  if (aId === bId) {
    host.innerHTML = `<div class="callout">同一任务，无需对照。</div>`;
    return;
  }
  try {
    const [a, b] = await Promise.all([
      api(`/api/batches/${aId}`),
      api(`/api/batches/${bId}`),
    ]);
    const same = a.baseFingerprint === b.baseFingerprint;
    host.innerHTML = same
      ? `<div class="callout ok"><strong>基准同版</strong><p>指纹一致：<span class="mono">${esc(
          shortHash(a.baseFingerprint),
        )}</span>。可以直接对照。</p></div>
         <div class="hint">${esc(a.label)} 基准 ${esc(a.baseVersion)}；${esc(b.label)} 基准 ${esc(b.baseVersion)}。</div>`
      : `<div class="callout danger"><strong>基准不同版</strong><p>指纹不同：<span class="mono">${esc(
          shortHash(a.baseFingerprint),
        )}</span> ≠ <span class="mono">${esc(shortHash(b.baseFingerprint))}</span>。差异如下：</p></div>
         ${diffRows(a, b)}`;
  } catch (error) {
    host.innerHTML = `<div class="callout danger">无法读取对照任务：${esc(error.message)}</div>`;
  }
}

/** 前端只做展示级差异；权威差异由服务端 baseDiff 在归属比较接口给出。 */
function diffRows(a, b) {
  const diffs = [];
  if (a.baseVersion !== b.baseVersion) diffs.push(`基准版本：${a.baseVersion} → ${b.baseVersion}`);
  const fa = new Map(a.snapshot.factors.map((f) => [f.id, f]));
  for (const factor of b.snapshot.factors) {
    const other = fa.get(factor.id);
    if (!other) {
      diffs.push(`因子「${factor.label}」仅存在于后者`);
    } else if (other.kgPerUnit !== factor.kgPerUnit) {
      diffs.push(`因子「${factor.label}」基准值 ${fmtNum(other.kgPerUnit)} → ${fmtNum(factor.kgPerUnit)} kg/${factor.unit}`);
    }
  }
  const ia = new Map(a.snapshot.items.map((i) => [i.id, i]));
  for (const item of b.snapshot.items) {
    const other = ia.get(item.id);
    if (!other) diffs.push(`活动「${item.label}」仅存在于后者`);
    else if (other.activity.base !== item.activity.base) {
      diffs.push(`活动「${item.label}」基准量 ${fmtNum(other.activity.base, 0)} → ${fmtNum(item.activity.base, 0)} ${item.unit}`);
    }
  }
  if (JSON.stringify(a.snapshot.boundaryChanges ?? []) !== JSON.stringify(b.snapshot.boundaryChanges ?? [])) {
    diffs.push('组织边界重述记录不同');
  }
  return diffs.length
    ? diffs.map((d) => `<div class="diff-row">${esc(d)}</div>`).join('')
    : `<div class="hint">未发现基准内容差异，但指纹仍不同，可能来自边界描述或口径。</div>`;
}

/* ------------------------------------------------------------------ */
/* 事件                                                                 */
/* ------------------------------------------------------------------ */

function renderAll() {
  if (!state.attribution) return;
  renderContext();
  renderOverview();
  renderAttribution();
  renderData();
  renderGovernance();
  renderDirtySummary();
}

function wireEvents() {
  $('#actor').addEventListener('change', (event) => {
    state.actor = event.target.value.trim() || '分析员';
    localStorage.setItem('actor', state.actor);
  });

  $$('.tab').forEach((btn) =>
    btn.addEventListener('click', () => {
      setTab(btn.dataset.tab);
      if (btn.dataset.tab === 'governance') renderGovernance();
    }),
  );

  // 数据菜单
  const menuBtn = $('#data-menu-btn');
  const menuPanel = $('.menu-panel');
  menuBtn.addEventListener('click', () => {
    const open = menuPanel.hidden;
    menuPanel.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.menu')) {
      menuPanel.hidden = true;
      menuBtn.setAttribute('aria-expanded', 'false');
    }
  });

  $('#export-btn').addEventListener('click', () => {
    menuPanel.hidden = true;
    location.href = '/api/export';
  });
  $('#import-btn').addEventListener('click', () => {
    menuPanel.hidden = true;
    $('#import-file').click();
  });
  $('#import-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const ok = await openDialog({
        title: '从导出文件恢复',
        body: '这会用文件中的工作区替换当前所有任务、报告与审计记录。已确认报告会按文件中的哈希重新校验，校验不通过则拒绝导入。',
        okLabel: '导入并替换',
        danger: true,
      });
      if (!ok) return;
      await api('/api/import', { method: 'POST', body: JSON.stringify({ workspace: parsed }) });
      state.dirty.clear();
      state.compareTo = '';
      await refreshSummary();
      state.batchId = state.summary.batches.find((b) => b.status === 'draft')?.id ?? state.summary.batches[0]?.id;
      await loadBatch();
      renderAll();
      toast('已恢复', '工作区已从导出文件载入，审计记录已追加。');
    } catch (error) {
      if (error instanceof SyntaxError) toast('文件不是合法 JSON', error.message, 'error');
      else showError(error);
    }
  });
  $('#reset-btn').addEventListener('click', async () => {
    menuPanel.hidden = true;
    const ok = await openDialog({
      title: '重置为演示初始状态',
      body: '当前所有任务、报告与审计记录会被替换为初始虚构数据。此操作不可撤销，建议先导出。',
      okLabel: '重置',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/reset', { method: 'POST', body: JSON.stringify({ confirm: 'reset' }) });
      state.dirty.clear();
      state.compareTo = '';
      await refreshSummary();
      state.batchId = state.summary.batches.find((b) => b.status === 'draft')?.id ?? state.summary.batches[0]?.id;
      await loadBatch();
      renderAll();
      toast('已重置', '演示数据已恢复。');
    } catch (error) {
      showError(error);
    }
  });

  // 归属视图
  $('#method-switch').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-method]');
    if (!btn || btn.dataset.method === state.method) return;
    state.method = btn.dataset.method;
    try {
      await loadBatch();
      renderAll();
    } catch (error) {
      showError(error);
    }
  });
  $('#compare-select').addEventListener('change', async (event) => {
    state.compareTo = event.target.value;
    try {
      await loadBatch();
      renderAll();
    } catch (error) {
      showError(error);
    }
  });
  $('#refresh-attribution').addEventListener('click', () => refreshAll({ keepDirty: true }));

  // 数据视图：编辑
  $('#view-data').addEventListener('input', (event) => {
    const input = event.target.closest('[data-edit]');
    if (!input) return;
    const kind = input.dataset.edit;
    const id = input.dataset.id;
    if (kind === 'project-active') {
      const key = `project-active:${id}`;
      state.dirty.set(key, { kind, id, value: input.checked });
      const label = input.closest('label');
      label.lastChild.textContent = input.checked ? '纳入' : '排除';
      renderDirtySummary();
      return;
    }
    const value = input.value;
    const numeric = Number(value);
    if (value !== '' && (!Number.isFinite(numeric) || numeric < 0)) {
      input.classList.add('dirty');
      toast('请输入非负数值', '', 'warn', 2500);
      return;
    }
    const key = `${kind}:${id}`;
    if (value === '') state.dirty.delete(key);
    else state.dirty.set(key, { kind, id, value: numeric });
    input.classList.toggle('dirty', state.dirty.has(key));
    renderDirtySummary();
  });

  $('#discard-edits').addEventListener('click', () => {
    state.dirty.clear();
    renderData();
  });

  $('#apply-edits').addEventListener('click', async () => {
    if (state.dirty.size === 0) return;
    const patch = { activity: {}, factors: {}, projects: {} };
    for (const entry of state.dirty.values()) {
      if (entry.kind === 'activity') {
        patch.activity[entry.id] = { report: entry.value };
      } else if (entry.kind === 'factor') {
        patch.factors[entry.id] = { reportKgPerUnit: entry.value };
      } else if (entry.kind === 'project') {
        patch.projects[entry.id] = { ...(patch.projects[entry.id] ?? {}), activityReduction: entry.value };
      } else if (entry.kind === 'project-active') {
        patch.projects[entry.id] = { ...(patch.projects[entry.id] ?? {}), active: entry.value };
      }
    }
    try {
      await api(`/api/batches/${state.batchId}/assumptions`, {
        method: 'PATCH',
        body: JSON.stringify({ patch, expectedHash: state.attribution.batch.contentHash }),
      });
      state.dirty.clear();
      await refreshAll();
      toast('修改已应用', '归属结果与审计记录已更新。');
    } catch (error) {
      showError(error);
    }
  });

  $('#download-template').addEventListener('click', () => {
    if (!state.batchId) return;
    location.href = `/api/batches/${state.batchId}/activity.csv`;
  });

  $('#ingest-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const file = data.get('file');
    if (!(file instanceof File) || file.size === 0) {
      toast('请选择 CSV 文件', '', 'warn');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast('文件过大', '演示工具限制 2 MB 以内。', 'warn');
      return;
    }
    const csv = await file.text();
    try {
      const result = await api(`/api/batches/${state.batchId}/ingest`, {
        method: 'POST',
        body: JSON.stringify({
          csv,
          sourceLabel: data.get('sourceLabel'),
          note: data.get('note'),
          expectedHash: state.attribution.batch.contentHash,
        }),
      });
      form.reset();
      await refreshAll();
      const changed = result.changes?.length ?? 0;
      toast('数据已接入', `${result.ingestion.rowCount} 行解析，改动 ${changed} 条活动；基准指纹未变。`);
    } catch (error) {
      if (error.details?.problems?.length) {
        toast('数据文件未通过校验', error.details.problems.slice(0, 4).join('；'), 'error', 9000);
      } else {
        showError(error);
      }
    }
  });

  $('#retro-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const ok = await openDialog({
      title: '执行因子追溯更正',
      body: '这会改变基准期因子与基准指纹，其它任务将不再与当前任务同版。已确认报告不受影响。',
      okLabel: '确认更正',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/batches/${state.batchId}/retro-factor`, {
        method: 'POST',
        body: JSON.stringify({
          factorId: data.get('factorId'),
          baseKgPerUnit: Number(data.get('baseKgPerUnit')),
          reportKgPerUnit: data.get('reportKgPerUnit') ? Number(data.get('reportKgPerUnit')) : undefined,
          note: data.get('note'),
          expectedHash: state.attribution.batch.contentHash,
        }),
      });
      await refreshAll();
      toast('因子已追溯更正', '基准指纹已变化；请在归属视图中检查结果。');
    } catch (error) {
      showError(error);
    }
  });

  $('#boundary-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const data = new FormData(form);
    const ok = await openDialog({
      title: '重述基准期组织边界',
      body: '这会修改基准期活动量并改变基准指纹。重述量不计入任何项目归属。',
      okLabel: '确认重述',
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/batches/${state.batchId}/restate-boundary`, {
        method: 'POST',
        body: JSON.stringify({
          itemId: data.get('itemId'),
          kind: data.get('kind'),
          newBaseActivity: Number(data.get('newBaseActivity')),
          note: data.get('note'),
          expectedHash: state.attribution.batch.contentHash,
        }),
      });
      await refreshAll();
      toast('基准期已重述', '基准指纹已变化，请检查同版状态。');
    } catch (error) {
      showError(error);
    }
  });

  // 治理视图：任务列表操作（事件委托）
  $('#batch-list').addEventListener('click', async (event) => {
    const open = event.target.closest('[data-open]');
    if (open) return openBatch(open.dataset.open);
    const close = event.target.closest('[data-close]');
    if (close) {
      const reason = await openDialog({
        title: '关闭草稿',
        body: '关闭后该草稿不可编辑，也不会生成报告。',
        input: { label: '关闭原因', placeholder: '例如：被新任务取代' },
        okLabel: '关闭草稿',
        danger: true,
      });
      if (!reason) return;
      try {
        await api(`/api/batches/${close.dataset.close}/close`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
        await refreshAll();
        toast('草稿已关闭');
      } catch (error) {
        showError(error);
      }
      return;
    }
    const confirm = event.target.closest('[data-confirm-batch]');
    if (confirm) {
      if (confirm.dataset.confirmBatch !== state.batchId) await openBatch(confirm.dataset.confirmBatch);
      if (!state.batchId) return;
      setTab('governance');
      $('#confirm-label').focus();
      toast('请在右侧确认', '填写报告名称并选择方法后确认。');
      return;
    }
    const supersede = event.target.closest('[data-supersede]');
    if (supersede) {
      if (supersede.dataset.supersede !== state.batchId) await openBatch(supersede.dataset.supersede);
      setTab('governance');
      $('#supersede-form [name="reason"]').focus();
      toast('请在右侧填写追溯更正原因');
    }
  });

  $('#report-list').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-retract]');
    if (!btn) return;
    const reason = await openDialog({
      title: '撤回报告',
      body: '撤回不会删除报告：原有内容与哈希保留，状态改为“已撤回”。报告内容永远不可编辑。',
      input: { label: '撤回原因', placeholder: '例如：发现基准期数据错误' },
      okLabel: '撤回报告',
      danger: true,
    });
    if (!reason) return;
    try {
      await api(`/api/reports/${btn.dataset.retract}/retract`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      await refreshAll();
      toast('报告已撤回', '原报告仍保留在列表中，可供追溯。');
    } catch (error) {
      showError(error);
    }
  });

  $('#confirm-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const ok = await openDialog({
      title: '确认并出具报告',
      body: '确认后任务封存、内容哈希锁定；此后任何修改都必须通过追溯更正创建新任务。',
      okLabel: '确认出具',
    });
    if (!ok) return;
    try {
      const result = await api(`/api/batches/${state.batchId}/confirm`, {
        method: 'POST',
        body: JSON.stringify({
          reportLabel: data.get('reportLabel'),
          method: data.get('method'),
          expectedHash: state.attribution.batch.contentHash,
        }),
      });
      await refreshAll();
      toast('报告已出具', `内容哈希 ${shortHash(result.report.hash)}；旧任务已不可修改。`);
    } catch (error) {
      showError(error);
    }
  });

  $('#supersede-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    const ok = await openDialog({
      title: '创建追溯更正草稿',
      body: '原已确认任务保持只读并标记“已被取代”；新草稿复制其快照，供后续更正。旧报告的哈希不变。',
      okLabel: '创建更正草稿',
      danger: true,
    });
    if (!ok) return;
    try {
      const replacement = await api(`/api/batches/${state.batchId}/supersede`, {
        method: 'POST',
        body: JSON.stringify({ reason: data.get('reason') }),
      });
      await refreshSummary();
      await openBatch(replacement.id);
      toast('已创建更正草稿', '旧任务与旧报告保持原样并留痕。');
    } catch (error) {
      showError(error);
    }
  });

  $('#new-batch').addEventListener('click', async () => {
    const summary = state.summary;
    const site = summary.sites[0];
    const dialog = $('#dialog');
    $('#dialog-title').textContent = '新建复核任务';
    $('#dialog-body').innerHTML = `
      <p>新任务默认复制当前任务的快照，以便在相同基准与报告期假设上继续工作。</p>
      <label>站点<select id="new-site">${summary.sites
        .map((s) => `<option value="${s.id}">${esc(s.name)}</option>`)
        .join('')}</select></label>
      <label>核算口径<input id="new-caliber" type="text" value="${esc(state.batch?.caliber ?? '')}" /></label>
      <label>任务名称<input id="new-label" type="text" value="复核任务 ${new Date().toLocaleDateString('zh-CN')}" /></label>
      <label>复制来源<select id="new-source">
        <option value="">不复制（使用站点默认快照）</option>
        ${summary.batches
          .map((b) => `<option value="${b.id}"${b.id === state.batchId ? ' selected' : ''}>${esc(b.label)}（${esc(b.statusLabel)}）</option>`)
          .join('')}
      </select></label>
    `;
    $('#dialog-ok').textContent = '创建任务';
    $('#dialog-ok').className = 'btn btn-primary';
    dialog.returnValue = '';
    dialog.showModal();
    dialog.onclose = async () => {
      dialog.onclose = null;
      if (dialog.returnValue !== 'ok') return;
      dialog.returnValue = '';
      try {
        const batch = await api('/api/batches', {
          method: 'POST',
          body: JSON.stringify({
            siteId: $('#new-site').value,
            caliber: $('#new-caliber').value,
            label: $('#new-label').value,
            copyFrom: $('#new-source').value || null,
          }),
        });
        await refreshSummary();
        await openBatch(batch.id);
        toast('任务已创建', batch.label);
      } catch (error) {
        showError(error);
      }
    };
  });

  $('#diff-a').addEventListener('change', renderDiff);
  $('#diff-b').addEventListener('change', renderDiff);

  window.addEventListener('hashchange', checkUrlHash);
}

boot();
