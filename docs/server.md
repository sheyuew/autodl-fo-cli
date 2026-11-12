# HTTP 服务器部署

当前部署在已有多账号 SSH/邀请码环境上迁移，保留受限 SSH、Linux 用户、账号绑定和私有 socket；HTTP 服务不启动 Chrome。

- 所有者：`fo-http.service`，由 `fo-autodl.target` 启动。
- 成员：`fo-http@成员代号.service`，由 `fo-user@成员代号.target` 启动。
- 邀请：`fo-enroll.service`，继续使用 `fo-admin invite-code 代号 服务器域名`。
- 运行文件：`/opt/fo-autodl/native/current`；Node 22 位于相邻 `node` 路径。
- 账号状态：原有 `/var/lib/fo-autodl` 和 `/var/lib/fo-tenants/代号`；控制 socket 为各目录中的 `control.sock`，权限 0600。

每个 HTTP 服务使用其原有 Linux 用户运行。登录会话和 AutoPanel 会话仅保存在该服务内存；只持久化账号绑定和登录名，不保存密码或 Token。升级重启后成员需要重新登录。日志只保留请求编号、操作类型、耗时和错误代码。

迁移前必须备份旧配置、代码、systemd 单元和用户状态，并明确停止旧监控。切换目标单元仅依赖 HTTP 服务；旧浏览器设置迁移阻止条件，不能在重启后自动恢复抢卡。

```bash
systemctl status fo-http.service fo-enroll.service
systemctl status fo-http@成员代号.service
journalctl -u fo-http@成员代号.service -n 50 --no-pager
```

本仓库原 `install-multi.sh`、`install-server.sh` 属于旧 Fo 浏览器部署，当前不应用于 HTTP 服务器；运行它们会覆盖迁移单元。完整的一键从零 HTTP 安装脚本尚未提供。管理员应使用已部署 HTTP 服务模板开通成员；原 `fo-admin` 注册及邀请码流程保持兼容，成员目标现在启动 HTTP 服务。

恢复旧 Fo 必须先停止 HTTP 服务，使用本机 root 私有备份恢复旧代码和 systemd 单元，并审查旧监控，避免意外恢复付费任务。旧部署参考 [历史服务器说明](legacy-server.md)。
