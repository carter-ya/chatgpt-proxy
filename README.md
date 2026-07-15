# ChatGPT Proxy

基于 Go、React、PostgreSQL 和 Playwright Chrome Sidecar 构建的自托管 ChatGPT 代理。项目复用已登录的 `chatgpt.com` 浏览器会话，为本地用户提供流式聊天、图片创作、文件上传和会话管理能力。

> [!IMPORTANT]
> 本项目依赖 ChatGPT 网页端的非公开接口，仅适合个人开发、研究和受控环境使用。上游接口变化可能导致功能失效，请勿将其视为 OpenAI 官方 API 的替代品。

## 功能特性

- 本地用户注册、登录和 JWT 鉴权
- 按用户隔离会话、上传文件和生成图片
- ChatGPT 流式回复、思考进度、思考摘要和搜索来源
- 动态读取当前 ChatGPT 账号可用的模型与思考档位
- 多文件点击、拖放和粘贴流式上传，单文件上限 50 MB
- 文件与 Sandbox 产物通过浏览器原生流式下载，支持 Range 断点续传
- 独立 Images 工作区，支持图片生成、候选选择和引用编辑
- 会话历史、快速标题、归档、恢复和永久删除
- Markdown、表格、代码高亮、代码复制和搜索图片组渲染
- 桌面端和移动端响应式界面

## 架构概览

```mermaid
flowchart LR
    Browser[React Web UI] -->|JWT / SSE| Backend[Go API]
    Backend --> PostgreSQL[(PostgreSQL)]
    Backend -->|HTTP Proxy| Sidecar[Playwright Sidecar]
    Sidecar -->|Chrome CDP + 登录态| ChatGPT[chatgpt.com]
```

- `frontend/`：React + Vite 单页应用。
- `backend/`：Gin API、认证、资源归属校验、数据库迁移和上游响应规范化。
- `sidecar/`：通过 Playwright/CDP 控制本机 Chrome，并以浏览器登录态访问 ChatGPT。
- PostgreSQL：保存本地用户、会话归属、文件归属和归档状态；消息正文仍由 ChatGPT 上游保存。

## 前置要求

- Go 1.25+
- Node.js 18+ 和 npm
- Google Chrome Stable
- Docker 和 Docker Compose（用于本地 PostgreSQL）
- 一个可正常登录 `chatgpt.com` 的账号

## Quick Start

### 1. 准备配置

在项目根目录复制配置模板：

```sh
cp .env.example .env
```

编辑 `.env`，至少设置：

```env
CHATGPT_PROXY_DATABASE_URL=postgres://chatgpt_proxy:dev_secret@localhost:5432/chatgpt_proxy?sslmode=disable
CHATGPT_PROXY_ENCRYPTION_KEY=<32-byte-base64-key>
CHATGPT_PROXY_JWT_SECRET=<random-secret>
CHATGPT_PROXY_JWT_EXPIRATION=24h
CHATGPT_PROXY_SIDECAR_URL=http://127.0.0.1:3100
CHATGPT_PROXY_CHROME_LAUNCH_MODE=cdp
CHATGPT_PROXY_CHROME_CDP_PORT=9222
```

生成加密密钥：

```sh
openssl rand -base64 32
```

如果本机 `5432` 已被占用，请同时修改 `CHATGPT_PROXY_POSTGRES_PORT` 和 `CHATGPT_PROXY_DATABASE_URL` 中的端口。

### 2. 启动 PostgreSQL

```sh
docker compose up -d postgres
```

### 3. 安装依赖

```sh
cd sidecar && npm ci
cd ../frontend && npm ci
cd ..
```

Go 依赖会在首次构建或运行时自动下载，也可以提前执行：

```sh
go mod download
```

### 4. 启动服务

分别在三个终端运行：

```sh
# Terminal 1: Sidecar
cd sidecar
npm run dev
```

```sh
# Terminal 2: Backend
go run ./backend/cmd/server
```

