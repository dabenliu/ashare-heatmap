#!/bin/bash
# 服务器上的部署脚本:拉最新代码 → 重启服务 → 打印状态
# 为什么要脚本:大陆机器访问 github.com 会间歇性抖动("Empty reply from server" /
# Connection timed out 都见过),裸跑 git pull 偶尔失败,这里自动重试 5 次。
# 用法(服务器上): bash /srv/heatmap/server/deploy/deploy.sh
cd "$(dirname "$0")/../.." || exit 1     # → /srv/heatmap
before=$(git rev-parse --short HEAD)
echo "[deploy] 当前 $before"

ok=""
for i in 1 2 3 4 5; do
  out=$(git pull --ff-only 2>&1); rc=$?
  echo "$out" | tail -2
  if [ $rc -eq 0 ]; then ok=1; break; fi
  echo "[deploy] pull 失败(第 $i/5 次),5 秒后重试…"
  sleep 5
done
if [ -z "$ok" ]; then
  echo "[deploy] 连续 5 次都没拉到 github,放弃。稍后再试;急用时可在 Mac 上 rsync 直传兜底。"
  exit 1
fi

after=$(git rev-parse --short HEAD)
echo "[deploy] $before → $after"

systemctl restart heatmap-api
sleep 3
echo "[deploy] 服务状态: $(systemctl is-active heatmap-api)"
journalctl -u heatmap-api -n 3 --no-pager -o cat | tail -2
