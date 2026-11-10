/* A股热力图（大盘云图 · 样式研究）
 * 渲染参数来自对 dapanyuntu.com 构建产物的逆向分析，代码为独立重写。
 * 画布只画地图区：三层嵌套二分 treemap（板块 → 子板块 → 个股），
 * score 归一化色阶（涨跌幅/涨跌停限额），四级自适应标签，视图缩放平移 + 命中测试。
 */
(() => {
'use strict';

/* ================= 数据 ================= */
const DATA = window.TREEMAP_DATA;
if (!DATA || !Array.isArray(DATA.nodes)) {
  document.getElementById('stage').innerHTML =
    '<p style="color:#f66;padding:2em">缺少 data/treemap.js —— 请先运行 <code>python3 make_data.py</code></p>';
  return;
}

/* ================= 主题（原站 rM.dark 原值提取，2026-11-09） ================= */
const T = {
  boardFill: '#20252d',
  subBoardFill: 'rgba(18,23,31,0.62)',          // 半透明，叠在 boardFill 上（比板块底更暗）
  subBoardBorder: 'rgba(148,163,184,0.30)',
  subBoardInner: 'rgba(8,47,73,0.92)',          // 命中子板块的内圈描边
  boardBorder: 'rgba(148,163,184,0.48)',
  activeBoardStroke: '#f6d36d',
  activeSubBoardStroke: '#5eead4',
  bgStart: '#171b22',
  bgEnd: '#10141b',
  text: 'rgba(247,250,252,0.96)',
  textSoft: 'rgba(247,250,252,0.86)',
  shadow: 'rgba(0,0,0,0.42)',
  highlightOuter: 'rgba(2,6,23,0.92)',          // 外圈深色 + 内圈白（原站同款）
  highlightInner: '#f8fafc',
};
/* ================= 色阶：归一化涨跌幅 score（2026-11-10 替换原 ±20% 固定分档） =================
 * 颜色 = 相对涨跌空间：score = 真实涨跌幅 / 该标的当日涨跌幅限制，±1 统一代表涨/跌停。
 * 各板限额见 limitPctOf：主板 ±10%（ST 5%）、创业/科创 ±20%（ST 不减半）、北交所 ±30%。
 * 解决跨板块失真：创业板 +10% 只是半板（浅红），主板 +10% 是涨停（深红），不再同色；
 * 文字标注的仍是真实涨跌幅，颜色与文字两个信息互补。
 * 映射：|score|^0.65 幂矫正——A 股多数个股集中在小涨跌，线性分档会挤在低档看不出差别；
 * 幂 <1 放大中间段区分、涨跌停附近放缓，0.5~0.7 都是合理区间，改 POW_EXP 即可。
 * 档位：20 档 BAND_UP/BAND_DN 表，档心由 score 轴采样，档内不插值；表色按暗底调的，
 * 只想换色不改逻辑就改表。已知取舍：新股（N/C 前缀，前 5 日无涨跌幅）按板块限额钳到
 * ±1 不单独置灰；ETF 等无统一限额的标的落到 REF_LIMIT 兜底（当前画布只有 A 股个股）。 */
/* ================= 工具 ================= */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const font = (w, px) => `${w} ${px}px "Avenir Next Condensed","DIN Condensed","PingFang SC","Microsoft YaHei",Arial,sans-serif`;

const FLAT_EPS = 0.1;       // |pct| < 0.1 视为平盘

/* ================= 分割线宽度（可调，单位 CSS px） =================
 * 相邻色块各内缩 gap/2，露出的背景缝即为线宽。原站默认 2/2/1/0.5。 */
const GAP_BOARD = 0.5;      // 板块之间（原站 2）
const GAP_SUB = 0.5;        // 子板块之间（原站 2）
const GAP_STOCK_BIG = 0.25; // 大个股之间（原站 1）
const GAP_STOCK_SMALL = 0.125; // 小个股之间（原站 0.5）
/* 色带起点（2026-11-10 应用户要求扩大平盘↔涨跌停色差）：低档从"较艳深红/绿"降为低饱和
 * 灰粉/灰绿（紧挨平盘灰），沿 score 向端点平滑加深加艳；端点锚定原色 #ff2c2f / #00d641 不变。
 * 中小涨跌仍按 score 落在各自档位，相邻档依旧有区分；改回旧表直接还原下面两行即可。 */
const BAND_UP = {0:'#754849',1:'#7d4647',2:'#844446',3:'#8c4244',4:'#944042',5:'#9d3d3f',6:'#a63a3d',7:'#af373a',8:'#b83437',9:'#c13034',10:'#cb2c30',11:'#d5282d',12:'#dc272b',13:'#e2272c',14:'#e7282c',15:'#ec282d',16:'#f1292e',17:'#f62a2f',18:'#fb2b30',19:'#ff2d32'};
const BAND_DN = {0:'#406d4e',1:'#3e724e',2:'#3b774e',3:'#387c4d',4:'#35814d',5:'#32864d',6:'#2f8b4c',7:'#2c904c',8:'#29964b',9:'#269b4b',10:'#22a14a',11:'#1fa64a',12:'#1bac49',13:'#18b248',14:'#14b848',15:'#10be47',16:'#0cc446',17:'#08ca45',18:'#04d045',19:'#00d644'};
const FLAT_C = '#414554';

/* 涨跌幅限制（归一分母，与 changePct 同为百分数单位）：score = 涨跌幅 / limit，±1 = 涨/跌停 */
const POW_EXP = 0.65;       // 幂矫正指数：<1 放大中间段档位区分，涨跌停附近放缓
const REF_LIMIT = 10;       // 兜底限额（%）：无法识别的标的按 ±10% 折算
function limitPctOf(code, name) {
  const c = String(code || ''), n = String(name || '');
  if (c.endsWith('.BJ') || /^(43|82|83|87|88|92)/.test(c)) return 30;   // 北交所统一 30%
  if (/^(300|301|302)/.test(c)) return 20;   // 创业板（注册制后 ST 不减半）
  if (/^(688|689)/.test(c)) return 20;       // 科创板（同上）
  if (n.includes('ST')) return 5;            // 仅沪深主板 ST/*ST 减半
  return 10;                                 // 沪深主板其余；ETF 等落 10% 兜底
}
function stockLimit(s) {       // 惰性记忆在节点上，树/实时行情合并后的节点都适用
  if (s._limit == null) s._limit = limitPctOf(s.code, s.name);
  return s._limit;
}
function bandColorOf(score) {  // score∈[-1,1] → 20 档档色（幂矫正后取档，档内不插值）
  const v = Math.pow(Math.abs(score), POW_EXP);
  const k = Math.min(19, Math.floor(v * 20));
  return score > 0 ? BAND_UP[k] : BAND_DN[k];
}
function heatColor(pct, limit) {   // 画布色块/标题带/检视器共用：真实涨跌幅 + 限额 → 档色
  const p = pct || 0;
  if (Math.abs(p) < FLAT_EPS) return FLAT_C;
  return bandColorOf(clamp(p / (limit || REF_LIMIT), -1, 1));
}

const fmtPctLong = p => (p > 0 ? '+' : '') + p.toFixed(2) + '%';
const fmtPctShort = p => {
  const v = Math.abs(p), s = p.toFixed(v >= 10 ? 1 : 2);
  return (p > 0 ? '+' : '') + s + '%';
};
const fmtPrice = p => (p == null || !isFinite(p)) ? '—' : p.toFixed(p >= 100 ? 1 : 2);
const fmtAmount = v => {
  if (v == null || !isFinite(v) || v <= 0) return '—';
  if (v >= 1e12) return (v / 1e12).toFixed(2) + ' 万亿';
  if (v >= 1e8) return (v / 1e8).toFixed(v >= 1e10 ? 0 : 1) + ' 亿';
  return (v / 1e4).toFixed(0) + ' 万';
};
const fmtTime = iso => {
  const d = /^(\d{4}-\d{2}-\d{2})/.exec(iso || '');
  const m = /T(\d{2}:\d{2})/.exec(iso || '');
  return (d ? d[1] : '') + (m ? ' ' + m[1] : '') || iso || '—';
};
/* 东方财富行情图片（dapanyuntu 同源）：nid 市场号 SH=1 / SZ,BJ=0；港股无此图床 → 返回空 */
function emPic(code, type) {
  const i = String(code).indexOf('.');
  if (i < 0) return '';
  const mkt = String(code).slice(i + 1);
  if (mkt === 'HK') return '';
  const nid = mkt === 'SH' ? '1' : '0';
  return 'https://webquotepic.eastmoney.com/GetPic.aspx?nid=' + nid + '.' + String(code).slice(0, i) + '&imageType=' + type;
}
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

/* ================= 布局：二分 treemap（r9 同款算法） =================
 * 按值降序 → 找「前缀和最接近一半」的切分点 → 宽≥高竖切否则横切 → 递归。
 * 叶子按 gap/2 内缩；最终丢弃 w/h ≤1 的碎块。 */
function treemapLayout(items, x, y, w, h, gap = 0) {
  const out = [];
  const arr = items.filter(it => it.v > 0).sort((a, b) => b.v - a.v);
  const inset = (w, r) => {                    // w 是 {it, v} 包装，解包后再内缩
    const g = gap / 2;
    return { it: w.it, x: r.x + g, y: r.y + g, w: Math.max(0, r.w - gap), h: Math.max(0, r.h - gap) };
  };
  (function split(list, r) {
    if (list.length === 0 || r.w <= 1 || r.h <= 1) return;
    if (list.length === 1) { out.push(inset(list[0], r)); return; }
    const total = list.reduce((s, it) => s + it.v, 0);
    const half = total / 2;
    let acc = 0, best = 1, bestErr = Infinity;
    for (let i = 1; i < list.length; i++) {
      acc += list[i - 1].v;
      const err = Math.abs(half - acc);
      if (err < bestErr) { bestErr = err; best = i; }
    }
    const A = list.slice(0, best), B = list.slice(best);
    if (A.length === 0 || B.length === 0) {           // 退化：均匀横条
      const n = list.length, sh = r.h / n;
      list.forEach((it, i) => out.push(inset(it, { x: r.x, y: r.y + i * sh, w: r.w, h: sh })));
      return;
    }
    const ratio = A.reduce((s, it) => s + it.v, 0) / total;
    let ra, rb;
    if (r.w >= r.h) {
      const w1 = r.w * ratio;
      ra = { x: r.x, y: r.y, w: w1, h: r.h };
      rb = { x: r.x + w1, y: r.y, w: Math.max(0, r.w - w1), h: r.h };
    } else {
      const h1 = r.h * ratio;
      ra = { x: r.x, y: r.y, w: r.w, h: h1 };
      rb = { x: r.x, y: r.y + h1, w: r.w, h: Math.max(0, r.h - h1) };
    }
    split(A, ra); split(B, rb);
  })(arr, { x, y, w, h });
  return out.filter(o => o.w > 1 && o.h > 1);
}

/* ================= 全局状态 ================= */
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const stage = document.getElementById('stage');
const tip = document.getElementById('tip');

const view = { scale: 1, x: 0, y: 0 };            // 视图态：缩放 1~3 + 平移
const state = {
  market: 'all',            // 当前市场视图（MARKETS.id）：全部/上证/深证/沪深300/中证A500/创业板/科创板/北交所/ETF/港股
  sizeMode: 'value',        // value=流通市值(默认) | totalMarketCap | turnover
  focus: null,              // 聚焦的板块名（null=全图）
  hoverStock: null,         // 悬停个股矩形 {stock,x,y,w,h,boardName,subBoardName}
  hoverTitle: null,         // 悬停标题带 {kind:'board'|'sub', name, boardName}
  inspSort: 0,              // 检视器排序（SORT_KEYS 下标，S/Shift+S 循环）
  inspPinned: false,        // 检视器固定（G/按钮/单击个股），Esc/✕ 解除
};
let cssW = 0, cssH = 0, dpr = 1;
let L = null;               // 布局结果 {boards, subs, stocks}

/* 面积口径（原站 rB：非正数钳到 1，保证停牌/零值股有最小面积） */
function modeValue(stock) {
  if (state.sizeMode === 'turnover') {
    const v = stock.turnoverAmount;
    return Number.isFinite(v) && v > 0 ? v : 1;
  }
  if (state.sizeMode === 'totalMarketCap') {
    const v = stock.totalMarketCap;
    return Number.isFinite(v) && v > 0 ? v : 1;
  }
  const v = stock.value;
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/* 市值加权涨跌幅（原站 r8）：Σ(pct×value)/Σvalue */
function weightedPct(stocks) {
  let num = 0, den = 0;
  for (const s of stocks) {
    num += (s.changePct ?? 0) * modeValue(s);
    den += modeValue(s);
  }
  return den > 0 ? num / den : 0;
}
/* 市值加权平均涨跌幅限制（标题带归一化的分母）：混合板块按成分市值加权 */
function weightedLimit(stocks) {
  let num = 0, den = 0;
  for (const s of stocks) {
    const v = modeValue(s);
    num += (stockLimit(s) || REF_LIMIT) * v;
    den += v;
  }
  return den > 0 ? num / den : REF_LIMIT;
}
function advDecline(stocks) {
  let adv = 0, dec = 0;
  for (const s of stocks) {
    const p = s.changePct ?? 0;
    if (p > FLAT_EPS) adv++; else if (p < -FLAT_EPS) dec++;
  }
  return { adv, dec, flat: stocks.length - adv - dec };
}


/* 三层布局：板块(gap2) → 子板块(gap2) → 个股(gap 大块1/小块0.5，单组直铺 0.5) */
function buildLayout() {
  const boards = [], subs = [], stocks = [];
  // 市场视图：tree 型=独立树（DATA.markets），rule 型=按 exchange / 代码段过滤（不改 DATA，包一层浅拷贝）
  const mk = MARKETS.find(m => m.id === state.market) || MARKETS[0];
  let nodesSrc;
  if (mk.tree) {
    nodesSrc = ((DATA.markets || {})[mk.tree] || {}).nodes || [];
  } else {
    nodesSrc = DATA.nodes;
    if (mk.rule) {
      nodesSrc = [];
      for (const b of DATA.nodes) {
        const ch = b.children.filter(mk.rule);
        if (ch.length) nodesSrc.push({ ...b, children: ch });
      }
    }
  }
  const nodes = state.focus ? nodesSrc.filter(b => b.name === state.focus) : nodesSrc;
  const boardRects = treemapLayout(
    nodes.map(b => ({ it: b, v: (b.children || []).reduce((s, c) => s + modeValue(c), 0) })),
    0, 0, cssW, cssH, GAP_BOARD);

  for (const br of boardRects) {
    const b = br.it, kids = b.children || [];
    /* 板块标题带：w<84 或 h<54 不留带，否则 clamp(.1h,16,26) 再夹 14~26 */
    const titleH = (br.w < 84 || br.h < 54) ? 0
      : clamp(Math.round(clamp(0.1 * br.h, 16, 26)), 14, 26);
    boards.push({ kind: 'board', name: b.name, x: br.x, y: br.y, w: br.w, h: br.h, titleH, pct: weightedPct(kids), limit: weightedLimit(kids), _kids: kids, ...advDecline(kids) });

    const cx = br.x, cy = br.y + titleH, cw = br.w, ch = Math.max(0, br.h - titleH);
    if (cw <= 2 || ch <= 2) continue;

    // 子板块分组（subBoardName 兜底 boardName；只有 1 组时个股直接铺满）
    const groups = new Map();
    for (const s of kids) {
      const key = s.subBoardName || s.boardName || b.name;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    if (groups.size <= 1) {
      for (const sr of treemapLayout(kids.map(s => ({ it: s, v: modeValue(s) })), cx, cy, cw, ch, GAP_STOCK_SMALL)) {
        const q = sr.it;
        stocks.push({ stock: q, x: sr.x, y: sr.y, w: sr.w, h: sr.h, boardName: b.name, subBoardName: q.subBoardName || b.name });
      }
      continue;
    }
    const subRects = treemapLayout(
      [...groups.entries()].map(([name, list]) => ({ it: { name, list }, v: list.reduce((s, k) => s + modeValue(k), 0) })),
      cx, cy, cw, ch, GAP_SUB);
    for (const sr of subRects) {
      const list = sr.it.list;
      /* 子板块标题带：w<52 或 h<40 不留带，否则 clamp(.14h,14,22) 再夹 12~22 */
      const sh = (sr.w < 52 || sr.h < 40) ? 0
        : clamp(Math.round(clamp(0.14 * sr.h, 14, 22)), 12, 22);
      subs.push({ kind: 'sub', name: sr.it.name, boardName: b.name, x: sr.x, y: sr.y, w: sr.w, h: sr.h, titleH: sh, pct: weightedPct(list), limit: weightedLimit(list), _list: list, ...advDecline(list) });

      const ix = sr.x, iy = sr.y + sh, iw = sr.w, ih = Math.max(0, sr.h - sh);
      if (iw <= 2 || ih <= 2) continue;
      const gap = (sr.w > 56 && sr.h > 38) ? GAP_STOCK_BIG : GAP_STOCK_SMALL;
      for (const kr of treemapLayout(list.map(s => ({ it: s, v: modeValue(s) })), ix, iy, iw, ih, gap)) {
        stocks.push({ stock: kr.it, x: kr.x, y: kr.y, w: kr.w, h: kr.h, boardName: b.name, subBoardName: sr.it.name });
      }
    }
  }
  L = { boards, subs, stocks, nodesUsed: nodes };
}

/* ================= 文本适配（ar 二分截断 / aa 缩字号 / ae 裁剪绘制） ================= */
const truncCache = new Map();
function truncateText(c, text, maxW) {
  if (maxW <= 0 || !text || text.length === 0) return '';
  if (c.measureText(text).width <= maxW) return text;
  const key = c.font + '|' + text + '|' + Math.round(maxW);
  const hit = truncCache.get(key);
  if (hit !== undefined) return hit;
  let lo = 1, hi = text.length, best = '';
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, head = text.slice(0, mid);
    if (c.measureText(head).width <= maxW) { best = head; lo = mid + 1; } else hi = mid - 1;
  }
  if (!best) best = text.slice(0, 1);
  if (truncCache.size > 60000) truncCache.clear();
  truncCache.set(key, best);
  return best;
}
function fitFontSize(c, text, weight, size, minSize, maxW) {
  if (maxW <= 0 || text.length === 0) return size;
  c.font = font(weight, size);
  const w = c.measureText(text).width;
  if (w <= maxW) return size;
  return clamp(size * maxW / w, minSize, size);
}
function drawClipped(c, text, x, y, cx, cy, cw, ch) {
  c.save(); c.beginPath(); c.rect(cx, cy, cw, ch); c.clip(); c.fillText(text, x, y); c.restore();
}

/* ================= 个股标签（四级，逆向的分层阈值与字号公式） ================= */
function drawStockLabel(c, s) {
  const a = s.w * view.scale, n = s.h * view.scale, inv = 1 / view.scale;
  if (a < 16 || n < 8) return;
  const padX = (a > 110 ? 5 : a > 54 ? 3 : 2) * inv;
  const padY = (n > 56 ? 4.5 : n > 26 ? 3 : 2) * inv;
  const cw = Math.max(0, s.w - 2 * padX), ch = Math.max(0, s.h - 2 * padY);
  if (cw <= 2 || ch <= 2) return;
  const st = s.stock;
  c.save();
  c.fillStyle = T.text;
  c.shadowColor = T.shadow;
  c.shadowBlur = (n < 14 ? 0.45 : 1.2) * inv;
  c.shadowOffsetY = 0.6 * inv;
  try {
    if (a >= 108 && n >= 58) {                        // 大块：居中两行（超大块加价格行）
      const r0 = clamp(Math.floor(0.26 * Math.min(a, n)), 15, 30) * inv;
      const nameSize = fitFontSize(c, st.name, 700, r0, Math.max(12 * inv, 0.66 * r0), cw);
      const pctSize = Math.min(clamp(Math.floor(0.19 * Math.min(a, n)), 11, 23) * inv, 1.08 * nameSize);
      const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = font(700, nameSize);
      drawClipped(c, truncateText(c, st.name, cw), cx, cy - 0.62 * nameSize, s.x + padX, s.y + padY, cw, ch);
      c.font = font(650, pctSize);
      drawClipped(c, fmtPctLong(st.changePct ?? 0), cx, cy + 0.3 * pctSize, s.x + padX, s.y + padY, cw, ch);
      if (a > 180 && n > 100) {
        c.font = font(550, Math.max(11 * inv, pctSize - inv));
        drawClipped(c, fmtPrice(st.price), cx, cy + 1.35 * pctSize, s.x + padX, s.y + padY, cw, ch);
      }
      return;
    }
    if (a >= 28 && n >= 20) {                         // 中块：左对齐两行
      const r0 = clamp(Math.floor(Math.min(0.19 * a, 0.43 * n)), 7.5, 16) * inv;
      const nameSize = fitFontSize(c, st.name, 700, r0, Math.max(6.5 * inv, 0.72 * r0), cw - padX);
      const pctSize = Math.min(clamp(Math.floor(0.33 * n), 7, 13) * inv, 1.08 * nameSize);
      c.textAlign = 'left'; c.textBaseline = 'alphabetic';
      c.font = font(700, nameSize);
      drawClipped(c, truncateText(c, st.name, cw - padX), s.x + padX, s.y + padY + nameSize, s.x + padX, s.y + padY, cw, ch);
      c.font = font(650, pctSize);
      drawClipped(c, a >= 58 ? fmtPctLong(st.changePct ?? 0) : fmtPctShort(st.changePct ?? 0),
        s.x + padX, s.y + padY + nameSize + pctSize + 1.5 * inv, s.x + padX, s.y + padY, cw, ch);
      return;
    }
    if (a >= 24 && n >= 10) {                         // 小块：单行，名左 % 右
      const size = clamp(Math.floor(Math.min(0.18 * a, 0.68 * n)), 6.5, 11) * inv;
      const pct = fmtPctShort(st.changePct ?? 0);
      c.textBaseline = 'middle';
      c.font = font(650, size);
      const pw = c.measureText(pct).width, gap = 3 * inv;
      const fits = a >= 32 && pw + gap < 0.72 * cw;
      const nameW = fits ? Math.max(0, cw - pw - gap) : cw;
      const name = truncateText(c, st.name, nameW);
      const my = s.y + s.h / 2 + 0.06 * size;
      if (name) { c.textAlign = 'left'; drawClipped(c, name, s.x + padX, my, s.x + padX, s.y + padY, cw, ch); }
      if (fits) { c.textAlign = 'right'; drawClipped(c, pct, s.x + s.w - padX, my, s.x + padX, s.y + padY, cw, ch); }
      return;
    }
    if (a >= 18 && n >= 8) {                          // 微块：仅名字
      const size = clamp(Math.floor(0.72 * n), 6, 9) * inv;
      c.textAlign = 'left'; c.textBaseline = 'middle';
      c.font = font(650, size);
      const name = truncateText(c, st.name, cw);
      if (name) drawClipped(c, name, s.x + padX, s.y + s.h / 2 + 0.06 * size, s.x + padX, s.y + padY, cw, ch);
    }
  } finally { c.restore(); }
}

/* ================= 标题带标签（an 同款：名左 · %右 · 涨N跌M） ================= */
function drawHeaderLabel(c, r, opts) {
  const { name, pct, adv, dec, compact, showStats, breadcrumb } = opts;
  if (r.w <= 44 || r.titleH <= 8) return;
  const ns = compact ? clamp(Math.floor(0.56 * r.titleH), 9, 12) : clamp(Math.floor(0.52 * r.titleH), 10, 15);
  const ps = compact ? clamp(Math.floor(0.48 * r.titleH), 8, 11) : clamp(Math.floor(0.46 * r.titleH), 9, 13);
  const padL = compact ? 5 : 8;
  const padR = opts.showDrill ? 18 : (compact ? 5 : 8);
  const cw = Math.max(0, r.w - padL - padR);
  const ch = Math.max(0, r.titleH - (compact ? 2 : 4));
  if (cw <= 0 || ch <= 0) return;
  const cy = r.y + r.titleH / 2 + ns * (compact ? 0.06 : 0.08);
  const clipY = r.y + (compact ? 1 : 2);
  const stats = `涨${adv} 跌${dec}`;
  const pctStr = (compact && r.w < 132) ? fmtPctShort(pct) : fmtPctLong(pct);

  c.save();
  c.textBaseline = 'middle';
  c.font = font(650, ps);
  const statsW = c.measureText(stats).width;
  const pctW = c.measureText(pctStr).width;
  const gapN = compact ? 5 : 7;
  const showS = showStats && cw > (compact ? 108 : 148) && statsW + pctW + gapN < 0.64 * cw;
  const showP = showStats && cw > (compact ? 72 : 96);
  const reserved = showP ? pctW + (showS ? statsW + gapN : 0) + (compact ? 6 : 8) : 0;
  const nameW = Math.max(0, cw - reserved);

  c.fillStyle = T.text;
  c.textAlign = 'left';
  c.font = font(700, ns);
  const label = truncateText(c, breadcrumb || name, nameW);
  if (label) drawClipped(c, label, r.x + padL, cy, r.x + padL, clipY, cw, ch);
  if (!showP) { c.restore(); return; }
  c.font = font(650, ps);
  c.textAlign = 'right';
  const rightX = r.x + r.w - padR;
  drawClipped(c, pctStr, rightX, cy, r.x + padL, clipY, cw, ch);
  if (showS) {
    c.fillStyle = T.textSoft;
    drawClipped(c, stats, rightX - pctW - gapN, cy, r.x + padL, clipY, cw, ch);
  }
  c.restore();
}

/* ================= 渲染（单趟直绘，与原站同构） ================= */
function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cv.width, cv.height);
  const grad = ctx.createLinearGradient(0, 0, cv.width, cv.height);
  grad.addColorStop(0, T.bgStart); grad.addColorStop(1, T.bgEnd);
  ctx.fillStyle = grad; ctx.fillRect(0, 0, cv.width, cv.height);

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.translate(view.x, view.y);
  ctx.scale(view.scale, view.scale);

  // 1) 板块底  2) 子板块底
  for (const b of L.boards) { ctx.fillStyle = T.boardFill; ctx.fillRect(b.x, b.y, b.w, b.h); }
  for (const s of L.subs) { ctx.fillStyle = T.subBoardFill; ctx.fillRect(s.x, s.y, s.w, s.h); }

  // 3) 个股色块 + 标签
  for (const s of L.stocks) {
    ctx.fillStyle = heatColor(s.stock.changePct ?? 0, stockLimit(s.stock));
    ctx.fillRect(s.x, s.y, s.w, s.h);
    drawStockLabel(ctx, s);
  }

  // 4) 子板块标题带 + 边框（含悬停子板块高亮）
  const target = state.hoverStock;
  for (const s of L.subs) {
    const active = target && target.subBoardName === s.name && target.boardName === s.boardName;
    if (s.titleH > 0) { ctx.fillStyle = heatColor(s.pct, s.limit); ctx.fillRect(s.x, s.y, s.w, s.titleH); }
    ctx.strokeStyle = active ? T.activeSubBoardStroke : T.subBoardBorder;
    ctx.lineWidth = active ? 2 : 0.9;
    ctx.strokeRect(s.x + 0.5, s.y + 0.5, Math.max(0, s.w - 1), Math.max(0, s.h - 1));
    if (active) {   // 命中子板块的内圈线（原站同款）
      ctx.strokeStyle = T.subBoardInner;
      ctx.lineWidth = 0.8;
      ctx.strokeRect(s.x + 2.2, s.y + 2.2, Math.max(0, s.w - 4.4), Math.max(0, s.h - 4.4));
    }
    if (s.titleH > 0) drawHeaderLabel(ctx, s, { name: s.name, pct: s.pct, adv: s.adv, dec: s.dec, compact: true, showDrill: false, showStats: true });
  }

  // 5) 板块标题带 + 边框 + 悬停/聚焦高亮
  for (const b of L.boards) {
    const isFocus = state.focus === b.name;
    const isHover = state.hoverTitle && state.hoverTitle.kind === 'board' && state.hoverTitle.name === b.name;
    if (b.titleH > 0) {
      ctx.fillStyle = heatColor(b.pct, b.limit);
      ctx.fillRect(b.x, b.y, b.w, b.titleH);
      if (isFocus || isHover) {
        ctx.fillStyle = isHover && !isFocus ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.22)';
        ctx.fillRect(b.x, b.y, b.w, b.titleH);
      }
    }
    ctx.strokeStyle = (isFocus || isHover) ? T.activeBoardStroke : T.boardBorder;
    ctx.lineWidth = (isFocus || isHover) ? 1.8 : 1;
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, Math.max(0, b.w - 1), Math.max(0, b.h - 1));
    if (b.w > 56 && b.titleH > 10) {
      drawHeaderLabel(ctx, b, {
        name: b.name, pct: b.pct, adv: b.adv, dec: b.dec,
        compact: false, showDrill: !state.focus, showStats: true,
        breadcrumb: isFocus ? '‹ 全部 - ' + b.name : b.name,
      });
      if (!state.focus) {   // 钻取箭头
        ctx.fillStyle = isHover || isFocus ? 'rgba(255,255,255,0.95)' : 'rgba(247,250,252,0.72)';
        ctx.font = font(700, Math.max(10, clamp(Math.floor(0.52 * b.titleH), 10, 15)));
        ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText('›', b.x + b.w - 8, b.y + b.titleH / 2 + 0.5);
      }
    }
  }

  // 6) 选中/悬停个股高亮（外 4px + 内 2px）
  if (target) {
    ctx.strokeStyle = T.highlightOuter; ctx.lineWidth = 4;
    ctx.strokeRect(target.x + 1, target.y + 1, Math.max(0, target.w - 2), Math.max(0, target.h - 2));
    ctx.strokeStyle = T.highlightInner; ctx.lineWidth = 2;
    ctx.strokeRect(target.x + 1, target.y + 1, Math.max(0, target.w - 2), Math.max(0, target.h - 2));
  }
  ctx.restore();
}