```sh
# Terminal 3: Frontend
cd frontend
npm run dev
```

打开 Vite 输出的本地地址（通常为 `http://127.0.0.1:5173`），注册本地账号后即可使用。后端健康检查默认为 `http://127.0.0.1:8080/api/health`。

### 数据库迁移

后端启动时会自动执行待应用的迁移，也可以手动执行：

```sh
make migrate-up
```

回退到指定版本（保留该版本，回退比它新的迁移）：

```sh
make migrate-down VERSION=007
```

回退所有迁移是破坏性操作，必须显式指定：

```sh
make migrate-down ALL=true
```

## 环境变量

完整配置及注释见 [.env.example](.env.example)。常用变量如下：

| 变量 | 必需 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `CHATGPT_PROXY_DATABASE_URL` | 是 | 无 | PostgreSQL 连接字符串 |
| `CHATGPT_PROXY_ENCRYPTION_KEY` | 是 | 无 | 32 字节 Base64 加密密钥 |
| `CHATGPT_PROXY_JWT_SECRET` | 是 | 无 | 本地 JWT 签名密钥 |
| `CHATGPT_PROXY_JWT_EXPIRATION` | 否 | `24h` | JWT 有效期 |
| `CHATGPT_PROXY_SERVER_PORT` | 否 | `8080` | 后端监听端口 |
| `CHATGPT_PROXY_SIDECAR_URL` | 否 | `http://127.0.0.1:3100` | Sidecar 地址 |
| `CHATGPT_PROXY_CHROME_LAUNCH_MODE` | 否 | `cdp` | Chrome 启动方式：`cdp` 或 `persistent` |
| `CHATGPT_PROXY_CHROME_LOGIN_MODE` | 否 | `plain` | 首次登录方式：`plain` 或 `attached` |
| `CHATGPT_PROXY_CHROME_USER_DATA_DIR` | 否 | `sidecar/.browser-profile` | Chrome 用户数据目录 |
| `CHATGPT_PROXY_CHROME_PROFILE_DIRECTORY` | 否 | `Default` | Chrome profile 名称 |
| `CHATGPT_PROXY_CHROME_PROXY_SERVER` | 否 | 无 | Chrome 显式代理地址 |
| `CHATGPT_PROXY_FINAL_RESPONSE_TIMEOUT_MS` | 否 | `900000` | 长任务最终结果轮询时间（毫秒） |

## 使用说明

### 普通聊天

聊天输入框会从 Sidecar 当前登录账号动态读取模型和思考档位。选中的模型会按本地用户保存，并在聊天页、图片页和页面刷新后复用；若该选项已下线，会自动回退到新模型列表的默认模型。回复支持流式文本、Markdown、代码块、搜索来源和图片组。新会话会在创建后立即出现在侧栏，稍后自动替换为 ChatGPT 生成的正式标题。

### Images 工作区

`/images` 对应 ChatGPT 独立 Images 工作区，使用 `picture_v2` 图片模式和异步状态轮询。每轮生成结果都会保留在时间线中；候选选择和“以此图编辑”是两个独立操作。

### 多用户资源隔离

所有本地用户共享一个 Sidecar ChatGPT 账号，但后端会按 JWT 中的 `user_id` 隔离会话和文件。新会话在 SSE 返回 `conversation_id` 时绑定当前用户；未知的上游资源不会自动认领，归属检查失败时请求会被拒绝。

### 文件传输

上传文件会从 multipart 请求直接流向上游签名存储，后端保留 50 MB 限制、MIME 判断和图片宽高检测，但不会完整载入内存。下载时，前端先使用 JWT 申请一个与用户和资源绑定、10 分钟有效的加密票据，再交由浏览器原生下载。文件内容会从 Chrome Sidecar 经 Go 后端逐块转发，不会完整载入 Sidecar、后端或前端内存；`Range` 和 `If-Range` 请求头以及对应的响应头会沿链路透传。

