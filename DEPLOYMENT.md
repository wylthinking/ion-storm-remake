# 二次部署指南

本文覆盖两条完整部署路线：

- Node.js：适合自己的服务器、VPS、NAS 或内网主机，可选 Redis。
- Cloudflare Workers：静态页面、API 和 WebSocket 由 Worker 提供，状态使用 Durable Objects 与 KV。

请先阅读“首次管理员与密钥”一节。全新部署若不设置覆盖值，会创建公开默认账号 `admin/admin`。

## 1. 环境要求

- Node.js 20 或更高版本，推荐当前维护中的 LTS 版本。
- npm 10 或更高版本。
- Node 部署可选 Redis 6+；不使用 Redis 时，联机房间保存在内存中，进程重启后会消失。
- Cloudflare 部署需要一个 Cloudflare 账号和 Wrangler 登录权限。

在 Windows PowerShell 中若 `npm.ps1` 被执行策略阻止，可把下面的 `npm`、`npx` 分别替换为 `npm.cmd`、`npx.cmd`。

## 2. 安装与构建

在项目根目录执行：

```bash
npm ci
npm run build
```

`npm run build` 会依次：

1. 将 `src/shared/advanced-ai-weights.json` 同步为运行时 TypeScript 参数模块；
2. 将 `json/` 中的经典牌库与卡牌片段同步为运行时规则模块；
3. 检查 TypeScript；
4. 构建浏览器资源到 `dist/client`；
5. 构建 Node 服务到 `dist/server`。

不要只复制 `dist/client` 来部署 Node 联机版；联机 API 和 WebSocket 还需要 `dist/server`。

## 3. 首次管理员与随机密钥

### 3.1 默认凭据

空账户存储第一次启动时，默认创建：

```text
用户名：admin
密码：admin
```

`admin/admin` 是公开且不安全的初始化值。生产环境推荐在第一次启动前直接覆盖它，而不是先带着默认密码对外运行。

首次初始化前可设置：

- `BOOTSTRAP_SUPER_ADMIN_USERNAME`：初始超级管理员用户名，1-24 个字符；默认 `admin`。
- `BOOTSTRAP_SUPER_ADMIN_PASSWORD`：初始超级管理员密码；自定义值至少 12 个字符，默认 `admin`。

这两个值仅在账户存储为空时使用。管理员用户名初始化后不可修改，因此要更换账号名，必须在第一次启动前设置。初始化成功后应删除这两个临时变量。

如果已经用默认值初始化：

1. 暂时只让服务监听本机或受信任内网，不要直接暴露到公网；
2. 使用 `admin/admin` 登录；
3. 打开 `/user`，编辑自己的管理员账号；
4. 输入当前密码 `admin`，设置新的强密码并保存；
5. 重新登录确认新密码有效后再开放公网访问。

普通密码修改要求 6-72 个字符；生产环境建议使用密码管理器生成至少 16 个字符的唯一密码。

### 3.2 生成 `AUTH_SECRET`

`AUTH_SECRET` 是每个部署必须独立生成并长期保存的随机字符串，用于保护账户标识和认证数据。密码本身使用带随机盐的 scrypt 哈希保存，代码不会把明文密码写入数据文件。

使用随 Node.js 提供的加密随机数生成器创建 32 字节随机值：