/* ================= 视图变换（rT：平移钳边，不露底） ================= */
function clampPan(scale, x, y) {
  if (scale <= 1) return { x: 0, y: 0 };
  return { x: clamp(x, cssW - cssW * scale, 0), y: clamp(y, cssH - cssH * scale, 0) };
}
function setView(next) {
  const c = clampPan(next.scale, next.x, next.y);
  if (c.x === view.x && c.y === view.y && c.scale === view.scale) return false;
  view.scale = next.scale; view.x = c.x; view.y = c.y;
  return true;
}

/* ================= 命中测试（倒序线性扫描，画得越晚越先命中） ================= */
function screenToWorld(mx, my) { return { x: (mx - view.x) / view.scale, y: (my - view.y) / view.scale }; }
function hitStock(x, y) {
  for (let i = L.stocks.length - 1; i >= 0; i--) {
    const s = L.stocks[i];
    if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return s;
  }
  return null;
}
function hitTitle(x, y) {   // 先板块标题带，再子板块标题带（原站顺序）
  for (let i = L.boards.length - 1; i >= 0; i--) {
    const b = L.boards[i];
    if (b.titleH > 0 && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.titleH)
      return { kind: 'board', name: b.name, boardName: b.name };
  }
  for (let i = L.subs.length - 1; i >= 0; i--) {
    const s = L.subs[i];
    if (s.titleH > 0 && x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.titleH)
      return { kind: 'sub', name: s.name, boardName: s.boardName };
  }
  return null;
}

