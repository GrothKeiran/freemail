# Freemail - 临时邮箱服务（Worker + 自建后端版）

这是基于原 `idinging/freemail` 改造的自部署版本。

## 这次改造的核心目标

- **保留 Cloudflare Worker**：继续负责前端静态资源、邮件入口、边缘访问
- **移除对 D1 / R2 的强依赖**：改为 **MySQL + 本地磁盘（可配置存储目录）**
- **优先采用桥接架构**：Worker 通过 HTTP 调用你的自建后端
- **尽量保持前端使用体验一致**：浏览器仍走 Worker 域名，前端接口路径仍是 `/api/*`

## 新架构

```text
Browser
  -> Cloudflare Worker (静态资源 + 同域入口)
  -> Worker 把 /api/* 代理到自建后端

Cloudflare Email Routing
  -> Worker email() 事件
  -> Worker 把邮件原文 POST 到自建后端

Self-hosted Backend (Node.js)
  -> MySQL 持久化
  -> 本地磁盘保存 EML
```

## 仓库重点

### 1) Worker 端

- `src/server.js`
  - `/api/*` → 转发到 `BACKEND_BASE_URL/bridge-api/*`
  - `email()` → 把邮件解析后 POST 到 `BACKEND_BASE_URL/bridge-email`
  - 静态资源仍由 Worker 提供

### 2) 自建后端

新增：

- `backend/src/server.js`
- `backend/src/mysqlAdapter.js`
- `backend/src/localStorage.js`
- `backend/src/bridgeClient.js`

后端复用了原项目大部分业务逻辑：

- `src/routes/*`
- `src/api/*`
- `src/assets/*`
- `src/email/parser.js`
- `src/db/*`

只是把底层存储替换为：

- MySQL 适配器
- 本地文件存储

## 快速开始

### 本地安装

```bash
npm install
```

### 环境变量

```bash
cp .env.example .env
```

至少填写：

```env
BACKEND_BASE_URL=https://mail-api.example.com
BRIDGE_API_TOKEN=change-me
MAIL_DOMAIN=temp.example.com
ADMIN_NAME=admin
ADMIN_PASSWORD=change-me
JWT_TOKEN=change-me

PORT=8788
STORAGE_ROOT=/www/wwwroot/freemail/data/mail-storage
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=freemail
MYSQL_PASSWORD=change-me
MYSQL_DATABASE=freemail
```

### 启动自建后端

```bash
npm run start:backend
```

### 静态检查

```bash
npm run check
```

## 部署文档

详见：

- [`docs/DEPLOY_SELFHOST_CN.md`](docs/DEPLOY_SELFHOST_CN.md)

内容包含：

- Cloudflare Worker 配置
- 宝塔 / Nginx 反代
- MySQL 初始化
- 本地磁盘存储目录
- 环境变量说明
- systemd 方式部署 Node 后端
- 常见问题

## 与原版的主要差异

| 项目 | 原版 | 本改造版 |
|---|---|---|
| 数据库 | Cloudflare D1 | MySQL |
| 邮件原文存储 | Cloudflare R2 | 本地磁盘 / 可配置目录 |
| 前端 | Worker 静态资源 | Worker 静态资源 |
| API 执行位置 | Worker 内直接执行 | Worker 转发到自建后端 |
| 邮件入口 | Worker email() | Worker email() + 后端桥接 |

## 兼容性说明

本次改造优先保证：

- 登录流程不明显改变
- 前端页面路由不明显改变
- `/api/*` 使用方式不明显改变

也就是说：

- 用户访问方式基本一致
- 前端页面和交互感知尽量不变
- 主要变化集中在后端部署方式

## 已知限制 / 后续建议

1. 当前桥接链路依赖 Worker 能访问你的后端 HTTPS 地址
2. 如果后端不可达，页面 API 和邮件写入都会失败
3. 当前下载邮件原文依赖本地磁盘路径存在，建议生产环境做好备份
4. 若未来邮件量很大，建议把本地磁盘层抽象成 S3 兼容对象存储
5. 某些原始 D1 SQL 虽已兼容到 MySQL，但大规模生产前仍建议做一次更完整回归测试

## 许可证

Apache-2.0
