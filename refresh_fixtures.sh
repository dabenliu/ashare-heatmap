#!/bin/bash
# 重抓 dapanyuntu API 的数据到 data/，每个接口循环重试直到 JSON 校验通过。
# 2026-11-10 起完全去快照：全部走站点 API（OSS treemap*.json 快照已不再使用/已删除）。
# bash 兼容（GitHub Actions ubuntu runner 直接可跑）；本地 zsh 下 `bash refresh_fixtures.sh` 同样可用。
# 用法: bash refresh_fixtures.sh   （树=板块+市值权重，quotes=抓取时点的实时行情）
cd "$(dirname "$0")"
mkdir -p data
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
API="https://www.dapanyuntu.com/api"                                            # 站点自家 API，Cloudflare 后面，偶发闪断，靠重试

grab() { # grab <输出名> <URL> [最大重试]
  local name="$1" url="$2" tries="${3:-6}" tmp="data/.tmp.$1"
  for i in $(seq 1 "$tries"); do
    code=$(curl -s --compressed -o "$tmp" -w "%{http_code}" \
      -A "$UA" -H "Accept: application/json, text/plain, */*" \
      -H "Referer: https://www.dapanyuntu.com/" \
      --connect-timeout 8 --max-time 60 "$url")
    if [ "$code" = "200" ] && python3 -c "import json;json.load(open('$tmp',encoding='utf8'))" 2>/dev/null; then
      mv "$tmp" "data/$name.json"; echo "$name: ok (第${i}次, $(wc -c < "data/$name.json" | tr -d ' ')B)"; return 0
    fi
    echo "$name: 第${i}次失败 http=$code，重试..."; sleep 2
  done
  rm -f "$tmp"; echo "$name: ❌ $tries 次都没拿到"; return 1
}

# 云图树（板块→个股，面积=市值权重）×5 个市场
grab live-treemap        "$API/heatmap/treemap?market=all&period=day"
grab live-treemap-hs300  "$API/heatmap/treemap?market=hs300&period=day"    # 沪深300 成分云图
grab live-treemap-zza500 "$API/heatmap/treemap?market=zza500&period=day"   # 中证A500 成分云图
grab live-treemap-etf    "$API/heatmap/treemap?market=etf&period=day"      # ETF 市场云图
grab live-treemap-hk     "$API/heatmap/treemap?market=hk&period=day"       # 港股市场云图
# 行情快照（构建时合并进树；盘内实时由前端腾讯接口接管）×3
grab live-quotes         "$API/heatmap/quotes?market=all&period=day"
grab live-quotes-etf     "$API/heatmap/quotes?market=etf&period=day"
grab live-quotes-hk      "$API/heatmap/quotes?market=hk&period=day"