/* ================= 交互 ================= */
const drag = { active: false, moved: false, startX: 0, startY: 0, px: 0, py: 0 };
let clickTimer = null;

function canvasPos(e) {
  const r = cv.getBoundingClientRect();
  return { mx: e.clientX - r.left, my: e.clientY - r.top };
}

cv.addEventListener('wheel', e => {
  e.preventDefault();
  const { mx, my } = canvasPos(e);
  const delta = e.deltaY < 0 ? 0.16 : -0.16;
  const nextScale = clamp(view.scale + delta, 1, 3);
  if (nextScale === view.scale) return;
  const wx = (mx - view.x) / view.scale, wy = (my - view.y) / view.scale;
  setView({ scale: nextScale, x: mx - wx * nextScale, y: my - wy * nextScale });
  render(); updateCursor();
}, { passive: false });

cv.addEventListener('mousedown', e => {
  const { mx, my } = canvasPos(e);
  drag.startX = mx; drag.startY = my; drag.moved = false;
  if (view.scale > 1) {
    drag.active = true; drag.px = e.clientX; drag.py = e.clientY;
    cv.classList.add('grabbing');
  }
});
window.addEventListener('mousemove', e => {
  if (drag.active) {
    const dx = e.clientX - drag.px, dy = e.clientY - drag.py;
    drag.px = e.clientX; drag.py = e.clientY;
    const { mx, my } = canvasPos(e);
    if (Math.hypot(mx - drag.startX, my - drag.startY) > 4) drag.moved = true;
    setView({ scale: view.scale, x: view.x + dx, y: view.y + dy });
    render();
    return;
  }
  if (e.target !== cv) { if (!tip.contains(e.target)) clearHover(); return; }
  handleHover(e);
});
window.addEventListener('mouseup', () => {
  drag.active = false;
  cv.classList.remove('grabbing');
});
cv.addEventListener('mouseleave', e => {
  if (e.relatedTarget && tip.contains(e.relatedTarget)) return;   // 移到检视器上，不是真离开
  clearHover();
});
// 指针从检视器上直接离开浏览器窗口（此时 canvas 不会有 mouseleave）
document.documentElement.addEventListener('mouseleave', () => { clearHover(); });   // 指针离开浏览器窗口
tip.addEventListener('mouseleave', e => {
  if (!e.relatedTarget) { clearHover(); return; }                 // 从弹窗上离开窗口
  if (e.relatedTarget === cv || cv.contains(e.relatedTarget)) return;   // 回到画布，交给 handleHover
  clearHover();                                                    // 回到页面其它区域
});

