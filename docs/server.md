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
fo-admin key alice /path/to/new.pub
fo-admin invite alice server.example.com
fo-admin disable alice
```

`disable` 撤销成员 SSH 并停止对应环境，保留资料。更换 SSH 公钥后，成员重新连接即可。首次读取成功后绑定 AutoDL 身份；更换 AutoDL 账号前需先核对遗留任务并由管理员处理，不要让另一人直接复用资料目录。

旧式专用完整包仍可生成：`fo-admin bundle alice server.example.com`。

## 服务与存储

- 成员：`fo-user@alice.target`，浏览器 `fo-browser@alice.service`。
- 所有者原环境：`fo-autodl.target`、`fo-browser.service`。
- 成员资料：`/var/lib/fo-tenants/alice`，目录 0700，控制 socket/任务文件 0600。
- 元数据与受限 SSH 配置由 root 管理，成员不能通过 RPC 指定其他账号或 socket。
- 浏览器只使用 Chrome pipe，VNC/web 只绑定 localhost；公网仍使用已有 SSH 入口。

查看日志：`journalctl -u fo-browser@alice.service -n 80`。重启某个成员：`systemctl restart fo-browser@alice.service`，会短暂中断该成员监控。浏览器正常退出会刷新持久化状态。

## 所有者旧环境

`install-server.sh` 用于把 CLI 网关接入已安装篡改猴的所有者环境，会重启 `fo-browser.service`。它要求扩展已经持久安装，使用前请在维护窗口备份浏览器资料并核对现有任务。

## 凭据与发布

GitHub 仅分发代码，连接文件私下发送。仓库不应上传 `config.json`、私钥、AutoDL 会话、浏览器资料或个人部署记录。成员无法获得其他成员账号权限，但服务器管理员可管理这些环境。

平台接口或登录失效时需要重新适配/登录；自研为纯 HTTP 的任务引擎不在当前版本内。真实租用由最终确认的约束决定，发布或安装客户端本身不创建付费任务。
