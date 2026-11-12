/* 上游行情源抓取。解析逻辑 1:1 搬自前端 app.js 的多源方案，区别只在
 * 「服务端没有 CORS 限制、且一次抓取全站共享」。
 *
 *   jrj       一次 POST 拿沪深全市场现价+涨跌幅（实测 ~84ms / 5213 只）
 *   腾讯批量   北交所/ETF = 简版 s_；港股 = 全量 hk；每批 ≤150 个代码
 *   同花顺     当日成交额摘要（与原站摘要条同源同口径）
 *   东财      行业板块主力净流入排行（服务端可直连；浏览器侧当年会被风控空响应）
 *
 * 约定：所有函数失败即抛错，由调用方决定「保留上一份数据」。 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 8000);
const QT_URL = 'https://qt.gtimg.cn/q=';
const THS_URL = 'https://dq.10jqka.com.cn/fuyao/market_analysis_api/chart/v1/get_chart_data?chart_key=turnover_minute';
const EM_FLOW_URL = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&np=1&fltt=2&invt=2&fid=f62&fs=m:90+t:2&fields=f14,f62,f184';

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round2 = v => Math.round(v * 100) / 100;

function req(url, init = {}) {
  return fetch(url, {
    ...init,
    headers: { 'user-agent': UA, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/* 并发受限的 map（对上游礼貌一点，也便于日志定位是哪批失败） */
async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  }));
}

/* ---- jrj：一次 POST 拿沪深全部 ----
 * 键 '1'+代码 = 沪 / '2'+代码 = 深；v.np = 现价，v.var = 涨跌幅小数 → ×100 成 % */
export async function fetchJrj() {
  const res = await req('https://gateway.jrj.com/quot-dpyt/hq', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ column: 'chg' }),
  });
  if (!res.ok) throw new Error('jrj http ' + res.status);
  const hqs = (await res.json()).data?.hqs ?? {};
  const out = {};
  for (const k of Object.keys(hqs)) {
    const suf = k[0] === '1' ? 'SH' : k[0] === '2' ? 'SZ' : null;
    if (!suf) continue;
    const v = hqs[k];
    const price = num(v.np);
    if (price == null) continue;
    out[k.slice(1) + '.' + suf] = [price, round2((num(v.var) ?? 0) * 100)];
  }
  return out;
}

/* ---- 腾讯批量 ----
 * s_ 简版（北交所/ETF）：f[3]=现价 f[5]=涨跌% f[7]=成交额(万元)
 * hk 全量（港股）：f[3]=现价 f[4]=昨收（现算涨跌%）f[37]=成交额(元) */
export async function fetchTencent(codes, mode = 's') {
  const batches = [];
  for (let i = 0; i < codes.length; i += 150) {
    batches.push(codes.slice(i, i + 150).map(c => {
      const [sym, mkt] = String(c).split('.');
      return mode === 'hk' ? 'hk' + sym : 's_' + mkt.toLowerCase() + sym;
    }).join(','));
  }
  const out = {};
  let failBatches = 0;
  await mapLimit(batches, 6, async (batch, bi) => {
    try {
      const res = await req(QT_URL + batch);
      if (!res.ok) throw new Error('http ' + res.status);
      const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
      for (const line of text.split(';')) {
        const s = line.trim();   // 响应以 ";\n" 分隔，第二行起带换行符——不 trim 会被 ^ 锚定跳过
        const m = mode === 'hk'
          ? /^v_hk(\d+)="([^"]*)"/.exec(s)
          : /^v_s_([a-z]{2})(\d+)="([^"]*)"/.exec(s);
        if (!m) continue;
        const code = mode === 'hk' ? m[1] + '.HK' : m[2] + '.' + m[1].toUpperCase();
        const f = (mode === 'hk' ? m[2] : m[3]).split('~');
        const price = parseFloat(f[3]);
        if (!isFinite(price)) continue;
        let pct = null;
        if (mode === 'hk') {
          const prev = parseFloat(f[4]);
          if (isFinite(prev) && prev > 0) pct = round2((price - prev) / prev * 100);
        } else {
          const p = parseFloat(f[5]);
          if (isFinite(p)) pct = round2(p);
        }
        const amt = parseFloat(mode === 'hk' ? f[37] : f[7]);
        out[code] = isFinite(amt) ? [price, pct, Math.round(mode === 'hk' ? amt : amt * 1e4)] : [price, pct];
      }
    } catch (e) {
      failBatches++;
      console.warn(`[sources] 腾讯 ${mode} 第 ${bi + 1} 批失败: ${e.message}`);
    }
  });
  if (failBatches === batches.length) throw new Error(`腾讯 ${mode} 全部 ${batches.length} 批失败`);
  if (failBatches) console.warn(`[sources] 腾讯 ${mode} ${failBatches}/${batches.length} 批失败（已用其余批次）`);
  return out;
}

/* ---- 指数（一个腾讯批量请求） ----
 * 键 3 种形态：简版 v_s_sh000001（取 f[5]）/ 全量 v_sh000001、v_r_hkHSI（f[3]/f[4] 现算） */
export async function fetchIndices(codes) {
  const res = await req(QT_URL + codes.join(','));
  if (!res.ok) throw new Error('idx http ' + res.status);
  const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
  const out = {};
  for (const line of text.split(';')) {
    const m = /^v_(s_)?([\w]+)="([^"]*)"/.exec(line.trim());
    if (!m) continue;
    const f = m[3].split('~');
    const price = parseFloat(f[3]);
    let pct = null;
    if (m[1]) {
      const p = parseFloat(f[5]);
      if (isFinite(p)) pct = round2(p);
    } else {
      const prev = parseFloat(f[4]);
      if (isFinite(price) && isFinite(prev) && prev > 0) pct = round2((price - prev) / prev * 100);
    }
    out[m[2]] = { price: isFinite(price) ? price : null, pct };
  }
  if (!Object.keys(out).length) throw new Error('idx 解析结果为空');
  return out;
}

/* ---- 同花顺：当日成交额摘要（header 直出当日/昨日/变动） ---- */
export async function fetchTurnover() {
  const res = await req(THS_URL, { headers: { referer: 'https://www.10jqka.com.cn/' } });
  if (!res.ok) throw new Error('ths http ' + res.status);
  const h = {};
  for (const it of (await res.json()).data?.charts?.header ?? []) h[it.key] = it.val;
  const amount = num(h.turnover);
  if (amount == null) throw new Error('ths 形状变了');
  const previous = num(h.turnover_pre);
  return {
    amount, previous,
    delta: num(h.turnover_change) ?? (previous != null ? amount - previous : null),
  };
}

/* ---- 东财：行业板块主力净流入 Top20 / 净流出 Top20 ---- */
export async function fetchFlow() {
  const parse = r => {
    if (!r.ok) throw new Error('em http ' + r.status);
    return r.json().then(d => (d.data?.diff || []).map(x => ({ name: x.f14, amt: x.f62, pct: x.f184 })));
  };
  const hdr = { referer: 'https://data.eastmoney.com/' };
  const [inArr, outArr] = await Promise.all([
    req(EM_FLOW_URL + '&po=1', { headers: hdr }).then(parse),
    req(EM_FLOW_URL + '&po=0', { headers: hdr }).then(parse),
  ]);
  return { in: inArr.slice(0, 20), out: outArr.slice(0, 20) };
}
