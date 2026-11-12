# 管理员：为成员开通

服务器需要已有 Fo 专用浏览器环境。每个成员分配独立 Linux 用户、Chrome 资料、私有 Unix socket、X 显示、浏览器查看端口、计划和通知存储。运行小内存服务器时请逐人开通并观察响应；每个活跃成员仍有常驻 Chrome。

## 部署前提

以下环境路径是安装脚本的约定，需要先具备：

- Linux、systemd、OpenSSH 服务、Node.js 18+（新安装推荐官网 LTS）。
- Chrome：`/opt/fo-autodl/browser/chrome-linux64/chrome`，Linux sandbox 可正常工作。
- Xvfb、Openbox、xauth、x11vnc、websockify，以及 `/opt/fo-autodl/www` 下的 noVNC。
- 从 [Fo 上游](https://github.com/Fo-OLLL/autodl-card-helper) 单独取得 `autodl-helper.user.js`，置于 `/opt/fo-autodl/www/autodl-helper.user.js`。

当前运行时只接受 Fo 0.3.5，SHA-256 必须为：

```text
593016a9c2079e3ff9e77e5cd05e45fa84b9ffae8533d246e9976b88c01f286a
```

已核对的上游提交：`f36e49281a4af7df9913e45c32a53630b7b1835b`。本仓库不包含上游源码。原有所有者环境可继续使用其已安装的篡改猴；新增成员无需扩展。

将本仓库的服务器源文件复制至服务器目录后，以 root 执行：

```bash
bash install-multi.sh
```

这会安装 `/opt/fo-autodl/multi`、`fo-admin` 和多账号 systemd 模板。安装时不重启已有浏览器。更改正在运行的浏览器端代码后，需要在维护时重启对应成员服务。

## 成员开通流程

推荐直接生成邀请码：

```bash
fo-admin invite-code alice server.example.com
```

将服务器 IP/域名替换为实际值，把输出的 `FO1-` 完整邀请码私下发给 Alice。她只需 `bash ./fo join` 粘贴，然后在终端输入自己的 AutoDL 账号密码。无需收集公钥、发送 JSON 或手动指定私钥。

邀请码默认 24 小时有效，首次兑换才创建独立环境并绑定成员本机公钥；同一公钥可恢复中断的兑换，其他公钥拒绝。每个 AutoDL 账号使用一个新代号和邀请码。重复生成尚未兑换的同代号邀请码会撤销旧的未绑定码。终端会同时显示 `fo-admin revoke-code 邀请ID`，可提前撤销。

`fo-enroll.service` 以 root 管理本机 Unix socket；专用 SSH 身份 `fo-enroll` 只允许使用临时密钥执行指定邀请码的兑换，不提供 shell、终端、端口转发或其他账号访问。邀请码包含该受限临时凭证，请按密码保管。服务只借用既有 SSH 端口，不新增公网监听。真实成员密钥在成员电脑生成，服务器只接收公钥。

已有手工公钥方式仍可继续：

1. 请成员从 GitHub 下载客户端并运行 `bash ./fo keygen`，把公钥和英文代号发来。管理员不需要成员私钥或 AutoDL 密码。
2. 把公钥保存为服务器上的 `/path/to/alice.pub`，然后执行：

```bash
fo-admin add alice /path/to/alice.pub
fo-admin invite alice server.example.com
```

将 `server.example.com` 换成实际服务器 IP 或域名。代号用小写字母开头，可含数字和短横线，最多 24 个字符；`owner` 是保留名称。

3. 取回 `/opt/fo-autodl/member-bundles/alice.connection.json`，私下发给 Alice。
4. Alice 从共同 GitHub 下载客户端，导入自己的连接文件，运行 `fo login` 登录自己的 AutoDL。无需为每人重新分发一整套程序。

邀请文件包含服务器公钥与专用 SSH 用户；无需开启额外公网浏览器端口。成员 SSH 仅允许自己的 `fo-rpc` 和自己的 localhost 浏览器转发。

## 管理命令

```bash
fo-admin list
fo-admin invite-code 新代号 server.example.com
fo-admin revoke-code 邀请ID
fo-admin key alice /path/to/new.pub
fo-admin invite alice server.example.com
fo-admin disable alice
```

`disable` 撤销成员 SSH 并停止对应环境，保留资料。更换 SSH 公钥后，成员重新连接即可。首次读取成功后绑定 AutoDL 身份；更换 AutoDL 账号前需先核对遗留任务并由管理员处理，不要让另一人直接复用资料目录。

旧式专用完整包仍可生成：`fo-admin bundle alice server.example.com`。

## 服务与存储

- 成员：`fo-user@alice.target`，浏览器 `fo-browser@alice.service`。
- 邀请兑换：`fo-enroll.service`，私有 socket `/run/fo-enroll/enroll.sock`，邀请元数据 `/var/lib/fo-enrollment`（0700）。
- 所有者原环境：`fo-autodl.target`、`fo-browser.service`。
- 成员资料：`/var/lib/fo-tenants/alice`，目录 0700，控制 socket/任务文件 0600。
- 元数据与受限 SSH 配置由 root 管理，成员不能通过 RPC 指定其他账号或 socket。
- 浏览器只使用 Chrome pipe，VNC/web 只绑定 localhost；公网仍使用已有 SSH 入口。

查看日志：`journalctl -u fo-browser@alice.service -n 80`。重启某个成员：`systemctl restart fo-browser@alice.service`，会短暂中断该成员监控。浏览器正常退出会刷新持久化状态。

登录排查：

```bash
journalctl -u fo-browser@alice.service --since '30 minutes ago' --no-pager -o cat
```

网关为每次请求记录 `rpc.received`、`rpc.started`、`rpc.finished`，用 `requestId` 关联，包含排队时间、执行耗时和错误代码。登录还记录 `login.stage`：页面加载、输入框是否找到、提交、等待结果、验证码、超时及登录状态。终端报错带请求编号，可在上述日志中定位。`LOGIN_REQUIRED` 表示尚未登录成功；只有已登录且身份不同才返回 `ACCOUNT_MISMATCH`。

日志只保存允许的诊断字段，不记录账号密码、Token、邀请码、浏览器存储、原始请求响应或异常原文。升级前没有记录的登录细节无法补回，需要重新登录一次采集。日志由 systemd journal 管理，保留周期遵循服务器 journald 配置。

## 所有者旧环境

`install-server.sh` 用于把 CLI 网关接入已安装篡改猴的所有者环境，会重启 `fo-browser.service`。它要求扩展已经持久安装，使用前请在维护窗口备份浏览器资料并核对现有任务。

## 凭据与发布

GitHub 仅分发代码，连接文件私下发送。仓库不应上传 `config.json`、私钥、AutoDL 会话、浏览器资料或个人部署记录。成员无法获得其他成员账号权限，但服务器管理员可管理这些环境。

升级至支持终端登录的服务器代码后，已有浏览器进程需要在合适时机重启对应服务才能加载新操作；安装多账号模板本身不重启已有浏览器。客户端 `fo login-browser` 保留浏览器登录方式。

平台接口或登录失效时需要重新适配/登录；自研为纯 HTTP 的任务引擎不在当前版本内。真实租用由最终确认的约束决定，发布或安装客户端本身不创建付费任务。
