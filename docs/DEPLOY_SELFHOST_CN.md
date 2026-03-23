# Freemail 自建后端部署指南（Worker + 宝塔 + MySQL + 本地磁盘）

本文对应当前改造版架构：

- **Cloudflare Worker**：继续提供前端静态页面、登录入口、邮件入口（Email Routing）
- **自建后端（Node.js）**：部署在宝塔/云服务器，提供 `/bridge-api` 与 `/bridge-email`
- **MySQL**：替代原 D1
- **本地磁盘目录**：替代原 R2，用于存储完整邮件原文（EML）

## 一、整体架构

```text
浏览器
  -> Cloudflare Worker（静态资源 / 同域前端）
  -> /api/* 被 Worker 代理到自建后端 /bridge-api/*

Cloudflare Email Routing
  -> Worker email() 事件
  -> Worker 把邮件原文 POST 到自建后端 /bridge-email
  -> 后端写入 MySQL + 本地磁盘
```

这样做的好处：

1. 前端访问域名和交互方式基本不变
2. 数据完全在你自己的服务器上
3. Cloudflare 仍适合承担公网邮件入口和边缘静态资源
4. 后端可独立扩展、备份、迁移

## 二、准备条件

### Cloudflare 侧

1. 已接入域名
2. 已启用 Workers
3. 已启用 Email Routing
4. 一个用于前端访问/邮件入口的域名，例如：
   - `mail.example.com`

### 宝塔 / 服务器侧

建议环境：

- Ubuntu / Debian / CentOS 任意
- 宝塔面板（可选，但推荐）
- Node.js 20+
- MySQL 8.0+
- Nginx
- HTTPS 域名，例如：
  - `mail-api.example.com`

## 三、部署自建后端

### 1. 拉取代码

```bash
git clone https://github.com/GrothKeiran/freemail.git
cd freemail
npm install
```

### 2. 创建 MySQL 数据库

示例：

```sql
CREATE DATABASE freemail CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'freemail'@'127.0.0.1' IDENTIFIED BY 'your-strong-password';
GRANT ALL PRIVILEGES ON freemail.* TO 'freemail'@'127.0.0.1';
FLUSH PRIVILEGES;
```

### 3. 准备本地存储目录

```bash
mkdir -p /www/wwwroot/freemail/data/mail-storage
```

### 4. 配置环境变量

复制 `.env.example`：

```bash
cp .env.example .env
```

最关键的是这些：

```env
PORT=8788
STORAGE_ROOT=/www/wwwroot/freemail/data/mail-storage
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=freemail
MYSQL_PASSWORD=your-strong-password
MYSQL_DATABASE=freemail

MAIL_DOMAIN=temp.example.com
ADMIN_NAME=admin
ADMIN_PASSWORD=your-admin-password
JWT_TOKEN=your-jwt-secret
BRIDGE_API_TOKEN=your-random-bridge-token
RESEND_API_KEY=
FORWARD_RULES=
```

### 5. 启动后端

开发测试：

```bash
npm run start:backend
```

健康检查：

```bash
curl http://127.0.0.1:8788/healthz
```

正常应返回：

```json
{"ok":true}
```

### 6. 配置 systemd 守护

```bash
chmod +x backend/scripts/install-service.sh
sudo bash backend/scripts/install-service.sh /www/wwwroot/freemail freemail-backend
```

## 四、宝塔 / Nginx 反向代理

给后端单独配一个站点，例如：`mail-api.example.com`

Nginx 反代到本机 8788：

```nginx
location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Real-IP $remote_addr;
}
```

然后给该站点申请 HTTPS。

## 五、配置 Cloudflare Worker

你需要在 Worker 环境变量中配置：

```env
MAIL_DOMAIN=temp.example.com
BACKEND_BASE_URL=https://mail-api.example.com
BRIDGE_API_TOKEN=与你后端一致
ADMIN_NAME=admin
ADMIN_PASSWORD=your-admin-password
JWT_TOKEN=your-jwt-secret
GUEST_PASSWORD=
SESSION_EXPIRE_DAYS=7
RESEND_API_KEY=
FORWARD_RULES=
```

### 说明

- `BACKEND_BASE_URL`：Worker 转发 API 和邮件写入时访问的后端地址
- `BRIDGE_API_TOKEN`：Worker 与后端之间的共享密钥，必须一致
- `JWT_TOKEN`：前后端要一致，否则登录态无法校验
- `ADMIN_PASSWORD`：前后端要一致

## 六、邮件路由配置

Cloudflare 中为 `MAIL_DOMAIN` 对应域名配置 Email Routing：

1. 打开域名
2. Email Routing
3. 设置 Catch-all 或对应路由
4. 指向当前 Worker

这样任何发到该域名的邮件都会先进入 Worker，再由 Worker 投递到后端。

## 七、前端保持一致的原因

浏览器始终访问 Worker 域名，例如：

- `https://mail.example.com`

前端 JS 仍然请求：

- `/api/login`
- `/api/mailboxes`
- `/api/emails`

只是现在这些请求由 Worker 在服务端转发到：

- `https://mail-api.example.com/bridge-api/...`

所以：

- 页面地址不变
- JS 调用不变
- 用户使用方式基本不变

## 八、升级与备份建议

### MySQL 备份

```bash
mysqldump -u freemail -p freemail > freemail.sql
```

### 邮件原文目录备份

```bash
tar czf freemail-mail-storage.tar.gz /www/wwwroot/freemail/data/mail-storage
```

### 建议一起备份

- `.env`
- MySQL 数据库
- `data/mail-storage/`

## 九、常见问题

### 1. 登录成功但页面接口 401

优先检查：

- Worker 和后端的 `JWT_TOKEN` 是否一致
- `ADMIN_PASSWORD` 是否一致
- Cookie 是否被 HTTPS / 域名策略影响

### 2. 页面能打开但 API 全 500

检查：

- Worker 的 `BACKEND_BASE_URL` 是否正确
- 后端是否能访问
- 后端 `healthz` 是否正常
- `BRIDGE_API_TOKEN` 是否一致

### 3. 邮件收到了但列表里没有

检查：

- Cloudflare Email Routing 是否确实指向该 Worker
- Worker 日志里是否出现后端投递失败
- 后端 MySQL 连接是否正常
- 本地磁盘目录是否可写

### 4. 邮件下载失败

当前实现邮件原文存在服务器本地磁盘，数据库里只记录相对路径。
请确认：

- `STORAGE_ROOT` 正确
- 服务用户对目录有读写权限

## 十、生产建议

1. `BRIDGE_API_TOKEN` 至少 32 位随机字符串
2. 后端域名必须启用 HTTPS
3. Nginx 可加 IP 白名单 / WAF / 速率限制
4. 定期备份 MySQL 与邮件原文目录
5. 如邮件量较大，建议把本地存储目录挂载到独立数据盘
6. 若未来要迁移到对象存储，可在后端层替换 LocalStorageManager，而无需改前端