function clearHover() {
  let dirty = false;
  if (state.hoverStock) { state.hoverStock = null; dirty = true; }
  if (state.hoverTitle) { state.hoverTitle = null; dirty = true; }
  if (!state.inspPinned) hideTip();
  if (dirty) { render(); updateCursor(); }
}
function updateCursor() {
  cv.classList.toggle('grab', view.scale > 1 && !drag.active);
  cv.classList.toggle('pointer', !!(state.hoverStock || state.hoverTitle) && view.scale <= 1);
}

function handleHover(e) {
  const { mx, my } = canvasPos(e);
  if (leftEdgeActive && mx > LEFT_EDGE_EXIT) setLeftEdge(false);   // 鼠标移入画布深处，抽屉自动收起
  const w = screenToWorld(mx, my);
  const stock = hitStock(w.x, w.y);
  const title = stock ? null : hitTitle(w.x, w.y);
  const titleChanged = !!title !== !!state.hoverTitle
    || (title && state.hoverTitle && (title.name !== state.hoverTitle.name || title.kind !== state.hoverTitle.kind));
  if (stock !== state.hoverStock || titleChanged) {
    state.hoverStock = stock;
    state.hoverTitle = title;
    render(); updateCursor();
  }
  if (state.inspPinned) return;   // 固定时内容冻结
  let g = null;
  if (stock) g = findGroupFor(stock.stock);
  else if (title) g = findGroupForTitle(title);
  if (g) showInspector(g, stock);
  else hideTip();
}

cv.addEventListener('click', e => {
  if (drag.moved) return;
  const { mx, my } = canvasPos(e);
  const w = screenToWorld(mx, my);
  const title = hitTitle(w.x, w.y);
  if (title) {   // 标题单击延迟 220ms，与双击区分（原站同款）
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => { clickTimer = null; toggleFocus(title.boardName); }, 220);
    return;
  }
  clearTimeout(clickTimer); clickTimer = null;
});

cv.addEventListener('dblclick', e => {
  clearTimeout(clickTimer); clickTimer = null;
  const { mx, my } = canvasPos(e);
  const w = screenToWorld(mx, my);
  const title = hitTitle(w.x, w.y);
  if (title) { toggleFocus(title.boardName); return; }
  const stock = hitStock(w.x, w.y);
  if (stock) {
    const [sym, mkt] = String(stock.stock.code || '.').split('.');   // 002466.SZ → SZ002466
    if (sym && mkt) window.open('https://xueqiu.com/S/' + mkt.toUpperCase() + sym, '_blank', 'noopener');
  }
});


/* 触控：双指捏合缩放（锚定捏合中心）+ 单指拖拽/点按 + 左缘右滑唤出抽屉。
 * 监听挂在 stage（cv 与 edgeLeft 的共同父级）：左缘 16px 侦测带浮在画布上方，
 * 挂 cv 收不到它的触摸——左缘热区手势失效的根因。检视器 tip 的触摸直接忽略。 */
