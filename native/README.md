# Native HTTP backend

从仓库根目录运行 `bash ./fo http` 使用已配置服务器；或 `node native/cli.mjs --remote 连接配置.json`。

不带 `--remote` 时直接在本机访问 AutoDL。Node.js 20.17.0+，无 npm 运行依赖。会话仅保存在实际请求端的内存；退出本机模式或重启服务器服务后需重新登录。

支持子账号实例管理、实时开机报价、镜像管理、库存读取、AutoPanel 目录、阿里云盘文件/目录传输、任务控制及本地结果提醒。执行需最终 yes/no；尚不支持抢卡、新建/克隆、规格/磁盘调整或主账号登录。详见根目录 README 和 docs/features.md。
