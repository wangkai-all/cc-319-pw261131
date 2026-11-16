/**
 * 零依赖 HTTP 服务：静态页面 + JSON API + 本地持久化。
 * 所有数值均为虚构演示。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { summarize, METHODS } from './accounting.js';
import {
  GovernanceError,
  STATUS_LABEL,
  baseDiff,
  batchBaseFingerprint,
  batchHash,
  closeDraft,
  confirmBatch,
  createDraft,
  createWorkspace,
  activityCsv,
  exportWorkspace,
  findBatch,
  ingestActivity,
  importWorkspace,
  rebaseDraft,
  restateBoundary,
  retractReport,
  retroCorrectFactor,
  stateSummary,
  supersedeBatch,
  updateAssumptions,
} from './ledger.js';
import { buildSeedState } from './seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '127.0.0.1';

let workspace = null;
let writeQueue = Promise.resolve();

async function loadState() {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8');
    workspace = importWorkspace(raw, { actor: '系统' });
    console.log(`[state] 从 ${STATE_FILE} 恢复`);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.name !== 'GovernanceError') throw error;
    if (error.name === 'GovernanceError') {
      console.warn(`[state] 现有状态文件无法通过校验：${error.message}；重新生成演示数据`);
    }
    workspace = buildSeedState().workspace;
    console.log('[state] 初始化虚构演示数据');
  }
  await persist();
}

function persist() {
  const snapshot = JSON.stringify(workspace, null, 2);
  writeQueue = writeQueue.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.${randomUUID()}.tmp`;
    await fsp.writeFile(tmp, snapshot, 'utf8');
    await fsp.rename(tmp, STATE_FILE);
  });
  return writeQueue;
}

function send(res, status, body, headers = {}) {
  const payload =
    typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function fail(res, error) {
  if (error instanceof GovernanceError) {
    send(res, error.statusCode, {
      error: { code: error.code, message: error.message, details: error.details ?? {} },
    });
    return;
  }
  console.error(error);
  send(res, 500, { error: { code: 'INTERNAL', message: '服务器内部错误' } });
}

const MAX_BODY = 8 * 1024 * 1024;

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new GovernanceError('VALIDATION', '请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GovernanceError('VALIDATION', '请求体不是合法 JSON');
  }
}

const decodeActor = (raw) => {
  const value = String(raw ?? '').trim();
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const actorFrom = (req, body) =>
  (body?.actor ?? decodeActor(req.headers['x-actor']) ?? '分析员').toString().slice(0, 60) || '分析员';

function batchView(batch) {
  const reports = workspace.reports.filter((r) => r.batchId === batch.id);
  return {
    id: batch.id,
    siteId: batch.siteId,
    caliber: batch.caliber,
    label: batch.label,
    createdAt: batch.createdAt,
    createdBy: batch.createdBy,
    status: batch.status,
    statusLabel: STATUS_LABEL[batch.status] ?? batch.status,
    editable: batch.status === 'draft',
    basedOn: batch.basedOn,
    derivedFromHash: batch.derivedFromHash ?? null,
    baseVersion: batch.snapshot.baseVersion ?? 'v1',
    baseFingerprint: batchBaseFingerprint(batch),
    contentHash: batchHash(batch),
    confirmed: batch.confirmed,
    superseded: batch.superseded ?? null,
    closed: batch.closed ?? null,
    reports,
    boundaryText: batch.snapshot.boundaryText ?? '',
    periods: {
      base: batch.snapshot.basePeriodLabel ?? '基准期',
      report: batch.snapshot.reportPeriodLabel ?? '报告期',
    },
    assumptions: batch.snapshot.assumptions ?? {},
    snapshot: batch.snapshot,
  };
}

function attributionView(batch, method, secondBatch = null) {
  const snapshot = batch.snapshot;
  const data = summarize(snapshot, method);
  const view = {
    batch: batchView(batch),
    method,
    methods: Object.values(METHODS),
    ...data,
  };
  if (secondBatch) {
    const sameBase = batchBaseFingerprint(batch) === batchBaseFingerprint(secondBatch);
    view.comparison = {
      otherBatchId: secondBatch.id,
      otherLabel: secondBatch.label,
      otherStatus: secondBatch.status,
      otherBaseFingerprint: batchBaseFingerprint(secondBatch),
      sameBase,
      differences: sameBase ? [] : baseDiff(batch, secondBatch),
      note: sameBase
        ? '两个任务的基准指纹一致，可以直接对照。'
        : '两个任务的基准不同版：下面的并排数字不可直接相减，请先同步基准。',
    };
  }
  return view;
}

const routes = [
  {
    method: 'GET',
    match: /^\/api\/meta$/,
    handler: async (_req, res) => {
      send(res, 200, {
        name: '减排归因与版本核算实验室（虚构演示）',
        methods: Object.values(METHODS),
        statusLabels: STATUS_LABEL,
        disclosure:
          '全部站点、活动数据、因子与项目均为虚构；本工具不声称符合任何未指定的认证、核查或报告标准。',
      });
    },
  },
  {
    method: 'GET',
    match: /^\/api\/state$/,
    handler: async (_req, res) => {
      send(res, 200, {
        ...stateSummary(workspace),
        disclosure:
          '虚构演示数据。归属方法只解释“项目效应”部分，不把两份申报直接相加。',
      });
    },
  },
  {
    method: 'GET',
    match: /^\/api\/batches\/([^/]+)$/,
    handler: async (_req, res, [batchId]) => {
      const batch = findBatch(workspace, batchId);
      send(res, 200, batchView(batch));
    },
  },
  {
    method: 'GET',
    match: /^\/api\/batches\/([^/]+)\/attribution$/,
    handler: async (req, res, [batchId], url) => {
      const batch = findBatch(workspace, batchId);
      const method = url.searchParams.get('method') ?? 'shapley';
      const compareTo = url.searchParams.get('compareTo');
      let second = null;
      if (compareTo) second = findBatch(workspace, compareTo);
      send(res, 200, attributionView(batch, method, second));
    },
  },
  {
    method: 'POST',
    match: /^\/api\/batches$/,
    handler: async (req, res) => {
      const body = await readJson(req);
      const batch = createDraft(workspace, {
        siteId: body.siteId,
        caliber: body.caliber,
        label: body.label,
        actor: actorFrom(req, body),
        copyFrom: body.copyFrom ?? null,
      });
      await persist();
      send(res, 201, batchView(batch));
    },
  },
  {
    method: 'PATCH',
    match: /^\/api\/batches\/([^/]+)\/assumptions$/,
    handler: async (req, res, [batchId]) => {
      const body = await readJson(req);
      const batch = updateAssumptions(workspace, batchId, body.patch ?? {}, {
        actor: actorFrom(req, body),
        expectedHash: body.expectedHash,
      });
      await persist();
      send(res, 200, batchView(batch));
    },
  },
  {
    method: 'GET',
    match: /^\/api\/batches\/([^/]+)\/activity\.csv$/,
    handler: async (_req, res, [batchId]) => {
      const batch = findBatch(workspace, batchId);
      send(res, 200, activityCsv(batch), {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="activity-${batchId.slice(0, 8)}.csv"`,
      });
    },
  },
  {
    method: 'POST',
    match: /^\/api\/batches\/([^/]+)\/ingest$/,
    handler: async (req, res, [batchId]) => {
      const body = await readJson(req);
      const result = ingestActivity(workspace, batchId, {
        csv: body.csv,
        sourceLabel: body.sourceLabel,
        note: body.note,
        actor: actorFrom(req, body),
        expectedHash: body.expectedHash,
      });
      await persist();
      send(res, 200, {
        batch: batchView(result.batch),
        ingestion: result.ingestion,
        changes: result.changes,
      });
    },
  },
  {
    method: 'POST',
    match: /^\/api\/batches\/([^/]+)\/retro-factor$/,
    handler: async (req, res, [batchId]) => {
      const body = await readJson(req);
      const batch = retroCorrectFactor(workspace, batchId, {
        ...body,
        actor: actorFrom(req, body),
      });
      await persist();
      send(res, 200, batchView(batch));
    },
  },
  {
    method: 'POST',
    match: /^\/api\/batches\/([^/]+)\/restate-boundary$/,
    handler: async (req, res, [batchId]) => {
      const body = await readJson(req);
      const batch = restateBoundary(workspace, batchId, {
        ...body,
        actor: actorFrom(req, body),
      });
      await persist();
      send(res, 200, batchView(batch));
    },
  },
  {
    method: 'POST',
    match: /^\/api\/batches\/([^/]+)\/rebase$/,
    handler: async (req, res, [batchId]) => {
      const body = await readJson(req);
      const batch = rebaseDraft(workspace, batchId, {
        sourceBatchId: body.sourceBatchId,
        actor: actorFrom(req, body),
        expectedHash: body.expectedHash,
      });
      await persist();
      send(res, 200, batchView(batch));
    },
  },
  {
    method: 'POST',
    match: /^\/api\/batches\/([^/]+)\/confirm$/,
    handler: async (req, res, [batchId]) => {
      const body = await readJson(req);
      const report = confirmBatch(workspace, batchId, {
        actor: actorFrom(req, body),
        reportLabel: body.reportLabel,
        method: body.method,
        expectedHash: body.expectedHash,
      });
      await persist();
      send(res, 201, { report, batch: batchView(findBatch(workspace, batchId)) });
    },
  },
  {
    method: 'POST',
    match: /^\/api\/batches\/([^/]+)\/supersede$/,
    handler: async (req, res, [batchId]) => {
      const body = await readJson(req);
      const replacement = supersedeBatch(workspace, batchId, {
        actor: actorFrom(req, body),
        reason: body.reason,
      });
      await persist();
      send(res, 201, batchView(replacement));
    },
  },
  {
    method: 'POST',
    match: /^\/api\/batches\/([^/]+)\/close$/,
    handler: async (req, res, [batchId]) => {
      const body = await readJson(req);
      const batch = closeDraft(workspace, batchId, {
        actor: actorFrom(req, body),
        reason: body.reason,
      });
      await persist();
      send(res, 200, batchView(batch));
    },
  },
  {
    method: 'POST',
    match: /^\/api\/reports\/([^/]+)\/retract$/,
    handler: async (req, res, [reportId]) => {
      const body = await readJson(req);
      const report = retractReport(workspace, reportId, {
        actor: actorFrom(req, body),
        reason: body.reason,
      });
      await persist();
      send(res, 200, { report });
    },
  },
  {
    method: 'GET',
    match: /^\/api\/export$/,
    handler: async (_req, res) => {
      const body = JSON.stringify(exportWorkspace(workspace), null, 2);
      send(res, 200, body, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="emissions-attribution-${new Date()
          .toISOString()
          .slice(0, 10)}.json"`,
      });
    },
  },
  {
    method: 'POST',
    match: /^\/api\/import$/,
    handler: async (req, res) => {
      const body = await readJson(req);
      const raw = body.workspace ?? body;
      const restored = importWorkspace(raw, { actor: actorFrom(req, body) });
      workspace = restored;
      await persist();
      send(res, 200, { ok: true, ...stateSummary(workspace) });
    },
  },
  {
    method: 'POST',
    match: /^\/api\/reset$/,
    handler: async (req, res) => {
      const body = await readJson(req);
      if (body.confirm !== 'reset') {
        throw new GovernanceError('VALIDATION', '重置需要 confirm: "reset"');
      }
      workspace = buildSeedState().workspace;
      await persist();
      send(res, 200, { ok: true, ...stateSummary(workspace) });
    },
  },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    return send(res, 403, { error: { code: 'FORBIDDEN', message: '禁止访问' } });
  }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    const data = await fsp.readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    if (pathname.startsWith('/api/')) {
      return send(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
    }
    const fallback = path.join(PUBLIC_DIR, 'index.html');
    try {
      const data = await fsp.readFile(fallback);
      res.writeHead(200, { 'content-type': MIME['.html'] });
      res.end(data);
    } catch {
      send(res, 404, { error: { code: 'NOT_FOUND', message: '页面不存在' } });
    }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    for (const route of routes) {
      if (req.method !== route.method) continue;
      const match = route.match.exec(url.pathname);
      if (!match) continue;
      await route.handler(req, res, match.slice(1), url);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url.pathname);
      return;
    }
    send(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } });
  } catch (error) {
    fail(res, error);
  }
});

async function main() {
  await loadState();
  server.listen(PORT, HOST, () => {
    console.log(`虚构演算台已启动：http://${HOST}:${PORT}`);
    console.log('全部数据为虚构，不构成任何认证或核查结论。');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { server, loadState, STATE_FILE };
