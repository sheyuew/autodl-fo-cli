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

登录状态只在本机会话进程内存中。进程自动启动，用当前用户的私有 Unix socket 通信，没有 TCP 服务端口。账号名称、任务策略/进度和通知记录保存在本机，各账号隔离；密码及 Token 不保存。没有活动抢卡任务时空闲 30 分钟退出，活动任务保留后台进程。电脑重启或会话进程退出后需重新登录，平台也可能让会话过期。会话结束会清除 AutoPanel handle 和确认计划，重新登录后应重新选择实例并生成预览。

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
| `expandDataDisk` | 扩容普通实例数据盘 | `--size-gb N`，额外付费部分的目标总 GB |

例如，先生成开机计划：

```bash
bash ./fo instance prepare INSTANCE_UUID powerOn --json
```

展示返回计划的实例、动作、参数、费用和后果，向用户要求最后的 `yes/no`。只有用户回答 `yes` 后，才使用返回的计划编号：

```bash
bash ./fo instance execute PLAN_ID --confirm yes --json
```

`--confirm no` 取消，不发送修改请求。未给确认不会执行。计划属于当前账号、两分钟有效且只使用一次；开机确认时会复查报价和状态。计划过期、报价或状态改变时，重新生成计划并让用户确认。当前范围为普通按量计费容器；已扩容数据盘的实例支持开机，报价包含计算及存储费用。系统盘扩容和 Pro 不在此版本范围。

镜像使用同样的流程：

```bash
bash ./fo image prepare IMAGE_UUID rename --name '新名称' --json
bash ./fo image prepare IMAGE_UUID delete --json
# 仅在用户确认后执行所选计划
bash ./fo image execute PLAN_ID --confirm yes --json
```

用户提出一个修改请求，不等于已经批准最终参数或付费。Codex 不自行填写用户的最终 `yes`。响应中断或返回结果未知时先查询实例/镜像状态，避免重复提交。

## 新建、克隆与数据盘扩容

先查询可选主机，再按机器读取其基础/私有镜像目录和驱动：

```bash
bash ./fo provision catalog --regions REGION_A --gpu GPU_NAME --gpu-count 1 --json
bash ./fo provision catalog --machine-id MACHINE_ID --json
```

主机 ID、镜像 UUID、地区和 GPU 名称均从真实目录取得。使用所选主机对应的 `images`，基础镜像 `imageType:"base"`，私有镜像 `imageType:"private"`；驱动由主机决定。新建示例中所有 ID 都是占位，先换为用户选择的目录值：

```bash
bash ./fo provision prepare create --data '{"machineId":123,"gpuCount":1,"imageUuid":"IMAGE_UUID","imageType":"base","name":"实验实例","dataDiskGB":100}' --json
```

向用户展示返回的 `configuration`、完整 `quote` 与后果，得到最终 `yes/no` 后才调用 `provision execute`。使用返回的 `id`：

```bash
bash ./fo provision execute PLAN_ID --confirm yes --json
```

克隆使用当前账号关机实例，源实例保留；系统盘必拷贝，`copyDataDisk` 默认 false。用户需要拷贝数据盘时明确设 true，并确认目标总容量能容纳源盘：

```bash
bash ./fo provision prepare clone --data '{"machineId":123,"gpuCount":1,"sourceInstanceUuid":"SOURCE_UUID","name":"克隆实例","dataDiskGB":100,"copyDataDisk":false}' --json
```

新建与克隆只支持普通按量计费容器。镜像需通过主机芯片、CPU 架构、CUDA 上限和 GPU 架构最低 CUDA 校验；遇到 `IMAGE_INCOMPATIBLE` 重新选择，不能通过重新提交绕过。`accepted:true`、`state:"submitted"` 仅代表请求接受，继续用返回 `instanceUuid` 查询实例；只有实际运行才能报告租卡完成。

数据盘扩容示例：

```bash
bash ./fo instance prepare INSTANCE_UUID expandDataDisk --size-gb 100 --json
bash ./fo instance execute PLAN_ID --confirm yes --json
```

`dataDiskGB` 与 `--size-gb`（API 中 `sizeGB`）统一表示**额外付费部分的目标总 GB**。免费 50 GB、现有付费 20 GB、目标付费 100 GB 时，总容量为 150 GB，本次新增 80 GB。展示预览中的原值、目标、增量、日费与重启要求后取得 yes/no；执行后查询实际容量，有重启要求时另行预览重启并确认。数据盘费用可在关机后继续计收。此版本不执行系统盘扩容。

## 自动抢卡与结果通知

自动任务是一段有明确边界的付费授权。先按用户意图确定模式、原实例或地区/GPU 数量、镜像或克隆源、数据盘条件、最高总时价、监控时限和次数，得到完整预览后再要求最终 yes/no。先查 `task list`，同一目标已有活动任务时继续查询它，避免重复授权。