```bash
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

把输出保存到密码管理器或服务器的密钥管理系统，不要写入源码、`wrangler.toml`、`.env`、截图、日志或 Git 提交。项目要求 `AUTH_SECRET` 至少 32 个字符。

重要规则：

- 同一部署每次重启必须继续使用同一个 `AUTH_SECRET`；
- 不同环境（生产、预览、测试）必须使用不同值；
- 丢失该值可能导致已存储用户名无法解密；
- 不要使用示例文字、项目名、域名或管理员密码充当密钥。

## 4. Node.js 部署

### 4.1 首次启动（PowerShell）

```powershell
$env:NODE_ENV = "production"
$env:AUTH_SECRET = "粘贴刚才生成的随机值"
$env:BOOTSTRAP_SUPER_ADMIN_USERNAME = "你的管理员用户名"
$env:BOOTSTRAP_SUPER_ADMIN_PASSWORD = "你的至少12字符强密码"
$env:HOST = "127.0.0.1"
$env:PORT = "3000"
$env:USER_DATA_FILE = "C:\ion-storm-data\users.json"
npm.cmd start
```

确认登录成功后，停止服务并从长期运行配置中删除两个 `BOOTSTRAP_SUPER_ADMIN_*` 变量；保留 `AUTH_SECRET`。

若确实要使用默认 `admin/admin`，省略两个 `BOOTSTRAP_SUPER_ADMIN_*` 变量即可，但必须按 3.1 节立即修改密码。

### 4.2 首次启动（Linux/macOS）

```bash
export NODE_ENV=production
export AUTH_SECRET='粘贴刚才生成的随机值'
export BOOTSTRAP_SUPER_ADMIN_USERNAME='你的管理员用户名'
export BOOTSTRAP_SUPER_ADMIN_PASSWORD='你的至少12字符强密码'
export HOST=127.0.0.1
export PORT=3000
export USER_DATA_FILE=/var/lib/ion-storm/users.json
npm start
```

首次初始化完成并验证登录后，从服务环境中删除两个 `BOOTSTRAP_SUPER_ADMIN_*` 变量。

### 4.3 存储选择

不设置 `REDIS_URL` 时：

- 账户、权限和配置写入 `USER_DATA_FILE`；默认路径为项目下的 `data/users.json`；
- 联机房间只存在于当前进程内存；
- 重启会清空房间并使内存会话失效，但不会删除账户文件。

生产环境应把 `USER_DATA_FILE` 指向项目目录之外的持久化路径，并限制文件权限。不要把运行后生成的 `data/users.json` 提交到仓库。

设置 Redis：

```bash
export REDIS_URL='redis://127.0.0.1:6379'
npm start
```

启用 Redis 后，房间和账户状态写入 Redis。请为 Redis 配置持久化、访问控制和备份；不要把公网未授权 Redis 地址写入仓库。

### 4.4 仅保留生产依赖

构建完成后可移除开发依赖：

```bash
npm prune --omit=dev
NODE_ENV=production npm start
```

升级或重新构建前再次运行 `npm ci` 恢复构建工具。

### 4.5 systemd 示例

将密钥放在仓库外的 `/etc/ion-storm.env`，权限建议为 `600`：

```text
NODE_ENV=production
AUTH_SECRET=替换为随机值
HOST=127.0.0.1
PORT=3000
USER_DATA_FILE=/var/lib/ion-storm/users.json
REDIS_URL=redis://127.0.0.1:6379
```

首次初始化需要自定义管理员时，临时加入两个 `BOOTSTRAP_SUPER_ADMIN_*` 值；初始化后删除它们并重启服务。

`/etc/systemd/system/ion-storm.service` 示例：

```ini
[Unit]
Description=Ion Storm Web Game
After=network.target redis-server.service

[Service]
Type=simple
User=ion-storm
WorkingDirectory=/opt/ion-storm
EnvironmentFile=/etc/ion-storm.env
ExecStart=/usr/bin/node /opt/ion-storm/dist/server/server.js
Restart=on-failure
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

