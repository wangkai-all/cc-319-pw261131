/** 纯格式化工具，无依赖。 */

export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const abs = (n) => Math.abs(Number.isFinite(n) ? n : 0);

export function fmtNum(value, digits = 0) {
  const n = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
}

/** kg → t。 */
export function fmtT(kg, digits = 1) {
  return fmtNum(abs(kg) / 1000, digits);
}

/** 带符号的 t 值：负号用 U+2212，避免与连字符混淆。 */
export function fmtTDelta(kg, digits = 1) {
  const n = Number.isFinite(kg) ? kg : 0;
  const t = n / 1000;
  if (Math.abs(t) < 0.05) return fmtNum(0, digits);
  return `${t < 0 ? '−' : '+'}${fmtNum(Math.abs(t), digits)}`;
}

export function fmtKg(kg, digits = 0) {
  const n = Number.isFinite(kg) ? kg : 0;
  return `${n < 0 ? '−' : ''}${fmtNum(Math.abs(n), digits)}`;
}

export function fmtPct(value, digits = 1) {
  const n = Number.isFinite(value) ? value : 0;
  return `${fmtNum(n, digits)}%`;
}

export function shortHash(hash) {
  return hash ? String(hash).slice(0, 10) : '—';
}

export function relTime(iso) {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return String(iso);
  const diff = Date.now() - then;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}
