const baseUrl = 'http://127.0.0.1:3000';

async function expectStatus(path, expected, options = {}) {
  const response = await fetch(baseUrl + path, { redirect: 'manual', ...options });
  if (response.status !== expected) throw new Error(`${path} 预期 ${expected}，实际 ${response.status}`);
  return response;
}

(async () => {
  const health = await expectStatus('/api/health', 200);
  const body = await health.json();
  if (!body.ok) throw new Error('健康检查返回异常');
  const root = await expectStatus('/', 302);
  if (root.headers.get('location') !== '/login') throw new Error('未登录首页未跳转登录页');
  await expectStatus('/login', 200);
  await expectStatus('/api/config', 401);
  await expectStatus('/api/history', 401);
  console.log('冒烟测试通过：健康检查、登录页、首页拦截、API 会话拦截');
})().catch((error) => { console.error(error.message); process.exit(1); });
