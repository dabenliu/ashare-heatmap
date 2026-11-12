/* 从 data/ 的树文件里提取"要报价的代码全集"（服务器版名单）。
 * 树结构：nodes[板块].children[个股] = {code:'601138.SH', exchange:'SH', ...}
 * 每天 GitHub Actions 更新这些文件 → 服务每轮检查 mtime，变了自动重载。 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const TREE_FILES = {
  all: 'live-treemap.json',        // 全 A：5566 只（SH 2321 / SZ 2902 / BJ 343）
  etf: 'live-treemap-etf.json',    // ETF：1674 只
  hk:  'live-treemap-hk.json',     // 港股：2775 只
};

export function treeSignature(dataDir) {
  return Object.values(TREE_FILES)
    .map(f => { try { return statSync(join(dataDir, f)).mtimeMs; } catch { return 0; } })
    .join(',');
}

export function loadUniverse(dataDir) {
  const uni = { all: { SH: [], SZ: [], BJ: [] }, etf: [], hk: [] };
  for (const [market, file] of Object.entries(TREE_FILES)) {
    const tree = JSON.parse(readFileSync(join(dataDir, file), 'utf8'));
    const codes = [];
    for (const board of tree.nodes ?? [])
      for (const c of board.children ?? [])
        if (c.code) codes.push(c.code);
    if (market === 'all') {
      for (const code of codes) {
        const ex = String(code).slice(-2);            // '601138.SH' → 'SH'
        (uni.all[ex] ??= []).push(code);
      }
    } else {
      uni[market] = codes;
    }
  }
  return uni;
}

export function universeCounts(uni) {
  return {
    all: (uni.all.SH?.length ?? 0) + (uni.all.SZ?.length ?? 0) + (uni.all.BJ?.length ?? 0),
    etf: uni.etf.length,
    hk: uni.hk.length,
  };
}
