#!/usr/bin/env bash
set -euo pipefail

APP_DIR=${1:-/www/wwwroot/freemail}
SERVICE_NAME=${2:-freemail-backend}

cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=Freemail Self-hosted Backend
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node ${APP_DIR}/backend/src/server.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}
systemctl restart ${SERVICE_NAME}
systemctl status ${SERVICE_NAME} --no-pager