## 测试与构建

后端：

```sh
go test ./...
go vet ./...
# 或
make test
make vet
```

Sidecar：

```sh
cd sidecar
npm test
npm run build
```

前端：

```sh
cd frontend
npm run lint
npm run build
npm run test:e2e
```

稳定验收或反向代理场景可以使用生产构建预览：

```sh
cd frontend
npm run build
npm run preview -- --host 127.0.0.1 --port 4173
```

## Chrome 与 Cloudflare 排障

### 首次登录

Sidecar 默认以 CDP 模式启动 Chrome。首次验证 profile 或登录态失效时，会打开一个不带 DevTools 连接的普通 Chrome：

1. 在该窗口完成 `chatgpt.com` 登录。
2. 登录完成后退出这个 Chrome。
3. Sidecar 会重新以 CDP 模式接管同一 profile。

如果 Chrome 安装位置特殊，请设置 `CHATGPT_PROXY_CHROME_EXECUTABLE_PATH`。需要回退旧模式时，可以设置 `CHATGPT_PROXY_CHROME_LAUNCH_MODE=persistent`。

### Cloudflare challenge

如果 Chrome 出现 Cloudflare challenge，请在可见窗口中手动完成。Sidecar 会巡检 CDP 连接；Chrome 或代理页意外关闭后会自动重连，必要时重新拉起 Chrome。登录态失效时仍需在打开的窗口中手动完成登录或验证。

如果验证反复出现，可以在完全退出普通 Chrome 后复用日常 profile：

```env
CHATGPT_PROXY_CHROME_USER_DATA_DIR=/Users/<you>/Library/Application Support/Google/Chrome
CHATGPT_PROXY_CHROME_PROFILE_DIRECTORY=Default
```

不要让普通 Chrome 和 Sidecar 同时使用同一 profile，否则会发生 profile 锁冲突。

如果日常 Chrome 依赖本地代理，请显式配置：

```env
CHATGPT_PROXY_CHROME_PROXY_SERVER=socks5://127.0.0.1:7890
CHATGPT_PROXY_CHROME_PROXY_BYPASS_LIST=<-loopback>
```

仅在诊断 DNS/IPv6 问题时使用 `CHATGPT_PROXY_CHROME_HOST_RESOLVER_RULES`；启用后 Chrome 会显示“不受支持的命令行标记”警告。

## 可选：使用 Neon

本地开发默认使用 Docker PostgreSQL，也可以将 `CHATGPT_PROXY_DATABASE_URL` 指向 Neon 或其他兼容 PostgreSQL 服务。Neon 配置通常需要 `sslmode=require`；套餐限制和价格请以 [Neon 官方定价](https://neon.com/pricing) 为准。

## 安全注意事项

- `.env` 包含数据库凭据和密钥，必须保持在 Git 忽略列表中，建议文件权限设为 `0600`。
- `sidecar/.browser-profile` 包含 ChatGPT Cookie 和登录态，不要提交、复制到不可信设备或打包进镜像。
- 不要在多个用户之间共享本地 JWT secret 或数据库。
- Sidecar 上游账号是共享资源；本地资源隔离不能替代独立的上游 ChatGPT 账号隔离。
- 如需公网部署，请在前端增加可信反向代理、TLS、访问控制和速率限制。

## 部署说明

当前 `Dockerfile` 只构建 Go 后端，`docker-compose.yml` 主要用于本地 PostgreSQL 和后端开发。前端静态资源、Sidecar Chrome、TLS 和反向代理需要根据目标环境单独部署。

## License

本项目采用 [Apache License 2.0](LICENSE) 开源。你可以自由使用、修改、分发和商用本项目代码，但需要遵守许可证中的署名、变更说明和再分发要求。

该许可证仅适用于本仓库代码，不授予任何 OpenAI/ChatGPT 商标、账号、内容或网页端接口的使用权。
