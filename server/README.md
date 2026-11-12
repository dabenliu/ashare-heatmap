# heatmap-api · 行情中转服务

把「每个访客的浏览器各自去打行情源」改成「**服务器抓一次、全站共享一份**」。

## 它做什么

- 交易时段**每 10s**、其余时间每 5 分钟，从 4 家源抓一轮：
  - `jrj` 沪深全市场（一次 POST，~84ms / 5213 只）
  - `腾讯` 北交所（3 批）/ ETF（12 批）/ 港股（19 批），每批 ≤150 码
  - `同花顺` 当日成交额摘要
  - `东财` 行业板块主力净流入 Top20 / 净流出 Top20（服务端可直连，浏览器当年会被风控）
  - 外加 9 个指数（一个腾讯批量请求）
- 在内存里维护一份快照，对外只有 `GET /api/snapshot`（gzip + ETag/304）
- 某个源失败 → **保留上一份数据**继续服务，只在 `/health` 和日志里标 `✗`
- **每源独立节奏 + 失败退避**：东财资金流固定 60s 一次（10s 一次会被其限流封 IP，2026-11-12 实测）；
  任何源连续失败按 30s→1m→2m…最多 10 分钟退避，成功立刻恢复（日志里 `flow·` 表示本轮跳过）
- 名单（要报价的代码全集）从 `../data/live-treemap*.json` 提取；文件被 `git pull` 更新后**自动重载**（每轮查 mtime）

## 接口

`GET /api/snapshot`（轮询请带 `If-None-Match`，未变化时返回 304）

```jsonc
{
  "ts": 1762915200000,          // 该内容首次出现的时间
  "seq": 42,                    // 内容每变一次 +1（ETag = "v42"）
  "session": "trading",         // trading | closed
  "markets": {
    "all": { "600519.SH": [1500.5, 1.23, 890000000], ... },  // [现价, 涨跌%, 成交额元(可省)]
    "etf": { ... },
    "hk":  { ... }
  },
  "indices":  { "sh000001": { "price": 3680.64, "pct": 0.46 }, ... },
  "turnover": { "amount": 1494552500000, "previous": ..., "delta": ... },
  "flow":     { "in": [{ "name": "半导体", "amt": 1.2e9, "pct": 4.5 }, ...], "out": [...] },
  "sources":  { "jrj": { "ok": true, "ms": 84, "count": 5213 }, ... }
}
```

`GET /health` — 服务运行态与各源最近一轮结果（排错第一站）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | 只监听回环；对外暴露交给 nginx / SSH 隧道 |
| `DATA_DIR` | `/srv/heatmap/data` | 树文件（名单来源）所在目录 |
| `TRADING_INTERVAL_MS` | `10000` | 交易时段刷新间隔 |
| `IDLE_INTERVAL_MS` | `300000` | 非交易时段刷新间隔 |
| `UPSTREAM_TIMEOUT_MS` | `8000` | 单个上游请求超时 |

## 常用命令

```bash
systemctl status heatmap-api          # 活着吗
journalctl -u heatmap-api -f          # 实时日志（每轮一行 [cycle N]）
journalctl -u heatmap-api -n 50       # 最近 50 行
systemctl restart heatmap-api         # 改了代码/配置后重启
curl -s localhost:8787/health         # 各源状态
curl -s -o /dev/null -w '%{size_download}B %{time_total}s\n' localhost:8787/api/snapshot
```

## 部署 / 更新

```bash
# Mac 本地改完 → push 后，在服务器上：
cd /srv/heatmap && git pull
systemctl restart heatmap-api
```

首次安装：

```bash
cp /srv/heatmap/server/deploy/heatmap-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now heatmap-api
```

## 流量账（关注 20GB/月 上限的看这里）

出网流量才计费（入网免费）。消耗分两处：

1. **服务自己抓上游**（无访客也在烧）：每轮出网 ≈51KB（大头是腾讯的代码清单），
   交易时段 10s 一轮 ≈133MB/交易日，月 ≈ **3.3GB**（按 22 个交易日 + 非交易时段 5 分钟一轮）。
   降频旋钮：调大 `TRADING_INTERVAL_MS`；或将来做成"只拉当前打开的市场"。
2. **对客户端的响应**：全量 gzip 86KB/次，304 ≈ 0。
   具体多少 = 客户端轮询频率 × 内容变化频率。10s 轮询的常开客户端 ≈ 2.6GB/月。
   （接前端时再决定用 `?market=` 子集或降低轮询频率。）

控制手段：
- `/health` 里 `egress.todayMB / totalMB` = 服务自己的出网响应计数（上游另计，见上）
- 阿里云控制台 → 费用与成本 → **设流量包/消费预警**（官方兜底，必设）
- 大文件（treemap.js 2.4MB 等静态资源）**不放服务器出**，继续走 GitHub Pages 免费 CDN

## 已知取舍 / 下一步

- **快照体积**：全量 280KB → gzip 86KB。现在只有 304 和"内容变了才换 seq"两道机制省流量；
  等前端真正接进来后如果流量费敏感，再加 `?market=all|etf|hk` 子集（按当前视图只发一个市场，
  省 45%~90%）或 `?since=<seq>` 增量（只发变化的代码）。**接前端时再定，先不提前优化。**
- **盘中留档 SQLite**：快照已经在内存里了，下一阶段每轮落一条 → 支撑"时间轴回放"。
- **名单重载**：靠树文件 mtime 变化触发；`git pull` 更新数据后无需重启服务。

## 排错顺序

1. `systemctl status heatmap-api` —— 服务在不在？
2. `journalctl -u heatmap-api -n 50` —— 启动报错？某源连续 `✗`？错误信息里有原因
3. `curl localhost:8787/health` —— 哪个源挂了、覆盖多少只
4. 上游报错都带 http 状态码；`✗` 不影响其余源（各自独立、保留上一份数据）
5. 端口通了但页面连不上 → 那是 nginx / 安全组的事，不是本服务
