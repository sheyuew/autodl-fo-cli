# AutoDL Fo CLI

通过本地命令行管理服务器上的 AutoDL 抢卡任务。支持子账号、多账号隔离、最后 `yes/no` 确认，以及终端和本地桌面完成提醒。

**[下载客户端](https://github.com/sheyuew/autodl-fo-cli/releases/latest) · [第一次使用](docs/quickstart.md) · [管理员开通成员](docs/server.md)**

> 使用自己的 AutoDL 网页账号登录，无需 AutoDL 开发者 Token。任务交给服务器后，本地可以退出或断网。服务器仍需持续联网并保持有效登录。

## 成员只需三步

先安装 [Node.js 官网 LTS](https://nodejs.org/zh-cn/download)（推荐 22 或更新版本）及 OpenSSH。客户端无需 `npm install`。macOS/Linux 可直接使用，Windows 当前通过 [WSL](https://learn.microsoft.com/zh-cn/windows/wsl/install) 使用。

1. 从 Releases 下载客户端 ZIP，解压。进入文件夹，在终端运行 `bash ./fo`；macOS 也提供 `开始使用.command`。
2. 向管理员领取一次性邀请码，首次启动直接按提示粘贴；程序自动生成并保存本机密钥、兑换个人连接，无需传公钥、找密钥文件或填写路径。
3. 在终端输入自己的 AutoDL 账号和密码。密码隐藏输入，不保存在客户端配置或服务器任务文件中。登录后直接进入任务菜单；平台要求验证码或滑块时，程序打开浏览器供本人完成。

添加其他 AutoDL 账号用 `bash ./fo join` 输入另一个邀请码，之后 `bash ./fo switch` 从已保存的账号中切换。**每个 AutoDL 账号对应一个独立服务器环境和邀请码**，切换不影响另一个账号已提交的任务。

已有连接文件时也可直接导入：

```bash
bash ./fo setup /path/to/alice.connection.json
bash ./fo login
bash ./fo
```

无需手改 JSON，无需成员安装篡改猴。GitHub 下载本身不会自动获得服务器访问权限，请先联系你们的管理员。

## 日常使用

| 命令 | 用途 |
| --- | --- |
| `bash ./fo` | 操作菜单：创建任务、查看状态、登录、提醒等 |
| `bash ./fo wizard` | 逐项选择任务，完整预览后输入 `yes/no`，默认取消 |
| `bash ./fo status` | 查看自己账号的任务 |
| `bash ./fo login` | 在终端输入账号密码，登录或刷新 AutoDL 登录 |
| `bash ./fo join` | 输入一次性邀请码，自动配置并登录新账号 |
| `bash ./fo accounts` | 查看已保存的 AutoDL 账号 |
| `bash ./fo switch` | 选择并切换账号，不取消其他账号的任务 |
| `bash ./fo login-browser` | 需要时使用浏览器登录 |
| `bash ./fo watch` | 等待终端和本地桌面完成提醒 |
| `bash ./fo notifications` | 查看离线期间服务器保存的通知 |
| `bash ./fo doctor` | 检查连接、登录和 Fo 加载情况 |
| `bash ./fo browser` | 查看自己的远程 Fo 窗口 |
| `bash ./fo notify-test` | 测试本地桌面通知 |
| `bash ./fo keygen` | 生成或复用本机专用 SSH 密钥，显示公钥 |
| `bash ./fo setup 文件` | 导入管理员提供的连接文件 |
| `bash ./fo help` | 全部命令 |

高级预览：`bash ./fo plan examples/clone.json`；确认提交：`bash ./fo submit 计划ID`；结果查询：`bash ./fo result 计划ID`。示例里的实例、地区和镜像标识需要替换成自己的值。

## 三种抢卡模式

- **原实例抢开机**：按选中实例原有配置开机。
- **原实例优先，必要时克隆**：先尝试原实例；备用克隆包含系统盘和数据盘，按选择的 GPU、卡数和总内存等条件筛选。八卡原实例配四卡备用，原实例仍按八卡尝试开机。
- **新建实例**：选择地区、GPU 优先级、卡数、镜像、总内存、驱动和扩容等。

内存条件指实例总内存，不是显存。Fo 0.3.5 没有价格上限条件；输入 `yes` 后，任务可能自动开机或创建按量实例并产生费用，请在预览中核对配置及平台价格。

## 完成提醒与离线

提交被接收后会进入通知等待。`accepted` 表示 Fo 已创建任务；只有 Fo 显示“已成功”才发送抢卡成功提醒，表示 GPU 开机成功，不表示训练结束。

- 本地退出、休眠或断网后，服务器继续运行并保存通知。
- 即时桌面提醒需要本地在线并运行 `fo watch`；macOS 使用系统通知，Linux 使用 `notify-send`，WSL 桌面通知需单独配置。
- 重连后 `fo watch` 补收新通知，`fo notifications` 查看最近 500 条保留记录。
- Ctrl+C 退出通知等待或浏览器查看，不会取消服务器任务。取消任务可在自己的 `fo browser` 页面操作。

## 账号与凭据

每个 AutoDL 账号使用独立的 SSH 密钥、登录、浏览器资料、任务和通知。服务器管理员可管理环境；受限成员 SSH 只能调用自己的 Fo RPC 和访问自己的浏览器查看端口。首次成功读取后绑定该 AutoDL 身份；添加其他账号需新的邀请码，之后从本地账号列表切换。

邀请码 24 小时有效，首次兑换绑定本机生成的密钥；同机断网后可用原码继续，其他密钥不能重复兑换。邀请码含临时接入凭证，请私下发送，勿贴到 GitHub。兑换只走现有 SSH，不增加公网端口。邀请接入生成的私钥保存在配置目录的 `keys/` 中；邀请码本身和 AutoDL 密码不写入配置。

高级公钥接入仍可用：`fo keygen` 的专用密钥默认不设口令，保存于 `~/.ssh/fo-autodl`。可用 `--key 路径` 指定已有密钥；有口令的密钥需要先通过 `ssh-add` 解锁。连接配置与账号列表默认存于 `~/.config/autodl-fo-cli`，更新程序时保留。`FO_CLI_HOME` 可自定义配置目录，`FO_CONFIG` 可指定配置文件；历史成员包的本目录 `config.json` 仍兼容。

公开下载包不含个人连接配置、私钥、AutoDL 密码、登录 Token 或浏览器资料。管理员发出的连接文件包含成员 SSH 用户、服务器地址和服务器公钥，不含私钥或 AutoDL 登录凭据。

## 实现与部署范围

当前版本以 [Fo 0.3.5](https://github.com/Fo-OLLL/autodl-card-helper) 为任务后端。新增成员无需安装扩展，由服务器将固定版本脚本载入自己的轻量浏览器页面。**服务器仍为每个成员运行 Chrome，尚未改成纯 HTTP 原生任务引擎。** 小内存服务器多人并发时可能明显变慢。

Fo 原始脚本不随本仓库或客户端 ZIP 分发，管理员需从上游单独取得。管理员部署依赖已有的专用 Fo 浏览器环境，详见 [服务器说明](docs/server.md)；成员无需部署服务器。

网页登录接口变化、登录过期、网络或平台返回异常都可能中断监控，需要查看 `doctor`、任务日志或重新登录。结果不明确时先用 `result` 查询，程序不会自动重复点击提交。

## 开发与验证

```bash
npm test
npm run test:terminal
```

终端回归测试和客户端 ZIP 打包另需 Python 3；成员运行客户端无需 Python。终端测试使用本地模拟连接，验证菜单和 Ctrl+C 的实际交互。

浏览器集成测试另需 Chrome 和从上游取得的原始 Fo 源码：

```bash
FO_TEST_CHROME=/path/to/chrome \
FO_UPSTREAM=/path/to/autodl-helper.user.js \
node --test tests/browser.integration.mjs
```

集成测试使用模拟平台响应，不创建真实付费实例。自动测试不等于保证平台库存、抢卡成功率或任意人数的长期并发容量。

参见 [第三方依赖说明](THIRD_PARTY.md)。
