#!/usr/bin/env python3
"""把 data/ 里的 JSON fixture 转成 data/treemap.js（file:// 双击可用，script 标签加载）。

2026-11-10 起完全去快照：所有数据都来自站点 API 抓取（refresh_fixtures.sh）——
主树 = live-treemap.json（唯一来源，缺失即报错，不再回退 OSS 快照）；
多指数云图 = live-treemap-{hs300,zza500,etf,hk}.json（缺失则前端自动隐藏对应标签）；
行情合并 = live-quotes.json + live-quotes-{etf,hk}.json（抓取时点的实时价，按代码覆盖进所有树；
盘内实时由前端腾讯接口接管，见 app.js）。
"""
import json, pathlib

root = pathlib.Path(__file__).resolve().parent
data = root / "data"

def load_tree(name):
    p = data / name
    if not p.exists():
        return None
    try:
        t = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(t.get("nodes"), list) and t["nodes"]:
            return t
        print(f"[skip] {name} 无 nodes")
    except Exception as e:
        print(f"[skip] {name} 解析失败: {e}")
    return None

tree = load_tree("live-treemap.json")
if tree is None:
    raise SystemExit("缺少 data/live-treemap.json：先运行 zsh refresh_fixtures.sh")

markets = {}
for m in ("hs300", "zza500", "etf", "hk"):
    mt = load_tree(f"live-treemap-{m}.json")
    if mt:
        markets[m] = {"updatedAt": mt.get("updatedAt"), "summary": mt.get("summary"), "nodes": mt["nodes"]}
        print(f"[市场] {m}: boards={len(mt['nodes'])} updatedAt={str(mt.get('updatedAt'))[:19]}")
    else:
        print(f"[市场] {m}: 无 fixture，对应标签将自动隐藏")

merged = 0
for qname in ("live-quotes.json", "live-quotes-etf.json", "live-quotes-hk.json"):
    qp = data / qname
    if not qp.exists():
        continue
    try:
        quotes = json.loads(qp.read_text(encoding="utf-8")).get("quotes", {})
        for t in [tree, *markets.values()]:
            for board in t.get("nodes", []):
                for stock in board.get("children", []):
                    hit = quotes.get(stock.get("code"))
                    if hit:
                        for key in ("price", "changePct", "turnoverAmount"):
                            if hit.get(key) is not None:
                                stock[key] = hit[key]
                        merged += 1
    except Exception as e:
        print(f"[warn] {qname} 合并失败: {e}")

out = dict(tree)
out["markets"] = markets
out["_meta"] = {"quotesMerged": merged}
payload = "window.TREEMAP_DATA=" + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";"
(data / "treemap.js").write_text(payload, encoding="utf-8")
print(f"OK: data/treemap.js  市场={list(markets) or '无'}  合并行情={merged} 条  树updatedAt={tree.get('updatedAt')}")
