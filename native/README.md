# Native HTTP backend

从仓库根目录运行 `bash ./fo http` 使用已配置服务器；或 `node native/cli.mjs --remote 连接配置.json`。

不带 `--remote` 时直接在本机访问 AutoDL。Node.js 22+，无 npm 运行依赖。会话仅保存在实际请求端的内存；退出本机模式或重启服务器服务后需重新登录。

支持子账号实例/库存读取，以及 AutoPanel 目录、任务状态和阿里云盘单文件传输。传输需最终 yes/no；尚不支持抢卡任务或主账号登录。详见根目录 README。
