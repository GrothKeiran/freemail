import 'dotenv/config';
import http from 'node:http';
import { URL } from 'node:url';

import { createRouter } from '../../src/routes/index.js';
import { getInitializedDatabase } from '../../src/db/index.js';
import { parseEmailBody, extractVerificationCode } from '../../src/email/parser.js';
import { extractEmail } from '../../src/utils/common.js';
import { getForwardTarget } from '../../src/db/mailboxes.js';
import { forwardByLocalPart } from '../../src/email/forwarder.js';
import { initMysqlPoolFromEnv, createMysqlAdapter, initializeMySqlSchema } from './mysqlAdapter.js';
import { LocalStorageManager } from './localStorage.js';
import { verifyBridgeRequest } from './bridgeClient.js';

const port = Number(process.env.PORT || 8788);
const storage = new LocalStorageManager(process.env.STORAGE_ROOT || './data/mail-storage');

async function buildEnv() {
  const pool = await initMysqlPoolFromEnv(process.env);
  await initializeMySqlSchema(pool);
  await storage.ensureReady();

  const db = createMysqlAdapter(pool);
  return {
    ...process.env,
    TEMP_MAIL_DB: db,
    MAIL_DOMAIN: process.env.MAIL_DOMAIN || 'temp.example.com',
    ADMIN_NAME: process.env.ADMIN_NAME || 'admin',
    ASSETS: {
      async fetch() {
        return new Response('后端服务不提供静态资源，请通过 Cloudflare Worker 访问前端。', { status: 404 });
      }
    },
    MAIL_EML: {
      async put(key, value) {
        await storage.write(key, Buffer.from(value));
      },
      async get(key) {
        const exists = await storage.exists(key);
        if (!exists) return null;
        const body = await storage.read(key);
        return {
          body,
          async text() { return body.toString('utf8'); },
          async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength); }
        };
      }
    }
  };
}

function toRequest(req, bodyBuffer) {
  const host = req.headers.host || `127.0.0.1:${port}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const url = `${proto}://${host}${req.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (typeof value === 'string') {
      headers.set(key, value);
    }
  }
  const init = { method: req.method, headers };
  if (!['GET', 'HEAD'].includes((req.method || 'GET').toUpperCase())) {
    init.body = bodyBuffer;
  }
  return new Request(url, init);
}

async function sendNodeResponse(nodeRes, webRes) {
  nodeRes.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => nodeRes.setHeader(key, value));
  const buf = Buffer.from(await webRes.arrayBuffer());
  nodeRes.end(buf);
}

async function handleBridgeApi(request, env) {
  const verify = await verifyBridgeRequest(request, env);
  if (!verify.ok) return new Response(verify.message, { status: verify.status });

  await getInitializedDatabase(env);
  const router = createRouter();
  const routeResponse = await router.handle(request, { request, env, ctx: { waitUntil() {} } });
  if (routeResponse) return routeResponse;

  return new Response('Not Found', { status: 404 });
}

async function handleBridgeEmail(request, env) {
  const verify = await verifyBridgeRequest(request, env);
  if (!verify.ok) return new Response(verify.message, { status: verify.status });

  const body = await request.json();
  const db = await getInitializedDatabase(env);
  const mailbox = extractEmail(body.to || '');
  const sender = extractEmail(body.from || '');
  const subject = String(body.subject || '(无主题)');
  const text = String(body.text || '');
  const html = String(body.html || '');
  const raw = String(body.raw || '');
  const parsed = raw ? parseEmailBody(raw) : { text, html };
  const previewBase = (parsed.text || text || (parsed.html || html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const preview = String(previewBase || '').slice(0, 120);
  const verificationCode = extractVerificationCode({ subject, text: parsed.text || text, html: parsed.html || html });

  const mailboxRes = await db.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(mailbox.toLowerCase()).all();
  let mailboxId = mailboxRes?.results?.[0]?.id;
  if (!mailboxId) {
    const [localPart, domain] = mailbox.toLowerCase().split('@');
    await db.prepare('INSERT INTO mailboxes (address, local_part, domain, password_hash, last_accessed_at) VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP)')
      .bind(mailbox.toLowerCase(), localPart, domain).run();
    const created = await db.prepare('SELECT id FROM mailboxes WHERE address = ?').bind(mailbox.toLowerCase()).all();
    mailboxId = created?.results?.[0]?.id;
  }

  let objectKey = '';
  if (raw) {
    objectKey = storage.buildKey(mailbox, 'eml');
    await storage.write(objectKey, Buffer.from(raw, 'utf8'));
  }

  await db.prepare(`
    INSERT INTO messages (mailbox_id, sender, to_addrs, subject, verification_code, preview, r2_bucket, r2_object_key, content, html_content)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    mailboxId,
    sender,
    mailbox,
    subject,
    verificationCode || null,
    preview || null,
    'local-disk',
    objectKey || '',
    parsed.text || text || null,
    parsed.html || html || null
  ).run();

  const forwardTarget = await getForwardTarget(db, mailbox);
  return Response.json({ success: true, forwardTarget });
}

const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const request = toRequest(req, body);
    const env = await buildEnv();
    const url = new URL(request.url);

    let response;
    if (url.pathname.startsWith('/bridge-api')) {
      const bridgeUrl = new URL(request.url);
      bridgeUrl.pathname = bridgeUrl.pathname.replace(/^\/bridge-api/, '') || '/';
      response = await handleBridgeApi(new Request(bridgeUrl.toString(), request), env);
    } else if (url.pathname === '/bridge-email') {
      response = await handleBridgeEmail(request, env);
    } else if (url.pathname === '/healthz') {
      response = Response.json({ ok: true });
    } else {
      response = new Response('Not Found', { status: 404 });
    }

    await sendNodeResponse(res, response);
  } catch (error) {
    console.error(error);
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end(`Internal Server Error: ${error.message}`);
  }
});

server.listen(port, () => {
  console.log(`Freemail backend listening on :${port}`);
});
