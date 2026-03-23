/**
 * Freemail Cloudflare Worker 入口
 *
 * 新架构：
 * 1. Worker 继续负责静态资源、登录域名暴露、邮件入口
 * 2. 所有 /api 请求桥接到用户自建后端 HTTP API
 * 3. 邮件事件解析后投递到后端，由 MySQL + 本地磁盘持久化
 */

import { createAssetManager } from './assets/index.js';
import { extractEmail } from './utils/common.js';
import { parseEmailBody } from './email/parser.js';

async function proxyApiRequest(request, env) {
  const base = String(env.BACKEND_BASE_URL || '').replace(/\/$/, '');
  if (!base) return new Response('BACKEND_BASE_URL 未配置', { status: 500 });

  const url = new URL(request.url);
  const target = `${base}/bridge-api${url.pathname}${url.search}`;
  const headers = new Headers(request.headers);
  headers.set('x-freemail-bridge-token', env.BRIDGE_API_TOKEN || '');
  headers.delete('host');

  const init = {
    method: request.method,
    headers,
    redirect: 'manual'
  };
  if (!['GET', 'HEAD'].includes(request.method.toUpperCase())) {
    init.body = await request.arrayBuffer();
  }
  return fetch(target, init);
}

async function forwardInboundEmail(message, env, ctx) {
  const base = String(env.BACKEND_BASE_URL || '').replace(/\/$/, '');
  if (!base) {
    console.error('BACKEND_BASE_URL 未配置，无法投递邮件到后端');
    return;
  }

  const headers = message.headers;
  const toHeader = headers.get('to') || headers.get('To') || '';
  const fromHeader = headers.get('from') || headers.get('From') || '';
  const subject = headers.get('subject') || headers.get('Subject') || '(无主题)';

  let envelopeTo = '';
  try {
    const toValue = message.to;
    if (Array.isArray(toValue) && toValue.length > 0) {
      envelopeTo = typeof toValue[0] === 'string' ? toValue[0] : (toValue[0].address || '');
    } else if (typeof toValue === 'string') {
      envelopeTo = toValue;
    }
  } catch (_) {}

  let rawText = '';
  let parsed = { text: '', html: '' };
  try {
    const buffer = await new Response(message.raw).arrayBuffer();
    rawText = await new Response(buffer).text();
    parsed = parseEmailBody(rawText);
  } catch (error) {
    console.error('邮件原文解析失败:', error);
  }

  const resolvedRecipient = (envelopeTo || toHeader || '').toString();
  const payload = {
    to: extractEmail(resolvedRecipient || toHeader),
    from: extractEmail(fromHeader),
    subject,
    text: parsed.text || '',
    html: parsed.html || '',
    raw: rawText || '',
    envelopeTo: resolvedRecipient || ''
  };

  ctx.waitUntil(fetch(`${base}/bridge-email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-freemail-bridge-token': env.BRIDGE_API_TOKEN || ''
    },
    body: JSON.stringify(payload)
  }).then(async (resp) => {
    if (!resp.ok) {
      console.error('后端邮件投递失败:', resp.status, await resp.text());
      return;
    }

    try {
      const data = await resp.json();
      if (data?.forwardTarget) {
        await message.forward(data.forwardTarget);
      }
    } catch (_) {}
  }).catch((error) => {
    console.error('后端邮件投递异常:', error);
  }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return proxyApiRequest(request, env);
    }

    const MAIL_DOMAINS = (env.MAIL_DOMAIN || 'temp.example.com')
      .split(/[,\s]+/)
      .map(d => d.trim())
      .filter(Boolean);

    const assetManager = createAssetManager();
    return assetManager.handleAssetRequest(request, env, MAIL_DOMAINS);
  },

  async email(message, env, ctx) {
    await forwardInboundEmail(message, env, ctx);
  }
};
