# Codex 本地操作说明

本工具默认在用户电脑上直接调用 AutoDL HTTP 接口。使用 `bash ./fo ... --json` 获取结构化结果；命令详情以 `bash ./fo --help` 为准。普通使用不配置远程服务器、邀请码或 SSH，也不打开浏览器。`bash ./fo` 仍提供人工菜单。

## 账号与登录

先读取账号和登录状态：

```bash
bash ./fo accounts --json
bash ./fo doctor --json
```

有多个账号时，按用户意图选择完整用户名：

```bash
bash ./fo switch '用户名@主账户ID' --json
```

未登录或返回 `LOGIN_REQUIRED` 时，给用户提供以下命令，让其在自己的本地终端执行，完成后回复 Codex：

```bash
bash ./fo login
# 或预填账号；密码仍在隐藏提示中输入
bash ./fo login --account '用户名@主账户ID'
```

Codex 可以提示账号、实例和路径，**密码由用户本人在隐藏终端提示中输入**。不要让用户把密码发到聊天，也不要把密码或 Token 放在命令参数、环境变量、JSON、临时文件或 Git 中。登录后重新运行 `doctor --json`，再继续原任务。账号不同就独立登录和切换，不复用另一个人的会话。

登录状态只在本机的会话进程内存中。进程自动启动，用当前用户的私有 Unix socket 通信，没有 TCP 服务端口。账号名称会持久保存；密码与登录 Token 不保存。空闲 30 分钟、电脑重启或会话进程退出后需重新登录，平台也可能让会话过期。会话结束也会清除 AutoPanel handle 和确认计划，重新登录后应重新选择实例和生成预览。

平台要求额外验证时，命令会明确报错，不自动打开浏览器；不能把这类失败报告成登录成功。

```bash
bash ./fo logout --json
bash ./fo logout --account '用户名@主账户ID' --json
```

## 读取实例、库存和镜像

```bash
bash ./fo instances --json
bash ./fo regions --json
bash ./fo gpus --json
bash ./fo machines --regions REGION_A,REGION_B --gpu GPU_NAME --idle 1 --json
bash ./fo instance info INSTANCE_UUID --json
bash ./fo instance monitor INSTANCE_UUID --json
bash ./fo instance connection INSTANCE_UUID --json
bash ./fo image list --json
```

`REGION_A`、`GPU_NAME` 和 `INSTANCE_UUID` 都从实际查询结果选择。实例名有歧义时先请用户明确；连接信息默认不返回密码。主账号尚未支持登录，子账号权限仍由 AutoDL 校验。

## 实例和镜像修改

按“预览 → 用户确认 → 执行 → 查询结果”操作。实例支持动作：

| 动作 | 含义 | 参数 |
|---|---|---|
| `powerOn` / `powerOff` / `restart` | 开机 / 关机 / 重启 | 无 |
| `rename` | 改名 | `--name '名称'` |
| `timedShutdown` | 定时关机 | `--shutdown-at 'YYYY-MM-DD HH:mm'`，北京时间 |
| `cancelShutdown` | 取消定时关机 | 无 |
| `saveImage` | 保存系统盘镜像 | `--name '镜像名称'` |
| `release` | 释放实例，永久删除系统盘及数据盘 | 无 |

例如，先生成开机计划：

```bash
bash ./fo instance prepare INSTANCE_UUID powerOn --json
```

展示返回计划的实例、动作、参数、费用和后果，向用户要求最后的 `yes/no`。只有用户回答 `yes` 后，才使用返回的计划编号：

```bash
bash ./fo instance execute PLAN_ID --confirm yes --json
```

`--confirm no` 取消，不发送修改请求。未给确认不会执行。计划属于当前账号、两分钟有效且只使用一次；开机确认时会复查报价和状态。计划过期、报价或状态改变时，重新生成计划并让用户确认。当前开机只支持按量计费且未扩容系统盘的配置。

镜像使用同样的流程：

```bash
bash ./fo image prepare IMAGE_UUID rename --name '新名称' --json
bash ./fo image prepare IMAGE_UUID delete --json
# 仅在用户确认后执行所选计划
bash ./fo image execute PLAN_ID --confirm yes --json
```

用户提出一个修改请求，不等于已经批准最终参数或付费。Codex 不自行填写用户的最终 `yes`。响应中断或返回结果未知时先查询实例/镜像状态，避免重复提交。

## AutoPanel 与文件传输

先为当前账号的运行中实例打开 AutoPanel：

```bash
bash ./fo panel open INSTANCE_UUID --json
```

保存返回的 `handle`。提示用户在本地终端运行：

```bash
bash ./fo panel login HANDLE
```

