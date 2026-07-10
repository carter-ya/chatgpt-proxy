# ChatGPT Proxy

## 本地启动

项目由三部分组成：

- Go 后端：提供本应用的登录、注册、代理 API 和数据库迁移。
- React 前端：聊天界面。
- Playwright sidecar：打开本机 Chrome，并使用已登录的 `chatgpt.com` 浏览器态请求上游。

### 1. 准备环境变量

复制 `.env.example` 为 `.env`，至少配置：

```env
XIAOMING_DATABASE_URL=postgres://chatgpt_proxy:dev_secret@localhost:5432/chatgpt_proxy?sslmode=disable
XIAOMING_ENCRYPTION_KEY=<32-byte-base64-key>
XIAOMING_JWT_SECRET=<random-secret>
XIAOMING_JWT_EXPIRATION=24h
XIAOMING_SIDECAR_URL=http://127.0.0.1:3100
XIAOMING_CHROME_LAUNCH_MODE=cdp
XIAOMING_CHROME_CDP_PORT=9222
```

如果本机 `5432` 已被占用，可设置 `XIAOMING_POSTGRES_PORT=5433`，并把
`XIAOMING_DATABASE_URL` 中的端口同步改为 `5433`。

生成 32 字节 base64 加密密钥：

```sh
openssl rand -base64 32
```

`XIAOMING_SESSION_TOKENS` 是已废弃的旧 token-pool 配置；当前默认链路只使用 sidecar Chrome 登录态，不读取本地 token 池。

项目的 `/images` 页面对应 ChatGPT 独立 Images 工作区，使用 `picture_v2` 图片模式和异步状态轮询，不等同于普通聊天中输入“生成图片”。

### 2. 启动服务

启动数据库：

```sh
docker compose up -d postgres
```

启动 sidecar：

```sh
cd sidecar
npm run dev
```

sidecar 默认以 CDP 模式启动本机 Chrome Stable：先用最少参数打开 Chrome 检查登录态，再通过 `127.0.0.1:9222` 连接该窗口。这个模式比 Playwright `launchPersistentContext` 更接近日常手动打开 Chrome 的状态。

首次验证某个 profile，或登录态失效时，sidecar 会自动切换到 plain 登录流程：

1. 关闭已连接的 CDP Chrome。
2. 打开一个不带 `--remote-debugging-port`、不带 DevTools 连接的普通 Chrome。
3. 你在这个普通 Chrome 中完成 `chatgpt.com` 登录。
4. 登录完成后退出这个 Chrome，sidecar 会重新用 CDP 接管同一 profile。

这个流程用于避免登录页在 debugger-attached Chrome 中反复触发 Cloudflare challenge。sidecar 会复用 `.browser-profile` 保存的登录态。若确实需要旧行为，可设置 `XIAOMING_CHROME_LOGIN_MODE=attached`。

如果本机 Chrome 安装位置特殊，可设置 `XIAOMING_CHROME_EXECUTABLE_PATH` 为完整路径。若需要回退旧模式，可设置 `XIAOMING_CHROME_LAUNCH_MODE=persistent`，并继续使用 `XIAOMING_CHROME_CHANNEL=chrome`。

如果 Chrome 页面出现 Cloudflare challenge，请在当前可见 Chrome 窗口内手动完成；sidecar 不会自动刷新 challenge 页面，避免打断验证流程。

如果登录页 `auth.openai.com` 的 Cloudflare checkbox 反复出现，优先用日常 Chrome profile：

1. 退出所有普通 Chrome 窗口。
2. 在 `.env` 设置：

```env
XIAOMING_CHROME_USER_DATA_DIR=/Users/<you>/Library/Application Support/Google/Chrome
XIAOMING_CHROME_PROFILE_DIRECTORY=Default
```

3. 重新启动 sidecar。

这会让 sidecar 使用你平时 Chrome 的本地 profile 信任状态。不要同时打开普通 Chrome 和 sidecar 使用同一个 profile，否则 Chrome 会因为 profile 锁冲突或状态竞争而异常。

若你的普通 Chrome 可以登录，但 sidecar Chrome 在 `brunhild.challenges.cloudflare.com` 上显示 `net::ERR_CONNECTION_CLOSED` 或反复 challenge，优先检查两者的代理/profile 是否一致。sidecar 默认使用独立 profile，不会自动继承普通 Chrome profile 里的代理扩展、登录信任状态或站点数据。

如果普通 Chrome 依赖本地代理，可在 `.env` 显式指定：

```env
XIAOMING_CHROME_PROXY_SERVER=socks5://127.0.0.1:7890
XIAOMING_CHROME_PROXY_BYPASS_LIST=<-loopback>
```

如果确实需要临时诊断 DNS/IPv6 问题，可手动设置 `XIAOMING_CHROME_HOST_RESOLVER_RULES`，但它会让 Chrome 显示“不受支持的命令行标记”警告，默认不启用。

启动后端：

```sh
go run ./backend/cmd/server
```

启动前端：

```sh
cd frontend
npm run dev
```

访问 Vite 输出的本地地址，注册或登录本应用账号后即可使用。

## Neon 数据库免费套餐限制

本项目使用 Neon PostgreSQL 云服务。免费套餐包含以下限制：

- **计算配额**: 100 CU-hours/月
- **存储空间**: 0.5 GB/项目
- **实例规格**: 最高 2 CU（8 GB RAM）

> 来源: https://neon.tech/pricing
