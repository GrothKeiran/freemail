export async function verifyBridgeRequest(request, env) {
  const token = request.headers.get('x-freemail-bridge-token') || '';
  const expected = env.BRIDGE_API_TOKEN || '';
  if (!expected) return { ok: false, status: 500, message: 'BRIDGE_API_TOKEN 未配置' };
  if (token !== expected) return { ok: false, status: 401, message: 'bridge token 无效' };
  return { ok: true };
}

export async function proxyToBackend(request, env, pathnamePrefix = '') {
  const base = String(env.BACKEND_BASE_URL || '').replace(/\/$/, '');
  if (!base) {
    return new Response('BACKEND_BASE_URL 未配置', { status: 500 });
  }

  const url = new URL(request.url);
  const target = new URL(`${base}${pathnamePrefix}${url.pathname}${url.search}`);
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
  return fetch(target.toString(), init);
}
