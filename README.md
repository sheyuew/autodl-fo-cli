# AutoDL HTTP CLI

通过 SSH 让服务器执行 AutoDL 子账号登录、实例与库存查询，以及 AutoPanel 网盘文件传输。当前 HTTP 后端不运行 Chrome，不依赖 Fo 或开发者 Token。

**当前不提供抢卡、创建实例或开关机。** 从旧 Fo 部署切换时需明确停止旧监控并备份；旧任务不会自动转换为 HTTP 任务。

## 成员开始使用

需要 Node.js 22+ 和 OpenSSH，无需 `npm install`。Windows 当前使用 WSL，尚未做 Windows 原生实测。

```bash
bash ./fo join       # 首次使用：输入管理员提供的一次性邀请码
bash ./fo login      # 已接入：输入自己的 AutoDL 子账号和密码
bash ./fo http       # 进入 HTTP 操作菜单
```

子账号填完整的 `用户名@主账户ID`。登录 HTTP 服务器后保存连接类型，下次运行 `bash ./fo` 可直接进入 HTTP 菜单。现有成员继续使用自己的 SSH 密钥和连接配置，升级客户端后重新登录即可。

登录密码不保存；AutoDL 会话仅保留在服务器内存，服务重启或会话过期后需重新登录。首次登录后绑定账号，其他 AutoDL 账号使用另一个邀请码及独立环境。

```bash
bash ./fo accounts   # 已保存账号
bash ./fo switch     # 切换独立账号连接
bash ./fo doctor     # 查看服务器后端及登录状态
```

## HTTP 菜单

主菜单提供实例列表、地区库存、GPU 型号和 AutoPanel。库存数量为有空闲卡的主机数，不保证下单成功。

进入 AutoPanel 后选择已运行实例，隐藏输入其独立访问密码：

| 输入 | 功能 |
|---|---|
| 1 | 浏览实例本地目录 |
| 2 | 浏览已授权网盘目录 |
| 3 / 4 | 传输队列 / 历史记录 |
| 5 | 实例文件上传至阿里云盘 |
| 6 | 阿里云盘文件下载至实例 |
| p / q | 重新登录 AutoPanel / 返回 |

上传输入实例文件的绝对路径，浏览网盘到目标目录后输入 `s`。下载时浏览并选择网盘文件，下载位置使用 AutoPanel 默认工作目录，通常为 `/root/autodl-tmp`。最终核对方向和路径，输入 `yes` 提交，`no` 取消；发现同名目标则拒绝提交。

当前传输仅支持阿里云盘的单个文件。资源库完成过真实 256 KiB 往返和 SHA-256 校验；备份盘、大文件、递归目录和断点续传尚未实测。提交成功表示任务已排队，通过 3/4 查看实际状态。响应中断后不自动重试，避免重复提交。

服务器负责网盘传输，本地断网不会停止已经被 AutoPanel 接收的任务；重新连接后查看队列或历史。HTTP 版本当前未接入传输完成的本地桌面通知。

## 管理员与开发

已有 SSH 邀请注册仍使用 `fo-admin invite-code`。HTTP 服务按独立 Linux 用户和私有 Unix socket 隔离，服务器管理员可管理这些环境。客户端不会收到实例密码、Jupyter Token、网盘授权 Token 或签名下载链接。

- [服务器说明](docs/server.md)
- [首次使用](docs/quickstart.md)
- [旧 Fo 文档（历史兼容）](docs/legacy-fo.md)

原生模块位于 `native/`。可直接运行 `node native/cli.mjs` 在本机请求 AutoDL，或 `node native/cli.mjs --remote 配置.json` 使用服务器。旧 Fo 适配代码保留用于审查和迁移，不在 HTTP 服务中执行。

```bash
npm test
npm run test:native
npm run test:terminal
```

接口取自 AutoDL 公开网页及 AutoPanel 前端，没有官方开放 API 的稳定性承诺；平台变更可能需要更新。