const touch = { mode: 'idle', startTs: 0, sx: 0, sy: 0, lx: 0, ly: 0, startDist: 1, startScale: 1, wx: 0, wy: 0, cx: 0, cy: 0 };
const touchDist = t => t.length < 2 ? 0 : Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
stage.addEventListener('touchstart', e => {
  if (e.target !== cv && e.target !== edgeEl) return;   // 检视器等浮层上的触摸不参与画布手势
  const r = cv.getBoundingClientRect();
  if (e.touches.length === 2) {
    e.preventDefault();
    touch.mode = 'pinch';
    touch.startDist = touchDist(e.touches) || 1;
    touch.cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
    touch.cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
    touch.startScale = view.scale;
    touch.wx = (touch.cx - view.x) / view.scale;
    touch.wy = (touch.cy - view.y) / view.scale;
  } else if (e.touches.length === 1) {
    const t = e.touches[0];
    if (t.clientX < 24) {   // 屏幕左缘起手：从左向右滑 = 唤出抽屉（触屏手势，不进平移/点按逻辑）
      touch.mode = 'edge'; touch.sx = t.clientX; touch.sy = t.clientY;
    } else {
      touch.mode = 'tap'; touch.startTs = Date.now();
      touch.sx = touch.lx = t.clientX; touch.sy = touch.ly = t.clientY;
    }
  }
}, { passive: false });
stage.addEventListener('touchmove', e => {
  if (touch.mode === 'pinch' && e.touches.length >= 2) {
    e.preventDefault();
    const d = touchDist(e.touches);
    if (!d) return;
    const scale = clamp(touch.startScale * d / touch.startDist, 1, 3);
    setView({ scale, x: touch.cx - touch.wx * scale, y: touch.cy - touch.wy * scale });
    render();
  } else if (e.touches.length === 1 && (touch.mode === 'tap' || touch.mode === 'pan' || touch.mode === 'edge')) {
    const t = e.touches[0];
    if (touch.mode === 'edge') {   // 横滑 ≥36px 且基本水平 → 唤出抽屉；反向/纵向则放弃（不触发画布平移）
      e.preventDefault();
      const dx = t.clientX - touch.sx, dy = Math.abs(t.clientY - touch.sy);
      if (dx > 36 && dy < 60) { setLeftEdge(true); touch.mode = 'idle'; }
      else if (dx < -6 || dy > 60) touch.mode = 'idle';
      return;
    }
    if (touch.mode === 'tap' && Math.hypot(t.clientX - touch.sx, t.clientY - touch.sy) > 6) touch.mode = 'pan';
    if (touch.mode !== 'pan') return;
    e.preventDefault();
    const dx = t.clientX - touch.lx, dy = t.clientY - touch.ly;
    touch.lx = t.clientX; touch.ly = t.clientY;
    setView({ scale: view.scale, x: view.x + dx, y: view.y + dy });
    render();
  }
}, { passive: false });
stage.addEventListener('touchend', e => {
  if (touch.mode === 'tap' && Date.now() - touch.startTs < 350) {
    const r = cv.getBoundingClientRect();
    const w = screenToWorld(touch.sx - r.left, touch.sy - r.top);
    const title = hitTitle(w.x, w.y);
    if (title) toggleFocus(title.boardName);
    else {
      if (hitStock(w.x, w.y)) toggleInspPin();
    }
  }
  if (e.touches.length === 1 && touch.mode === 'pinch') {
    const t = e.touches[0];
    touch.mode = 'pan'; touch.sx = touch.lx = t.clientX; touch.sy = touch.ly = t.clientY;
  }
  if (e.touches.length === 0) touch.mode = 'idle';
});
stage.addEventListener('touchcancel', () => { touch.mode = 'idle'; clearHover(); });

function toggleFocus(boardName) {
  state.focus = state.focus === boardName ? null : boardName;
  state.inspPinned = false; state.inspCtxKey = ''; state.hoverStock = null; state.hoverTitle = null;
  setView({ scale: 1, x: 0, y: 0 });
  buildLayout();
  render(); updateCursor();
  hideTip();
}

/* ================= 检视器（dapanyuntu n8 1:1：个股头部条 + 白底日K区 + 浅灰成分列表） =================
 * 头部条背景=该股标题带色（r3），内嵌东财分时迷你图（RJY 108px）+ 价格/市值/涨跌幅；
 * 日K图 = 新浪 image.sinajs.cn/newchart/daily/n/{sh|sz|bj}{code}.gif（白底，w-88%，no-referrer）；
 * 成分列表浅灰 #f4f6f7，行网格 [1fr_56px_64px_80px]，悬停股 sticky 钉顶；
 * 排序七键平铺按钮（原版 rK 同款）；S/Shift+S 循环、↑↓/J/K 滚动、G/单击个股固定。 */
const SORT_KEYS = [
  ['changeDesc', '涨幅', (a, b) => (b.changePct ?? 0) - (a.changePct ?? 0)],
  ['changeAsc', '跌幅', (a, b) => (a.changePct ?? 0) - (b.changePct ?? 0)],
  ['changeAbs', '振幅', (a, b) => Math.abs(b.changePct ?? 0) - Math.abs(a.changePct ?? 0)],
  ['turnover', '成交额', (a, b) => (b.turnoverAmount || 0) - (a.turnoverAmount || 0)],
  ['name', '名称', (a, b) => String(a.name).localeCompare(String(b.name), 'zh')],
  ['totalMarketCap', '总市值', (a, b) => (b.totalMarketCap || 0) - (a.totalMarketCap || 0)],
  ['floatMarketCap', '流通市值', (a, b) => (b.value || 0) - (a.value || 0)],
];
let lastInsp = null;   // {g, active}

function strongColorOf(p) {   // 检视器强色：平盘灰 / 涨红 / 跌绿（端点原色）
  if (Math.abs(p ?? 0) < FLAT_EPS) return 'rgb(65,69,84)';
  return p > 0 ? 'rgb(245,54,57)' : 'rgb(0,214,65)';
}
function findGroupFor(st) {
  for (const s of L.subs) if (s.boardName === st.boardName && s.name === st.subBoardName) return { kind: 'sub', w: s };
  for (const b of L.boards) if (b.name === st.boardName) return { kind: 'board', w: b };
  return null;
}
function findGroupForTitle(t) {
  if (t.kind === 'board') { const b = L.boards.find(x => x.name === t.name); return b ? { kind: 'board', w: b } : null; }
  const s = L.subs.find(x => x.name === t.name && x.boardName === t.boardName);
  return s ? { kind: 'sub', w: s } : null;
}
function groupListOf(g) { return (g.kind === 'sub' ? g.w._list : g.w._kids) || []; }
function sinaKline(code) {   // 新浪日K图：002466.SZ → sz002466
  const i = String(code).indexOf('.');
  if (i < 0) return '';
  return 'https://image.sinajs.cn/newchart/daily/n/' + String(code).slice(i + 1).toLowerCase() + String(code).slice(0, i) + '.gif';
}

function inspStockHeadHTML(st) {
  const pic = emPic(st.code, 'RJY');
  return `<div class="insp-hdst" style="background:${heatColor(st.changePct ?? 0, stockLimit(st))}">` +
    `<span class="nm">${escapeHtml(st.name)}</span>` +
    (pic ? `<img class="spk" referrerpolicy="no-referrer" alt="" src="${pic}">` : '') +
    `<span class="pv">${fmtPrice(st.price)}</span>` +
    `<span class="mv">${fmtAmount(st.totalMarketCap)}</span>` +
    `<span class="pc">${fmtPctLong(st.changePct ?? 0)}</span>` +
    (state.inspPinned ? '<span class="pinb">已固定 · Esc解除</span>' : '') +
    `</div>`;
}
function inspKlineHTML(st) {
  const kimg = String(st.code).endsWith('.HK') ? '' :   // 新浪日K图无港股路径，留空兜底
    `<img src="${sinaKline(st.code)}" referrerpolicy="no-referrer" alt="日K">`;
  return `<div class="insp-kline">` + kimg +
    `<p class="hint">快捷键：G 固定 · S / Shift+S 切换排序 · ↑↓ / J K 滚动 · 双击个股看行情页</p></div>`;
}
function inspBoardHTML(g, ordered) {
  const bn = g.kind === 'sub' ? `${g.w.boardName} · ${g.w.name}` : g.w.name;
  const sorts = SORT_KEYS.map(([k, label], i) =>
    `<button type="button" class="ss${state.inspSort === i ? ' on' : ''}" data-sort="${i}">${label}</button>`).join('');
  return `<div class="insp-board"><div class="insp-bd-hd">` +
    `<div class="r1"><span class="bn">${escapeHtml(bn)}</span>` +
    `<span class="bs">涨${g.w.adv} 跌${g.w.dec} <b style="color:${strongColorOf(g.w.pct)}">${fmtPctLong(g.w.pct)}</b></span></div>` +
    `<div class="r2"><span class="sl">排序</span>${sorts}</div></div>` +
    `<div class="insp-list">${ordered.map(inspRowHTML).join('')}</div></div>`;
}
function inspRowHTML(st) {
  const pct = st.changePct ?? 0;
  const pic = emPic(st.code, 'RJY');
  return `<div class="insp-row" data-code="${escapeHtml(st.code)}">` +
    `<span class="nm">${escapeHtml(st.name)}</span>` +
    (pic ? `<img class="spk" referrerpolicy="no-referrer" alt="" src="${pic}">` : '<span class="spk"></span>') +
    `<span class="pr">${fmtPrice(st.price)}</span>` +
    `<span class="pc" style="color:${strongColorOf(pct)}">${fmtPctShort(pct)}</span></div>`;
}
function showInspector(g, activeHit) {
  lastInsp = { g, active: activeHit || null };
  const list = groupListOf(g);
  const actCode = activeHit && activeHit.stock ? activeHit.stock.code : null;
  const key = g.kind + '|' + g.w.name + '|' + g.w.boardName + '|' + state.inspSort + '|' + (actCode || '');
  if (state.inspCtxKey !== key) {
    const sorted = [...list].sort(SORT_KEYS[state.inspSort][2]);
    const ordered = actCode
      ? [sorted.find(s => s.code === actCode), ...sorted.filter(s => s.code !== actCode)].filter(Boolean)
      : sorted;                                       // 原版 nv：悬停股排第一
    const head = ordered[0];
    tip.innerHTML = (head ? inspStockHeadHTML(head) + inspKlineHTML(head) : '') +
      inspBoardHTML(g, ordered);
    state.inspCtxKey = key;
  }
  positionInspector({ x: g.w.x, y: g.w.y, w: g.w.w, h: g.w.h });
  tip.hidden = false;
  setActiveRow(activeHit);
}
function setActiveRow(activeHit) {   // active 行已钉顶，滚回列表顶即可见
  if (activeHit) {
    const list = tip.querySelector('.insp-list');
    if (list) list.scrollTop = 0;
  }
}
function positionInspector(anchor) {
  const w = Math.min(Math.max(320, cssW - 24), cssW >= 1360 ? 452 : cssW >= 1100 ? 432 : 408);
  const listMax = Math.min(620, Math.max(350, Math.floor(0.7 * cssH)));
  const popH = 58 + listMax;   // 头部条 + K线区 + 列表的真实高度
  tip.style.width = w + 'px';
  const list = tip.querySelector('.insp-list');
  if (list) list.style.maxHeight = Math.max(120, listMax - 64) + 'px';
  const left0 = anchor.x * view.scale + view.x, top0 = anchor.y * view.scale + view.y;
  const right0 = (anchor.x + anchor.w) * view.scale + view.x;
  let left;
  if (right0 + 12 + w <= cssW - 12) left = right0 + 12;
  else if (left0 - 12 - w >= 12) left = left0 - w - 12;
  else left = (cssW - right0 >= left0 ? cssW - w - 12 : 12);
  tip.style.left = clamp(left, 12, Math.max(12, cssW - w - 12)) + 'px';
  tip.style.top = clamp(top0, 12, Math.max(12, cssH - popH - 12)) + 'px';
}
function rebuildInspector() {
  if (!lastInsp) return;
  state.inspCtxKey = '';
  showInspector(lastInsp.g, lastInsp.active);
}
function toggleInspPin() {
  state.inspPinned = !state.inspPinned;
  if (state.inspPinned) { if (lastInsp) rebuildInspector(); }
  else { state.inspCtxKey = ''; hideTip(); }
}
function findStockRectByCode(code) {
  for (const s of L.stocks) if (s.stock.code === code) return s;
  return null;
}
function hideTip() { tip.hidden = true; state.inspCtxKey = ''; }

