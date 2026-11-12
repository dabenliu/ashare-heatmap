#!/bin/bash
# 流量保险丝:统计主网卡出网字节,接近流量包上限时停掉耗流量的服务,避免欠费。
# 由 heatmap-traffic-guard.timer 每分钟调用一次;日志:journalctl -t heatmap-guard
#
# 说明:
#  - 计数取 /proc/net/dev 的 tx(发送)字节。注意这是**保守上界**:阿里云内网流量
#    (100.100.x.x / VPC)不计费,但这里也统计了 → 只会更早触发,不会更晚。
#  - 重启会清零计数器,届时按"从开机起"近似补记(可能少记,误差有限)。
#  - 权威数字永远是控制台的流量监控/账单;这里只是本地保险丝。
set -u

CONF=/etc/heatmap-traffic-guard.conf
# shellcheck disable=SC1090
[ -f "$CONF" ] && . "$CONF"
LIMIT_MB=${LIMIT_MB:-20480}          # 月上限 20GB
WARN_MB=${WARN_MB:-18432}            # 预警线 18GB(90%)
STOP_MB=${STOP_MB:-19968}            # 熔断线 19.5GB(97.5%)
STOP_UNITS=${STOP_UNITS:-"heatmap-api hbrclient"}
IFACE=${IFACE:-auto}
ALREADY_USED_MB=${ALREADY_USED_MB:-0}   # 本周期开始前已用量(从控制台抄来校准)

STATE_DIR=${STATE_DIR:-/var/lib/heatmap-traffic}   # 可在 conf 里覆盖(测试用)
STATE=$STATE_DIR/state.env
mkdir -p "$STATE_DIR"

# 选网卡:出网字节最大的非 lo 网卡
if [ "$IFACE" = auto ]; then
  IFACE=$(awk 'NR>2 && $1!="lo:" && $1!="Inter-|" {i=$1; gsub(/:/,"",i); print i, $10}' /proc/net/dev \
          | sort -k2 -n | tail -1 | awk '{print $1}')
fi
TXNOW=$(awk -v i="$IFACE:" '$1==i {print $10}' /proc/net/dev)
MONTH=$(date +%Y-%m)

# 载入旧状态
LAST_TX=0; USED=0; SAVED_MONTH=""; STOPPED=0
# shellcheck disable=SC1090
[ -f "$STATE" ] && . "$STATE"

if [ "$SAVED_MONTH" != "$MONTH" ]; then
  # 新月:重置计数;若上周期熔断过,新周期自动恢复
  LAST_TX=$TXNOW
  USED=$((ALREADY_USED_MB * 1048576))
  SAVED_MONTH=$MONTH
  if [ "$STOPPED" = 1 ]; then
    for u in $STOP_UNITS; do systemctl start "$u" 2>/dev/null; done
    logger -t heatmap-guard "新计费周期 ${MONTH} 开始,已恢复: $STOP_UNITS"
    STOPPED=0
  fi
else
  DELTA=$((TXNOW - LAST_TX))
  [ "$DELTA" -lt 0 ] && DELTA=$TXNOW          # 计数器因重启归零
  USED=$((USED + DELTA))
  LAST_TX=$TXNOW
fi
USED_MB=$((USED / 1048576))

ACT=ok
if [ "$STOPPED" != 1 ] && [ "$USED_MB" -ge "$STOP_MB" ]; then
  for u in $STOP_UNITS; do
    systemctl stop "$u" 2>/dev/null && logger -t heatmap-guard "已停止 $u"
  done
  STOPPED=1; ACT=stopped
  logger -t heatmap-guard "⚠️ 月出网流量 ${USED_MB}MB 已达熔断线 ${STOP_MB}MB —— 已停止: $STOP_UNITS"
elif [ "$USED_MB" -ge "$WARN_MB" ]; then
  ACT=warn
  logger -t heatmap-guard "⚠️ 月出网流量 ${USED_MB}MB 已达预警线 ${WARN_MB}MB(上限 ${LIMIT_MB}MB)"
fi

# 原子写状态(server.js 的 /health 会读这个文件)
tmp=$STATE.tmp
{
  echo "month=$MONTH"
  echo "tx=$TXNOW"
  echo "used=$USED"
  echo "usedMB=$USED_MB"
  echo "limitMB=$LIMIT_MB"
  echo "warnMB=$WARN_MB"
  echo "stopMB=$STOP_MB"
  echo "stopped=$STOPPED"
  echo "action=$ACT"
  echo "iface=$IFACE"
  echo "at=$(date +%s)"
} > "$tmp" && mv "$tmp" "$STATE"

# 日志:异常时必打;平时每 10 分钟一行,别刷屏
if [ "$ACT" != ok ] || [ $(( 10#$(date +%M) % 10 )) -eq 0 ]; then
  logger -t heatmap-guard "月出网 ${USED_MB}MB / 上限 ${LIMIT_MB}MB(网卡 $IFACE · 状态 $ACT)"
fi
exit 0
