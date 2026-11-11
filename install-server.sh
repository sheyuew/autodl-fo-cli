#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" != 0 ]; then printf '请以 root 安装。\n' >&2; exit 1; fi
fo_source=$(cd -- "$(dirname -- "$0")" && pwd)
fo_dest=/opt/fo-autodl/cli
test -x /opt/fo-autodl/browser/chrome-linux64/chrome
test -f /etc/systemd/system/fo-browser.service
python3 - <<'PY'
import json
p=json.load(open('/var/lib/fo-autodl/profile/Default/Preferences'))
assert any(v.get('location')==4 and v.get('path')=='/opt/fo-autodl/tampermonkey'
           for v in p.get('extensions',{}).get('settings',{}).values()), '请先在 Chrome 中持久加载现有篡改猴扩展'
PY
node --check "$fo_source/server.mjs"
install -d -m 0755 "$fo_dest/lib" /etc/systemd/system/fo-browser.service.d
install -m 0644 "$fo_source/server.mjs" "$fo_source/rpc.mjs" "$fo_dest/"
install -m 0755 "$fo_source/stop-server.sh" "$fo_dest/"
install -m 0644 "$fo_source"/lib/*.mjs "$fo_dest/lib/"
if [ ! -f /etc/systemd/system/fo-browser.service.d/cli.conf ]; then
  cp /etc/systemd/system/fo-browser.service /opt/fo-autodl/fo-browser.before-cli.service
fi
cat > /etc/systemd/system/fo-browser.service.d/cli.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=/usr/bin/dbus-run-session -- /usr/bin/node /opt/fo-autodl/cli/server.mjs
ExecStop=/opt/fo-autodl/cli/stop-server.sh $MAINPID
KillMode=mixed
TimeoutStopSec=30
UNIT
systemctl daemon-reload
systemctl restart fo-browser.service
systemctl is-active fo-browser.service
printf '命令行网关已接入，正在等待 Fo 和登录页面恢复。\n'