/* ================= M2 实时行情：jrj 主源（沪深）+ 腾讯批量（北交所/ETF/港股） =================
 * 交易时段每 10s 一轮；只更新价格/涨跌幅/成交额；面积口径（构建时市值权重）不变 → 布局不重算。
 * 请求按当前市场裁剪：全部/上证/深证/创业板/科创板/北交所/沪深300/中证A500 = jrj×1(+北交所批量)；
 * ETF = 腾讯 12 批 / 港股 = 腾讯 19 批（jrj 不覆盖这两类，跳过全量拉取）；同花顺摘要+指数批量常驻。
 * 失败自动保留上一份数据并在状态栏提示。 */
const LIVE = { intervalMs: 10000, lastOk: null, fails: 0, timer: null, busy: false, computedTurnover: null };
const JRJ_URL = 'https://gateway.jrj.com/quot-dpyt/hq';
const QT_URL = 'https://qt.gtimg.cn/q=';

function inTradingHours() {
  const d = new Date(), m = d.getHours() * 60 + d.getMinutes();
  if (d.getDay() === 0 || d.getDay() === 6) return false;
  return (m >= 9 * 60 + 15 && m <= 11 * 60 + 35) || (m >= 12 * 60 + 55 && m <= 15 * 60 + 10);
}

async function fetchJrjQuotes() {   // var 是小数（0.0162=+1.62%）→ ×100；键 '1'+代码 / '2'+代码
  const res = await fetch(JRJ_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ column: 'chg' }),
    signal: AbortSignal.timeout(8000),   // 网络挂起保护，失败走 catch 保留旧数据
  });
  if (!res.ok) throw new Error('jrj ' + res.status);
  const hqs = (await res.json()).data?.hqs ?? {};
  const out = {};
  for (const k in hqs) {
    const v = hqs[k];
    if (k[0] === '1') out[k.slice(1) + '.SH'] = { price: v.np, changePct: v.var * 100 };
    else if (k[0] === '2') out[k.slice(1) + '.SZ'] = { price: v.np, changePct: v.var * 100 };
  }
  return out;
}

