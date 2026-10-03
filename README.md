# MCRL Red Runtime

只运行已训练好的 Minecraft 空手 PvP 模型，支持玩家挑战和两个机器人自动对战。
本仓库不包含训练器、奖励函数、优化器、经验回放或训练数据。

## 环境与安装

- macOS 或 Linux，Python 3.12、Node.js 22+、Java 21，以及 `lsof`、`unzip`。
- Minecraft Java 客户端使用 **1.20.4**。
- 权重来自公开的 [lingiyiyi/mcrl-red-dqn](https://huggingface.co/lingiyiyi/mcrl-red-dqn)。

```sh
npm ci --no-audit --no-fund
python3.12 -m venv .venv
.venv/bin/pip install --no-cache-dir -r requirements.txt
npm run download:model
MCRL_ACCEPT_EULA=true npm run setup:server
```

服务端安装程序从 Mojang 下载原版 1.20.4 并校验 SHA1，配置一个本地超平坦竞技场。
运行安装程序前请阅读并同意 [Minecraft EULA](https://www.minecraft.net/eula)；
安装程序会写入 `eula=true`。服务端文件和世界不会上传到仓库。

## 与 RedDQN 对战

```sh
npm run play -- --player YourMinecraftName
```

然后用对应名字加入 `127.0.0.1:25565`。清空自己的背包，走近并打一下
`RedDQN` 请求开局；三秒倒计时后双方满血空手开打。死亡结束本局，准备好后
再打一下可重开。程序不会删除玩家背包中的物品，也不会更新模型权重。

网页旁观是可选项：

```sh
npm run play -- --player YourMinecraftName --viewer
```

打开 <http://127.0.0.1:3007>。网页显示真实服务端实体与血量。

## 两个机器人自动对战

```sh
npm start -- --rounds 100
# 如需网页观战：
npm start -- --rounds 100 --viewer
```

一方死亡即停止双方动作，随后共同重置为满血空手。最长一局 45 秒。
不要同时启动两个运行实例。`Ctrl+C` 或另一个终端中的 `npm stop` 会停止本项目进程。
遇到端口占用时程序会退出，不会接管或终止其他服务器。

## 内存与模型

- 推理用 NumPy float32，不依赖 PyTorch、CUDA 或 MPS，也不分配训练缓存。
  模型来自 MPS 训练，导出的权重精度保持不变；NumPy 输出经过原版网络校验。
- Apple Silicon 本机加载两个网络并执行 10,000 次双机器人推理的测试，峰值 RSS
  为 36.7 MiB，平均每步约 0.034 ms；这仅是推理进程，不包括 Java 和 Mineflayer。
- Red 战术网络 20,750 个参数，瞄准网络 17,799 个参数；两个权重文件合计 155,180 字节。
- 默认不开网页渲染器、录像器或额外 Camera 机器人；加 `--viewer` 才开启观战。
- Java 初始堆 128 MB，上限 512 MB。堆上限不等于整个 Java 进程占用。
  如需增加容量，可用 `MCRL_MEMORY_MB=768 npm run play -- --player YourMinecraftName`。
- 两个网络都为固定的 `Linear-ReLU-Linear-ReLU-Linear`。战术动作按 Q 值以温度
  0.10 采样，瞄准动作取最大 Q 值；没有在线学习或手写追击控制器。

模型下载固定到 `model-source.json` 中的 HF 提交，并检查每个文件的 SHA256。
网络只在初次下载时需要访问 HF；文件完整后可离线运行。

## 验证

```sh
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
```

原始冻结策略的隔离实战结果：对旧版 8 胜 2 负，平均净伤害 +5.0；
新版镜像对战 10/10 局以死亡结束。此结果来自平地空手机器人对战，
不是对人类玩家水平的排名。完整训练流程保留在作者本地，不随本运行仓库发布。

所有游戏和控制接口只监听本机；离线模式仅用于这个本地竞技场。
本项目与 Mojang / Microsoft 无隶属关系。
