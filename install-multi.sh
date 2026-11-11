#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" = 0
fo_source=$(cd -- "$(dirname -- "$0")" && pwd)
fo_dest=/opt/fo-autodl/multi
test -x /opt/fo-autodl/browser/chrome-linux64/chrome
test -f /opt/fo-autodl/www/autodl-helper.user.js
node --check "$fo_source/server.mjs"
node --check "$fo_source/admin.mjs"
install -d -m 0755 "$fo_dest/lib" /etc/fo-autodl/tenants /etc/fo-autodl/users /etc/fo-autodl/keys /etc/fo-autodl/env
install -d -m 0711 /var/lib/fo-tenants
install -m 0644 "$fo_source"/*.mjs "$fo_source/README.md" "$fo_dest/"
if [ -f "$fo_source/THIRD_PARTY.md" ]; then install -m 0644 "$fo_source/THIRD_PARTY.md" "$fo_dest/"; fi
if [ -d "$fo_source/docs" ]; then
  install -d -m 0755 "$fo_dest/docs"
  install -m 0644 "$fo_source"/docs/*.md "$fo_dest/docs/"
fi
if [ -f "$fo_source/开始使用.command" ]; then install -m 0755 "$fo_source/开始使用.command" "$fo_dest/"; fi
install -m 0644 "$fo_source"/lib/*.mjs "$fo_dest/lib/"
install -m 0755 "$fo_source/fo" "$fo_source/stop-server.sh" "$fo_dest/"
cat > /usr/local/bin/fo-admin <<'SCRIPT'
#!/bin/sh
exec /usr/bin/node /opt/fo-autodl/multi/admin.mjs "$@"
SCRIPT
chmod 0755 /usr/local/bin/fo-admin
cat > /etc/systemd/system/fo-user@.target <<'UNIT'
[Unit]
Description=Independent Fo environment %i
Wants=fo-display@%i.service fo-window@%i.service fo-browser@%i.service fo-vnc@%i.service fo-web@%i.service
After=network-online.target
Wants=network-online.target
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/fo-display@.service <<'UNIT'
[Unit]
Description=Fo display %i
PartOf=fo-user@%i.target
[Service]
User=fo-u-%i
Group=fo-u-%i
EnvironmentFile=/etc/fo-autodl/env/%i
ExecStart=/usr/bin/Xvfb ${FO_DISPLAY} -screen 0 1440x1000x24 -auth ${FO_STATE}/Xauthority -nolisten tcp
Restart=always
RestartSec=5
UMask=0077
UNIT
cat > /etc/systemd/system/fo-window@.service <<'UNIT'
[Unit]
Description=Fo window manager %i
Requires=fo-display@%i.service
After=fo-display@%i.service
PartOf=fo-user@%i.target
[Service]
User=fo-u-%i
Group=fo-u-%i
EnvironmentFile=/etc/fo-autodl/env/%i
ExecStart=/usr/bin/openbox
Restart=always
RestartSec=5
UMask=0077
UNIT
cat > /etc/systemd/system/fo-browser@.service <<'UNIT'
[Unit]
Description=Fo account browser and CLI %i
Requires=fo-display@%i.service
After=fo-display@%i.service network-online.target
PartOf=fo-user@%i.target
[Service]
User=fo-u-%i
Group=fo-u-%i
EnvironmentFile=/etc/fo-autodl/env/%i
ExecStart=/usr/bin/dbus-run-session -- /usr/bin/node /opt/fo-autodl/multi/server.mjs
ExecStop=/opt/fo-autodl/multi/stop-server.sh $MAINPID
KillMode=mixed
TimeoutStopSec=30
Restart=always
RestartSec=5
UMask=0077
ProtectSystem=full
ProtectHome=yes
ProtectProc=invisible
MemoryHigh=512M
MemoryMax=768M
MemorySwapMax=1G
CPUQuota=100%
UNIT
cat > /etc/systemd/system/fo-vnc@.service <<'UNIT'
[Unit]
Description=Fo private VNC %i
Requires=fo-display@%i.service
After=fo-display@%i.service
PartOf=fo-user@%i.target
[Service]
User=fo-u-%i
Group=fo-u-%i
EnvironmentFile=/etc/fo-autodl/env/%i
ExecStart=/usr/bin/x11vnc -display ${FO_DISPLAY} -auth ${FO_STATE}/Xauthority -rfbauth ${FO_STATE}/vnc.passwd -rfbport ${FO_VNC_PORT} -rfbportv6 -1 -listen 127.0.0.1 -localhost -noipv6 -no6 -forever -shared -xkb -noxdamage -quiet
Restart=always
RestartSec=5
UMask=0077
UNIT
cat > /etc/systemd/system/fo-web@.service <<'UNIT'
[Unit]
Description=Fo private browser viewer %i
Requires=fo-vnc@%i.service
After=fo-vnc@%i.service
PartOf=fo-user@%i.target
[Service]
User=fo-u-%i
Group=fo-u-%i
EnvironmentFile=/etc/fo-autodl/env/%i
ExecStart=/usr/bin/websockify --web=/opt/fo-autodl/www 127.0.0.1:${FO_WEB_PORT} 127.0.0.1:${FO_VNC_PORT}
Restart=always
RestartSec=5
UMask=0077
UNIT
systemctl daemon-reload
if ! id fo-enroll >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /bin/sh --password '*' fo-enroll
fi
install -d -m 0700 /var/lib/fo-enrollment
touch /etc/fo-autodl/enrollment_keys
chmod 0644 /etc/fo-autodl/enrollment_keys
cat > /etc/ssh/sshd_config.d/69-fo-enroll.conf <<'SSH'
Match User fo-enroll
    AuthorizedKeysFile /etc/fo-autodl/enrollment_keys
    PermitTTY no
    DisableForwarding yes
    PermitUserRC no
    PasswordAuthentication no
    KbdInteractiveAuthentication no
Match all
SSH
/usr/sbin/sshd -t
systemctl reload ssh
cat > /etc/systemd/system/fo-enroll.service <<'UNIT'
[Unit]
Description=Fo one-time invitation service
After=network.target
[Service]
User=root
Group=fo-enroll
RuntimeDirectory=fo-enroll
RuntimeDirectoryMode=0750
UMask=0007
ExecStart=/usr/bin/node /opt/fo-autodl/multi/enroll-server.mjs
Restart=on-failure
RestartSec=3
PrivateTmp=yes
ProtectHome=yes
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now fo-enroll.service
printf '多账号及邀请码服务已安装；原浏览器未重启。使用 fo-admin invite-code 新代号 服务器地址 生成邀请码。\n'