async function fetchQtQuotes(codes, mode = 'bj') {   // 腾讯批量：bj/etf= s_ 简版（f[3]价 f[5]涨跌% f[7]成交额万）；hk= 全量（f[3]价 f[4]昨收 f[37]成交额元，涨跌现算）
  const out = {};
  const batches = [];
  for (let i = 0; i < codes.length; i += 150) {
    batches.push(codes.slice(i, i + 150).map(c => {
      const [sym, mkt] = String(c).split('.');
      return mode === 'hk' ? 'hk' + sym : 's_' + (mode === 'bj' ? 'bj' : mkt.toLowerCase()) + sym;
    }).join(','));
  }
  await Promise.all(batches.map(async batch => {
    const res = await fetch(QT_URL + batch, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error('qt ' + res.status);
    const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
    for (const line of text.split(';')) {
      const m = mode === 'hk' ? /^v_hk(\d+)="([^"]*)"/.exec(line) : /^v_s_([a-z]{2})(\d+)="([^"]*)"/.exec(line);
      if (!m) continue;
      const code = mode === 'hk' ? m[1] + '.HK' : m[2] + '.' + m[1].toUpperCase();
      const f = (mode === 'hk' ? m[2] : m[3]).split('~');
      const price = parseFloat(f[3]);
      if (!isFinite(price)) continue;
      let pct = NaN;
      if (mode === 'hk') {
        const prev = parseFloat(f[4]);
        if (isFinite(prev) && prev > 0) pct = (price - prev) / prev * 100;
      } else {
        pct = parseFloat(f[5]);
      }
      const amt = parseFloat(mode === 'hk' ? f[37] : f[7]);
      out[code] = {
        price,
        changePct: isFinite(pct) ? pct : undefined,
        turnoverAmount: isFinite(amt) ? (mode === 'hk' ? amt : amt * 1e4) : undefined,
      };
    }
  }));
  return out;
}

/* ---- 实时成交额摘要（同花顺 fuyao，CORS *，原站摘要条同源同口径） ----
 * header 直接给：当日/昨日成交额、较昨日变动、预测全天；失败时回退 DATA.summary 快照。 */
const THS_CHART_URL = 'https://dq.10jqka.com.cn/fuyao/market_analysis_api/chart/v1/get_chart_data?chart_key=turnover_minute';
let turnoverSummary = null;   // {amount, previous, delta}
const SOURCE_NAMES = { ths: '同花顺', tencent: '腾讯', computed: '逐股加总', snapshot: '静态快照' };

async function fetchThsTurnover() {
  const res = await fetch(THS_CHART_URL, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('ths ' + res.status);
  const h = {};
  for (const it of (await res.json()).data?.charts?.header ?? []) h[it.key] = it.val;
  if (!isFinite(h.turnover)) throw new Error('ths 形状变了');
  return {
    amount: h.turnover,
    previous: isFinite(h.turnover_pre) ? h.turnover_pre : null,
    delta: isFinite(h.turnover_change) ? h.turnover_change
      : (isFinite(h.turnover_pre) ? h.turnover - h.turnover_pre : null),
  };
}

function refreshAggregates() {   // 行情变了：重算板块/子板块标题带聚合色与涨跌家数（布局不动）
  for (const s of L.subs) { s.pct = weightedPct(s._list ?? []); Object.assign(s, advDecline(s._list ?? [])); }
  for (const b of L.boards) { b.pct = weightedPct(b._kids ?? []); Object.assign(b, advDecline(b._kids ?? [])); }
}

function updateComputedTurnover() {   // ETF/港股腾讯批量带成交额 → 市场成交额实时逐股加总
  const mk = MARKETS.find(m => m.id === state.market);
  if (!mk || (mk.tree !== 'etf' && mk.tree !== 'hk')) { LIVE.computedTurnover = null; return; }
  let sum = 0;
  for (const b of ((DATA.markets || {})[mk.tree] || {}).nodes || [])
    for (const c of b.children || []) if (Number.isFinite(c.turnoverAmount) && c.turnoverAmount > 0) sum += c.turnoverAmount;
  LIVE.computedTurnover = sum > 0 ? { id: mk.id, amount: sum } : null;
}

async function refreshQuotes() {
  if (LIVE.busy) return;
  LIVE.busy = true;
  try {
    const mk = MARKETS.find(m => m.id === state.market) || MARKETS[0];
    const useJrj = !mk.tree || mk.tree === 'hs300' || mk.tree === 'zza500';   // jrj 只覆盖沪深 A 股（含两指数成分）
    const all = [], bjCodes = [], altCodes = [];
    const trees = [DATA.nodes, ...Object.values(DATA.markets || {}).map(m => m.nodes).filter(Array.isArray)];
    for (const t of trees) for (const b of t) for (const c of b.children || []) { all.push(c); if (c.code.endsWith('.BJ')) bjCodes.push(c.code); }
    /* ETF/港股树 jrj 不覆盖 → 盘内走腾讯批量（仅当前激活页拉取；默认全部页仍是原 4 请求节奏） */
    if (mk.tree === 'etf' || mk.tree === 'hk') {
      for (const b of ((DATA.markets || {})[mk.tree] || {}).nodes || []) for (const c of b.children || []) altCodes.push(c.code);
    }
    const [jrj, qt, alt] = await Promise.all([
      useJrj ? fetchJrjQuotes() : Promise.resolve({}),
      useJrj && bjCodes.length ? fetchQtQuotes(bjCodes) : Promise.resolve({}),
      altCodes.length ? fetchQtQuotes(altCodes, mk.tree === 'hk' ? 'hk' : 'etf') : Promise.resolve({}),
    ]);
    fetchThsTurnover()   // 成交额摘要：非致命，失败保留上次/快照
      .then(v => { turnoverSummary = v; updateStatus(); })
      .catch(() => {});
    fetchIndices()       // 顶栏指数条：非致命
      .then(renderIndices)
      .catch(() => {});
    let n = 0;
    for (const c of all) {
      const hit = jrj[c.code] || qt[c.code] || alt[c.code];
      if (!hit) continue;
      if (hit.price != null) c.price = hit.price;
      if (hit.changePct != null) c.changePct = hit.changePct;
      if (hit.turnoverAmount != null) c.turnoverAmount = hit.turnoverAmount;
      n++;
    }
    LIVE.lastOk = new Date();
    LIVE.fails = 0;
    refreshAggregates();
    updateComputedTurnover();
    render();
    updateStatus();
  } catch {
    LIVE.fails++;
    updateStatus();
  } finally {
    LIVE.busy = false;
  }
}

function startLive() {
  refreshQuotes();                                    // 打开先拉一轮（非交易时段=最新收盘快照）
  if (inTradingHours()) {
    LIVE.timer = setInterval(() => { if (inTradingHours()) refreshQuotes(); }, LIVE.intervalMs);
  }
}

/* 成交额数据源优先级：ETF/港股=腾讯实时逐股加总 → 指数树=构建时 API 抓取 → 全 A 类=同花顺实时 → DATA.summary 兜底 */
function turnoverInfo() {
  const mk = MARKETS.find(m => m.id === state.market);
  const msum = mk && mk.tree ? ((DATA.markets || {})[mk.tree] || {}).summary : null;
  const liveT = LIVE.computedTurnover && LIVE.computedTurnover.id === state.market ? LIVE.computedTurnover : null;
  if (liveT) return { amount: liveT.amount, delta: null, srcName: SOURCE_NAMES.computed };
  if (msum && isFinite(msum.turnoverAmount) && msum.turnoverAmount > 0)
    return { amount: msum.turnoverAmount, delta: isFinite(msum.turnoverDelta) && msum.turnoverDelta ? msum.turnoverDelta : null, srcName: mk.label + '·抓取时点' };
  if (turnoverSummary)
    return { amount: turnoverSummary.amount, delta: turnoverSummary.delta, srcName: '同花顺' };
  const sm = DATA.summary;
  if (sm && isFinite(sm.turnoverAmount))
    return { amount: sm.turnoverAmount, delta: isFinite(sm.turnoverDelta) ? sm.turnoverDelta
      : (isFinite(sm.turnoverPreviousAmount) ? sm.turnoverAmount - sm.turnoverPreviousAmount : null),
      srcName: (SOURCE_NAMES[sm.turnoverSource] ?? sm.turnoverSource ?? '?') + '·抓取时点' };
  return { amount: null, delta: null, srcName: '' };
}

/* ================= 底栏 ================= */
function buildLegend() {   // 图例 = score 轴（-1 跌停 ← 0 平盘 → +1 涨停）的离散档色
  const stops = [];
  for (let i = 0; i < 40; i++) {
    const c = bandColorOf((i + 0.5) / 20 - 1);   // 第 i 档中心色（score 轴离散档）
    stops.push(`${c} ${(i / 40 * 100).toFixed(2)}%`, `${c} ${((i + 1) / 40 * 100).toFixed(2)}%`);
  }
  document.getElementById('legendBar').style.background = `linear-gradient(90deg, ${stops.join(',')})`;
  document.getElementById('legendTicks').innerHTML =
    ['跌停', '-半板', '平盘', '+半板', '涨停'].map(t => `<span>${t}</span>`).join('');
}

function updateStatus() {
  const all = [];
  for (const b of (L && L.nodesUsed || DATA.nodes)) for (const s of b.children || []) all.push(s);
  const { adv, dec, flat } = advDecline(all);
  const t = turnoverInfo();
  /* 统计表：r1 三等分（涨跌家数），r2 二等分（成交额/较昨日）；增量=红 缩量=绿 持平=灰 */
  let dVal = `<b class="flat">—</b>`;
  if (t.delta != null && isFinite(t.delta)) {
    dVal = t.delta === 0
      ? `<b class="flat">持平</b>`
      : `<b class="${t.delta > 0 ? 'up' : 'down'}">${t.delta > 0 ? '增量' : '缩量'} ${fmtAmount(Math.abs(t.delta))}</b>`;
  }
  document.getElementById('counts').innerHTML =
    `<div class="st-row r1">` +
      `<div class="st"><i>上涨</i><b class="up">${adv.toLocaleString()}</b></div>` +
      `<div class="st"><i>平盘</i><b class="flat">${flat.toLocaleString()}</b></div>` +
      `<div class="st"><i>下跌</i><b class="down">${dec.toLocaleString()}</b></div>` +
    `</div>` +
    `<div class="st-row r2">` +
      `<div class="st"><i>成交额${t.srcName ? ' · ' + escapeHtml(t.srcName) : ''}</i><b>${t.amount != null ? fmtAmount(t.amount) : '—'}</b></div>` +
      `<div class="st"><i>较昨日</i>${dVal}</div>` +
    `</div>`;
  let dataTxt;
  if (LIVE.lastOk) {
    const t2 = LIVE.lastOk.toTimeString().slice(0, 8);
    dataTxt = LIVE.fails > 0 ? `实时中断(${LIVE.fails})，数据 ${t2}` : `实时 ${t2}`;
  } else {
    const merged = DATA._meta && DATA._meta.quotesMerged ? ' · 含抓取时点行情' : '';
    dataTxt = `快照 ${fmtTime(DATA.updatedAt)}${merged}`;
  }
  document.getElementById('updated').textContent = dataTxt;
}

/* ================= 尺寸 ================= */
function resize() {
  const r = stage.getBoundingClientRect();
  cssW = Math.max(1, Math.floor(r.width));
  cssH = Math.max(1, Math.floor(r.height));
  dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
  cv.width = Math.floor(cssW * dpr);
  cv.height = Math.floor(cssH * dpr);
  cv.style.width = cssW + 'px';
  cv.style.height = cssH + 'px';
  setView({ scale: view.scale, x: view.x, y: view.y });
  buildLayout();
  render();
}
new ResizeObserver(resize).observe(stage);

/* ================= 控件 ================= */
document.querySelectorAll('#sizeMode button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#sizeMode button').forEach(b => b.classList.toggle('on', b === btn));
    state.sizeMode = btn.dataset.mode;
    buildLayout(); render();
  });
});
function resetView() {   // Esc 触发（重置/全屏按钮已按需求移除）
  state.focus = null; state.inspPinned = false; state.inspCtxKey = ''; state.hoverStock = null; state.hoverTitle = null;
  setView({ scale: 1, x: 0, y: 0 });
  buildLayout(); render(); hideTip();
}
document.getElementById('drawerClose').addEventListener('click', () => setLeftEdge(false));   // 抽屉头部 ✕：触屏无键盘也能收
window.addEventListener('keydown', e => {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.key === 'Escape') {
    if (leftEdgeActive) { setLeftEdge(false); return; }
    if (state.inspPinned) { state.inspPinned = false; state.inspCtxKey = ''; hideTip(); return; }
    resetView();
    return;
  }
  if (tip.hidden) return;
  if (e.key === 's' || e.key === 'S') {   // 排序循环（按钮组之外保留快捷键）
    e.preventDefault();
    state.inspSort = (state.inspSort + (e.shiftKey ? SORT_KEYS.length - 1 : 1)) % SORT_KEYS.length;
    rebuildInspector();
    return;
  }
  if ((e.key === 'g' || e.key === 'G') && lastInsp) {   // 固定/解除检视器（原站同款）
    e.preventDefault();
    toggleInspPin();
    return;
  }
  const list = tip.querySelector('.insp-list');
  if (!list) return;
  const page = Math.max(120, Math.floor(list.clientHeight * 0.82));
  let top = list.scrollTop, used = true;
  switch (e.key) {
    case 'ArrowDown': case 'j': case 'J': top += 56; break;
    case 'ArrowUp': case 'k': case 'K': top -= 56; break;
    case 'PageDown': top += page; break;
    case 'PageUp': top -= page; break;
    case 'Home': top = 0; break;
    case 'End': top = list.scrollHeight; break;
    default: used = false;
  }
  if (used) { e.preventDefault(); list.scrollTo({ top: clamp(top, 0, list.scrollHeight), behavior: 'smooth' }); }
});

/* ---- 市场切换条（腾讯批量 ×1 拿指数报价；点击切换云图市场） ----
 * 两类云图：
 *  rule 型：从全 A 树按 exchange/代码段前端过滤（全部/上证/深证/创业板/科创板/北交所）；
 *  tree 型：独立树（DATA.markets[id]，refresh_fixtures.sh 抓自原站 API）——
 *           沪深300/中证A500 为成分指数云图，ETF/港股为独立市场云图；
 *           fixture 缺失时对应标签自动隐藏（renderIndices 过滤）。 */
const MARKETS = [
  { id: 'all',   label: '全部',     idx: 'sh000985', rule: null },                          // 中证全指
  { id: 'sh',    label: '上证',     idx: 'sh000001', rule: c => c.exchange === 'SH' },
  { id: 'sz',    label: '深证',     idx: 'sz399106', rule: c => c.exchange === 'SZ' },       // 深证综指
  { id: 'hs300', label: '沪深300',  idx: 'sh000300', tree: 'hs300' },
  { id: 'zza500',label: '中证A500', idx: 'sh000510', tree: 'zza500' },
  { id: 'cyb',   label: '创业板',   idx: 'sz399006', rule: c => c.code.startsWith('30') },
  { id: 'kcb',   label: '科创板',   idx: 'sh000688', rule: c => c.code.startsWith('68') },
  { id: 'bj',    label: '北交所',   idx: 'bj899050', rule: c => c.exchange === 'BJ' },
  { id: 'etf',   label: 'ETF',      idx: null,       tree: 'etf' },
  { id: 'hk',    label: '港股',     idx: 'r_hkHSI',  tree: 'hk' },
];
/* 指数报价（同一个腾讯批量请求，键=腾讯代码）；缺价时用各市场树 summary.indexChangePct 兜底 */
let indexQuotes = {};