新建任务示例，先把地区、GPU 和镜像换成真实目录值：

```bash
bash ./fo task prepare --data '{"mode":"create","regionSigns":["REGION_A"],"gpuNames":["GPU_NAME"],"gpuCount":1,"imageUuid":"IMAGE_UUID","imageType":"base","name":"实验实例","dataDiskGB":100,"maxHourly":3,"maxMinutes":60,"maxAttempts":120,"intervalSeconds":30}' --json
```

`regionSigns` 和 `gpuNames` 可分别填多个真实目录值，分别表示任意地区、任意型号，组合匹配；卡数仍是同一主机上的数量，任务最多获取一个实例。新建/克隆在整个所选范围内寻找，不绑定镜像目录使用的参考主机。主菜单 8 同样支持多选，可输入 `1,3` 或 `all`。

数据盘条件必须二选一：`dataDiskGB` 固定额外付费容量，或 `minDataDiskGB` 最低总容量。最低总容量按各主机免费容量计算最少额外付费 GB，仍受 `maxHourly` 完整费用上限约束；例如免费 100 GB、最低总量 900 GB 时实际付费扩容 800 GB。采用最低总量时省略 `dataDiskGB`：

```bash
bash ./fo task prepare --data '{"mode":"create","regionSigns":["REGION_A","REGION_B"],"gpuNames":["GPU_A","GPU_B"],"gpuCount":1,"imageUuid":"IMAGE_UUID","imageType":"base","minDataDiskGB":900,"maxHourly":5,"maxMinutes":60,"maxAttempts":120,"intervalSeconds":30}' --json
```

展示策略中的磁盘含义，以及当前候选的免费、额外付费、总容量。最低总量模式下，若克隆且复制数据盘，实际容量取用户最低值与完整源盘容量中的较大者，再计算最少付费扩容；固定额外容量模式保持用户指定值。磁盘扩容上限或主机起租卡数不满足时跳过主机；当前全部不满足时保持等待。提交前配置或报价变动时，任务在已确认策略范围内重新匹配和核价。目录查询没有预留库存，不能保证平台最终成功分配。

克隆使用 `mode:"clone"`、`sourceInstanceUuid`，明确 `copyDataDisk`；原实例开机使用 `mode:"powerOn"` 和 `instanceUuid`，目标绑定该实例的现有主机/地区/GPU 与磁盘配置。三种模式都需 `maxHourly`；它包含计算时费和存储日费折算，不只是单卡报价。间隔至少 10 秒，默认 30 秒；默认最多 60 分钟、120 次，实际停止以先达到的限制为准。

展示返回的 `policy`、`budget`、`oneSuccessOnly`、当前候选及报价；无候选时明确当前无卡和未来提交条件。用户确认的是在所列条件和最高总时价内尝试一次成功，不是无上限循环购买。使用返回的 **`planId`** 启动：

```bash
bash ./fo task start PLAN_ID --confirm yes --json
bash ./fo task list --json
bash ./fo task info TASK_ID --json
bash ./fo task watch TASK_ID
bash ./fo notifications --json
bash ./fo notifications --after CURSOR --json
```

`task watch` 是终端前台跟踪，不加 `--json`；机器查询用 `task info`。后台任务可在关闭登录终端、菜单或 watch 后继续，电脑必须保持开机、唤醒和联网。任务结束会尝试本地桌面提醒，通知记录可用 `notifications` 查询，按 `cursor` 增量读取。

状态判断：`waiting/quoting` 是等待与报价，`submitting` 是提交，`verifying` 是核查已接受的请求，**只有 `completed` 且目标实际 running 才报告抢卡成功**。`submitted` 不是运行成功；`uncertain` 时先查返回的实例 UUID 和实例列表，停止自动提交。时限限制监控，不会关闭已租到的实例；任务成功后实例持续计费，用户使用完再按流程关机。

取消先展示目标，再让用户确认：

```bash
bash ./fo task cancel TASK_ID --json
bash ./fo task cancel TASK_ID --confirm yes --json
```

取消会停止本地监控；已经发出的开机/新建请求需继续查询，取消不等于删除或关机。每个任务最多成功一次。电脑或会话进程重启后仅保留任务记录，付费授权不自动恢复：先查询已有实例，确需继续时重新 prepare 并获得新 yes/no；不要自行恢复旧任务或用新任务覆盖结果未知的请求。

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

`bash ./fo remote ...` 显式使用原有 SSH 服务器配置；本地模式不读取它来连接服务器。保留远程模式供已有部署迁移，见 [服务器说明](server.md)。不要将别人的连接配置、密钥或账号加入仓库。本地抢卡任务与旧 Fo 监控任务独立，不会恢复或迁移旧 Fo 任务。
