# 离子风暴网页游戏

一个使用 TypeScript 实现的多人化学卡牌游戏，支持本地对局、账号与房间联机、机器人、服务器权威裁定、自定义规则，以及 Node.js 和 Cloudflare Workers 两种部署方式。

## 主要能力

- 浏览器端本地游戏与响应式移动端界面。
- Node.js + WebSocket 联机服务；可选 Redis 持久化房间和账户状态。
- Cloudflare Workers + Durable Objects + KV 的无服务器部署。
- 经典规则、自定义 JSON 规则编辑器和自定义卡牌音频。
- 本地机器人、服务端机器人和高级 AI 建议；部署使用的高级 AI 参数保存在 `src/shared/advanced-ai-weights.json`。
- 邀请码、激活码、用户权限、排行榜、工单、胜利音效和对局 CSV 日志。

## 开始部署

完整步骤、安全配置、初始管理员修改、随机密钥生成、Node/Redis、Cloudflare Workers 和反向代理配置均在 [DEPLOYMENT.md](./DEPLOYMENT.md) 中。

全新空存储的默认超级管理员为：

```text
用户名：admin
密码：admin
```

这是仅用于首次初始化的公开默认值。请在服务对外开放前按照部署文档改成自定义管理员账号和强密码。

## 最小开发命令

```bash
npm ci
npm run dev
```

生产构建：

```bash
npm run build
```

自定义规则格式见 [json/CUSTOM_GAME_JSON_SPEC.md](./json/CUSTOM_GAME_JSON_SPEC.md)。

## 源码结构

```text
src/client/     浏览器界面与 Web Worker
src/server/     Node.js HTTP/WebSocket 服务和账户存储
src/shared/     浏览器、Node 和 Cloudflare 共用的游戏逻辑
worker/         Cloudflare Worker 与 Durable Objects
json/           构建时使用的经典牌库、模板和规则规范
scripts/        构建前同步规则与高级 AI 参数的脚本
```

运行期间生成的账户数据、构建目录、依赖目录和本地工具状态均已加入 `.gitignore`，不应提交到公开仓库。