const idxColor = p => (p == null || !isFinite(p) || Math.abs(p) < FLAT_EPS) ? 'var(--muted)' : p > 0 ? '#ff6b66' : '#35d97a';

async function fetchIndices() {
  const codes = MARKETS.map(m => m.idx).filter(Boolean);
  const res = await fetch(QT_URL + codes.join(','), { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('idx ' + res.status);
  const text = new TextDecoder('gbk').decode(await res.arrayBuffer());
  const map = {};
  for (const line of text.split(';')) {
    // 键多种形态：简版 v_s_sh000001（取 f5）/ 全量 v_sh000001、v_r_hkHSI（字段位不同→用现价 f3/昨收 f4 现算）
    const m = /^v_(s_)?([\w]+)="([^"]*)"/.exec(line.trim());
    if (!m) continue;
    const f = m[3].split('~');
    const price = parseFloat(f[3]);
    let pct = NaN;
    if (m[1]) pct = parseFloat(f[5]);
    else {
      const prev = parseFloat(f[4]);
      if (isFinite(price) && isFinite(prev) && prev > 0) pct = (price - prev) / prev * 100;
    }
    map[m[2]] = { price: isFinite(price) ? price : null, pct: isFinite(pct) ? pct : null };
  }
  indexQuotes = map;
}

function idxRowHTML(q, market) {   // 市场切换标签（报价 + 点击切云图）
  const pct = q.pct, color = idxColor(pct);
  const pctTxt = (pct == null || !isFinite(pct)) ? '—' : fmtPctShort(pct);
  const nmColor = (pct == null || !isFinite(pct)) ? 'var(--text)' : color;   // 名称随涨跌同色
  const inner = `<span class="n" style="color:${nmColor}">${escapeHtml(market.label)}</span><span class="sp"></span>` +
    (q.price != null ? `<span class="p" style="color:${color}">${q.price.toFixed(2)}</span>` : '') +
    `<span class="c" style="color:${color}">${pctTxt}</span>`;
  return `<button type="button" class="idx${state.market === market.id ? ' on' : ''}" data-market="${market.id}" title="切换到「${market.label}」云图">${inner}</button>`;
}
function renderIndices() {
  const el = document.getElementById('indices');
  const mkt = DATA.markets || {};
  const rows = MARKETS
    .filter(m => !m.tree || (mkt[m.tree] && Array.isArray(mkt[m.tree].nodes) && mkt[m.tree].nodes.length))
    .map(m => {
      const q = indexQuotes[m.idx] || {};
      let pct = q.pct;
      if (pct == null && m.tree && mkt[m.tree] && mkt[m.tree].summary)
        pct = mkt[m.tree].summary.indexChangePct ?? null;   // 腾讯缺价：用市场树自带指数涨跌幅兜底
      return idxRowHTML({ label: m.label, price: q.price ?? null, pct }, m);
    });
  el.innerHTML = `<div class="drw-sub">云图市场</div>` + rows.join('');
}

function setMarket(id) {
  if (state.market === id) return;
  state.market = id;
  state.hoverStock = null; state.hoverTitle = null;
  setView({ scale: 1, x: 0, y: 0 });
  buildLayout(); render(); updateCursor(); hideTip();
  renderIndices();
  updateStatus();
  refreshQuotes();   // 切换后立即拉一轮新市场行情（busy 时自动跳过，等下一轮）
}

/* ---- 板块资金流（东财 push2：行业板块主力净流入排行，双列 净流入/净流出） ----
 * 免费接口克制使用：启动拉一次；交易时段且抽屉展开时每 60s 刷新；↻ 手动强制。
 * 金额颜色 = 主力净占比（f184，±10% 钳 1）映射到 score 色卡：流入偏红、流出偏绿。 */
const FLOW_BASE = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&np=1&fltt=2&invt=2&fid=f62&fs=m:90+t:2&fields=f14,f62,f184';
let flowData = null;   // {in:[{name,amt,pct}], out:[...]}
let flowBusy = false;

async function fetchFlow() {
  if (flowBusy) return;
  flowBusy = true;
  try {
    const parse = r => r.json().then(d => (d.data?.diff || []).map(x => ({ name: x.f14, amt: x.f62, pct: x.f184 })));
    const [inArr, outArr] = await Promise.all([
      fetch(FLOW_BASE + '&po=1', { signal: AbortSignal.timeout(8000) }).then(parse),
      fetch(FLOW_BASE + '&po=0', { signal: AbortSignal.timeout(8000) }).then(parse),
    ]);
    flowData = { in: inArr.slice(0, 20), out: outArr.slice(0, 20) };
    renderFlow();
  } catch { /* 拉取失败：保留上次内容 */ } finally { flowBusy = false; }
}
function flowRowHTML(r) {
  const score = clamp((r.pct ?? 0) / 10, -1, 1);
  const col = Math.abs(r.pct ?? 0) < 0.05 ? 'var(--muted)' : bandColorOf(score);
  const sign = r.amt > 0 ? '+' : (r.amt < 0 ? '-' : '');
  return `<div class="flow-row"><span class="fn">${escapeHtml(r.name)}</span>` +
    `<b class="fv" style="color:${col}">${sign}${fmtAmount(Math.abs(r.amt))}</b></div>`;
}
function renderFlow() {
  if (!flowData) return;
  const fill = (el, rows) => {
    el.innerHTML = rows.length ? rows.map(flowRowHTML).join('')
      : '<div class="flow-row"><span class="fn" style="color:var(--muted)">—</span></div>';
  };
  fill(document.getElementById('flowIn'), flowData.in);
  fill(document.getElementById('flowOut'), flowData.out);
}
document.getElementById('flowRefresh').addEventListener('click', () => fetchFlow());
setInterval(() => { if (leftEdgeActive && inTradingHours()) fetchFlow(); }, 60000);

/* ================= 左缘侦测（抽屉菜单触发） =================
 * 贴边：鼠标进入画布最左 16px → 打开；离开侦测带（往右）或从左缘滑出窗口 → 关闭；
 * 抽屉展开时鼠标在抽屉内保持打开。钩子：window.onLeftEdgeChange = (open) => {} */
const LEFT_EDGE_EXIT = 28;   // 抽屉展开时，鼠标越过画布左缘 28px 视为离开抽屉区 → 自动收起
let leftEdgeActive = false;
const edgeEl = document.getElementById('edgeLeft');
const drawerEl = document.getElementById('drawer');
function setLeftEdge(on) {
  if (leftEdgeActive === on) return;
  leftEdgeActive = on;
  document.body.classList.toggle('drawer-open', on);
  if (typeof window.onLeftEdgeChange === 'function') {
    try { window.onLeftEdgeChange(on); } catch {}
  }
}
edgeEl.addEventListener('mouseenter', () => setLeftEdge(true));
edgeEl.addEventListener('mouseleave', e => {
  if (e.relatedTarget && drawerEl.contains(e.relatedTarget)) return;   // 移入抽屉，保持
  setLeftEdge(false);
});
drawerEl.addEventListener('mouseleave', e => {
  if (e.relatedTarget && (drawerEl.contains(e.relatedTarget) || e.relatedTarget === edgeEl)) return;
  setLeftEdge(false);
});
// 滑出窗口左缘：documentElement 级 mouseleave（relatedTarget 为 null）
document.documentElement.addEventListener('mouseleave', () => setLeftEdge(false));
/* ================= 启动 ================= */
document.addEventListener('pointerdown', e => {   // 画布与检视器之外的任何按下（鼠标/触摸通吃）：收起抽屉与检视器
  if (tip.contains(e.target)) return;
  if (e.target === cv) {   // 点画布=收抽屉：桌面鼠标移入画布早已先收（无行为变化），触屏无键盘靠这个收
    if (leftEdgeActive) setLeftEdge(false);
    return;
  }
  if (drawerEl.contains(e.target) || e.target === edgeEl) return;   // 抽屉/左缘带内按下：正在操作抽屉，收起会把本次点击掐断
  setLeftEdge(false);
  if (state.inspPinned) return;
  clearHover();
});
tip.addEventListener('click', e => {
  const sb = e.target.closest('.ss');
  if (sb && sb.dataset.sort != null) { state.inspSort = +sb.dataset.sort; rebuildInspector(); return; }
  if (e.target.closest('.insp-pin')) { toggleInspPin(); return; }
  const row = e.target.closest('.insp-row');
  if (row && row.dataset.code) {
    const [sym, mkt] = String(row.dataset.code).split('.');
    if (sym && mkt) window.open('https://xueqiu.com/S/' + mkt.toUpperCase() + sym, '_blank', 'noopener');
  }
});
tip.addEventListener('mouseover', e => {   // 列表行悬停 ↔ 画布高亮联动
  const row = e.target.closest('.insp-row');
  if (!row || !row.dataset.code) return;
  const rect = findStockRectByCode(row.dataset.code);
  if (rect && rect !== state.hoverStock) { state.hoverStock = rect; render(); }
});
document.getElementById('indices').addEventListener('click', e => {
  const btn = e.target.closest('.idx');
  if (!btn) return;
  if (btn.dataset.market) { setMarket(btn.dataset.market); return; }
  if (btn.dataset.sym) window.open('https://xueqiu.com/S/' + btn.dataset.sym, '_blank', 'noopener');
});
buildLegend();
renderIndices();   // 市场标签先出（报价随后由 fetchIndices 补上）
updateStatus();
resize();
/* 抽屉初始态：桌面（精确指针+宽屏）默认展开，触屏/窄屏（手机，无键盘收不了）默认收起 */
const touchLike = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 700;
document.body.classList.toggle('drawer-open', !touchLike);
leftEdgeActive = !touchLike;
startLive();
fetchFlow();   // 板块资金流首拉（之后 60s 节流/手动刷新）
})();
