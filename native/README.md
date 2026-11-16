# Native HTTP backend

从仓库根目录运行 `bash ./fo` 使用本地菜单；`bash ./fo login` 登录后，可通过独立子命令和 `--json` 操作，见 [Codex 操作说明](../docs/codex.md)。需要 Node.js 20.17.0+，无 npm 运行依赖。

本地会话进程自动启动，只通过当前用户的私有 Unix socket 提供 IPC，没有 TCP 服务端口。AutoDL 与 AutoPanel 登录状态仅在进程内存中；密码不保存。不同账号使用独立会话，账号名称作为选择信息保存。空闲 30 分钟后会话进程退出；电脑重启、会话进程退出或登录过期后需重新登录。

支持子账号实例管理、实时开机报价、镜像管理、库存读取、AutoPanel 目录、阿里云盘文件/目录传输、任务控制及本地结果提醒。修改需最终 yes/no；尚不支持抢卡、新建/克隆、规格/磁盘调整、主账号登录或电脑本地直接上传下载。详见 [功能清单](../docs/features.md)。

`node native/cli.mjs` 是单进程交互入口，退出后内存会话结束。已有服务器模式仍可用 `bash ./fo remote ...` 或 `node native/cli.mjs --remote 连接配置.json`，参考 [服务器说明](../docs/server.md)；本地模式无需这些配置。