该命令隐藏输入 **AutoPanel 独立访问密码**，与 AutoDL 登录密码可能不同。登录后可查询：

```bash
bash ./fo panel workdir HANDLE --json
bash ./fo panel local-files HANDLE --path /root/autodl-tmp --json
bash ./fo panel accounts HANDLE --json
bash ./fo panel cloud-files HANDLE --disk-id DISK_ID --path / --source resource --json
bash ./fo panel tasks HANDLE --json
bash ./fo panel history HANDLE --limit 20 --json
```

`DISK_ID` 从 `accounts` 的 `fs_id` 获取，网盘 `FILE_ID` 与文件名从目录查询获取。资源库用 `--source resource`，备份盘用 `--source backup`。浏览子目录时同时传对应 `--path` 与 `--file-id`，保持所选 ID、名称和路径一致。新的网盘授权尚需网页完成，CLI 不发起浏览器流程。

### 上传、下载与确认

上传是 **AutoDL 实例 → 已授权阿里云盘**；`--local-path` 指实例里的绝对路径：

```bash
bash ./fo panel upload HANDLE --disk-id DISK_ID --local-path /root/autodl-tmp/results --directory --source resource --json
```

默认上传到网盘根目录；子目录需同时传 `--remote-directory '/目标目录/'` 与 `--parent-file-id PARENT_ID`。先运行不带 `--confirm` 的命令取得请求预览，返回的 `result.state` 为 `preview`，`result.summary` 包含方向、源、目标、目录标记和字节数。预览会实际读取源和目标，但不提交传输。向用户展示方向、网盘、源/目标、递归范围，获得 `yes/no` 后以相同参数加 `--confirm yes` 提交。回答 no 时使用 `--confirm no`，不会调用传输接口。

下载是 **阿里云盘 → AutoDL 实例默认工作目录**：

```bash
bash ./fo panel download HANDLE --disk-id DISK_ID --file-id FILE_ID --file-name '结果.zip' --source resource --json
```

下载网盘目录时加 `--directory`。`--remote-directory` 与 `--parent-file-id` 是网盘中源文件的父目录，不是本机下载位置；下载位置由 AutoPanel 工作目录决定。子目录 ID、路径和文件名应来自同一次实际浏览。预览和最终确认规则与上传相同。

此版本尚未提供 **电脑本地 ↔ 实例** 直接上传下载。预览和确认时都会检查源文件类型及同名目标；检测到同名文件或目录会返回 `FILE_EXISTS`。遇到同名目标或源文件变化，先重新查询和选择，不自动覆盖。

### 任务结果

用 `panel tasks` 查询队列、`panel history` 查询历史。不要把“已提交”或“队列暂时看不到任务”当成完成。取消任务与清理已成功记录也先预览，获得最终 `yes/no` 后再加 `--confirm yes`：

```bash
bash ./fo panel cancel HANDLE --task-id TASK_ID --json
bash ./fo panel clear HANDLE --json
```

`clear` 仅清理已成功记录，保留文件。用户需要连续跟踪和桌面提醒时，在本地终端运行：

```bash
bash ./fo panel watch HANDLE
```

这是前台交互命令，不加 `--json`，跟踪开始时队列中的任务，显示进度和终端/桌面结果；`Ctrl+C` 停止跟踪，保留已提交的传输。也可运行 `bash ./fo` 进入 AutoPanel 菜单 7。提醒需要本机在线，Linux 需 `notify-send`，WSL 通知需自行配置。

已被 AutoPanel 接受的传输由实例与网盘执行，本机断网不等于取消任务；重新登录后查历史。AutoPanel handle 在当前账号会话内有效，返回 `PANEL_REQUIRED` 时重新 open，返回需要登录的错误时让用户重新执行终端 `panel login`。

## JSON 结果与失败处理

成功和失败均为单个 JSON 对象：

```json
{"ok":true,"result":{}}
```

```json
{"ok":false,"code":"LOGIN_REQUIRED","error":"登录提示"}
```

失败退出码非零。先检查 `ok` 和 `code`，不要只根据终端有输出就判断成功。会话与操作状态以实时结果为准；网络中断后先读取实际状态，再决定后续。

`bash ./fo api OP --data 'JSON' --json` 只用于命令帮助中已有的受限操作，不是任意 URL 请求入口。优先用上面的命名命令；登录一律走隐藏终端输入，不通过 `api` 传密码或 Token。写操作仍需确认。

## 远程历史部署

`bash ./fo remote ...` 显式使用原有 SSH 服务器配置；本地模式不读取它来连接服务器。保留远程模式供已有部署迁移，见 [服务器说明](server.md)。不要将别人的连接配置、密钥或账号加入仓库。本地版本没有抢卡任务引擎，不会恢复旧 Fo 监控任务。