启用服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ion-storm
sudo systemctl status ion-storm
```

### 4.6 Nginx 反向代理

推荐让 Node 只监听 `127.0.0.1`，由带 HTTPS 的反向代理对外提供服务：

```nginx
server {
  listen 443 ssl http2;
  server_name game.example.com;

  # 在此配置自己的 ssl_certificate 与 ssl_certificate_key。

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }

  location /ws {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

客户端在 WebSocket 不可用时会降级到同源 HTTP 轮询，但仍建议正确转发 `/ws`。

## 5. Cloudflare Workers 部署

### 5.1 登录并创建 KV

```bash
npx wrangler login
npx wrangler kv namespace create ION_USERS
npx wrangler kv namespace create ION_ROOMS
npx wrangler kv namespace create ION_SESSIONS
```

把三条命令返回的 namespace ID 分别填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "ION_USERS"
id = "你的 ION_USERS ID"

[[kv_namespaces]]
binding = "ION_ROOMS"
id = "你的 ION_ROOMS ID"

[[kv_namespaces]]
binding = "ION_SESSIONS"
id = "你的 ION_SESSIONS ID"
```

仓库中的 `REPLACE_WITH_...` 只是公开占位符，部署前必须全部替换。不要复制其他部署者的 namespace ID。

用途：

- `ION_USERS`：旧数据迁移来源和胜利音效内容；
- `ION_ROOMS`：旧房间迁移来源；
- `ION_SESSIONS`：登录会话；
- `ION_ACCOUNT_STATE` Durable Object：权威账户、权限和管理状态；
- `ION_ROOM_STATE` Durable Object：每个房间的串行权威状态。

Durable Object 绑定和迁移已经写在 `wrangler.toml` 中，首次部署会创建对应类。

### 5.2 写入密钥与初始管理员

```bash
npx wrangler secret put AUTH_SECRET
npx wrangler secret put BOOTSTRAP_SUPER_ADMIN_USERNAME
npx wrangler secret put BOOTSTRAP_SUPER_ADMIN_PASSWORD
```

第一条粘贴 3.2 节生成的随机值；后两条分别输入自定义管理员用户名和至少 12 个字符的强密码。如果省略后两条，首次空存储会使用 `admin/admin`。

### 5.3 构建并部署

```bash
npm run worker:build
npm run worker:deploy
```

访问 Wrangler 输出的地址，完成登录检查。确认管理员已经初始化后删除临时 bootstrap 值：

```bash
npx wrangler secret delete BOOTSTRAP_SUPER_ADMIN_USERNAME
npx wrangler secret delete BOOTSTRAP_SUPER_ADMIN_PASSWORD
```

不要删除 `AUTH_SECRET`，也不要删除正在使用的 KV 或 Durable Object 数据。自定义域名可在 Cloudflare 控制台中绑定到该 Worker。

## 6. `AUTH_SECRET` 轮换

轮换不能直接用新值覆盖后重启，否则旧用户名可能无法解密。正确顺序：

1. 保留当前值，生成一个新的随机值；
2. 把旧值临时设置为 `AUTH_SECRET_PREVIOUS`；
3. 把新值设置为 `AUTH_SECRET`；
4. 重启 Node 或重新部署 Worker；
5. 访问账户接口并确认管理员和普通用户均能登录，确保迁移已写回；
6. 删除 `AUTH_SECRET_PREVIOUS`，再次重启或部署；
7. 在密钥管理器中安全归档或销毁旧值。

Node 使用环境变量；Cloudflare 使用：

```bash
npx wrangler secret put AUTH_SECRET_PREVIOUS
npx wrangler secret put AUTH_SECRET
npm run worker:deploy
# 确认迁移成功后
npx wrangler secret delete AUTH_SECRET_PREVIOUS
```

## 7. 部署后检查

至少完成以下检查再开放访问：

1. 首页返回正常页面，浏览器控制台没有启动错误；
2. 默认 `admin/admin` 已被替换，或从未在生产环境启用；
3. 退出并重新登录成功；
4. 能创建房间，另一登录账号能加入，并能通过 WebSocket 同步；
5. 自定义模式可加载经典 JSON 预设；
6. 高级 AI 入口能正常加载，构建日志出现“已同步高级 AI 参数”；
7. Node 的数据文件或 Redis、Cloudflare 的 KV/DO 都有备份策略；
8. HTTPS 已启用，Node/Redis 管理端口未直接暴露；
9. 公开仓库中不存在 `.env`、`.dev.vars`、`data/users.json`、真实 KV ID、日志、截图或构建产物。

可用以下命令做发布前文本检查：

```bash
git status --short
git ls-files | grep -E '(^|/)(data/users\.json|\.env|\.dev\.vars)|(^|/)(dist|node_modules|artifacts|output)/'
```

Windows PowerShell 可直接检查：

```powershell
git status --short
git ls-files | Select-String 'data/users\.json|\.env|\.dev\.vars|dist/|node_modules/|artifacts/|output/'
```

## 8. 升级、备份与历史清理

升级前：

- 备份 Node 的 `USER_DATA_FILE` 或 Redis；
- 备份 Cloudflare KV/DO 中的业务数据；
- 保存当前 `AUTH_SECRET`，不要随版本更新生成新值；
- 执行 `npm ci && npm run build` 后再原子切换并重启。

仅从当前目录删除敏感文件不会清除既有 Git 历史。如果旧仓库、云盘、Release、CI 日志或镜像层曾包含真实密码哈希、密钥、KV ID、邀请码、个人账号或用户数据，还需要：

1. 轮换对应密钥、管理员密码、邀请码和激活码；
2. 用 Git 历史清理工具删除旧对象并强制更新远端；
3. 清理 Release、构建缓存、容器镜像和 CI 日志；
4. 通知已有协作者重新克隆清理后的仓库。
