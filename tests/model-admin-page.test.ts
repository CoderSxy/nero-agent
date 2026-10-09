import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { MODEL_ADMIN_HTML, modelAdminRoutes } from '../src/mastra/models/admin-page';
import { studioChineseMiddleware } from '../src/mastra/studio-zh';

// jsdom is only installed with the web workspace; reuse it for DOM-level assertions.
const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url));
const { JSDOM } = requireFromWeb('jsdom') as typeof import('jsdom');

type FetchCall = { url: string; method: string; headers: Record<string, string>; body?: string };

const PUBLIC_MODEL = {
  ref: 'public:11111111-1111-4111-8111-111111111111',
  scope: 'public',
  displayName: '演示模型',
  providerId: 'openai',
  modelId: 'gpt-demo',
  baseUrl: 'https://models.example.test/v1',
  apiMode: 'chat',
  enabled: true,
  hasApiKey: true,
  keyHint: '1234',
  supportsVision: false,
  isDefault: false,
};

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function flush() {
  return new Promise(resolve => setTimeout(resolve, 20));
}

async function openPage(
  handler: (call: FetchCall) => ReturnType<typeof response>,
  token?: string,
) {
  const calls: FetchCall[] = [];
  const dom = new JSDOM(MODEL_ADMIN_HTML, {
    url: 'http://localhost:4111/model-admin',
    runScripts: 'dangerously',
    beforeParse(window) {
      if (token) window.sessionStorage.setItem('model-admin-token', token);
      (window as unknown as { fetch: unknown }).fetch = async (url: string, init: RequestInit = {}) => {
        const call: FetchCall = {
          url,
          method: init.method ?? 'GET',
          headers: (init.headers ?? {}) as Record<string, string>,
          body: init.body as string | undefined,
        };
        calls.push(call);
        return handler(call);
      };
    },
  });
  await flush();
  return { dom, calls, doc: dom.window.document };
}

const ACTIONS = ['create', 'edit', 'replace-key', 'toggle-enabled', 'set-default', 'delete'];

test('GET /model-admin is a public HTML route with the admin controls', async () => {
  const route = modelAdminRoutes[0] as { path: string; method: string; requiresAuth?: boolean; handler: () => Promise<Response> };
  assert.equal(route.path, '/model-admin');
  assert.equal(route.method, 'GET');
  assert.equal(route.requiresAuth, false);

  const res = await route.handler();
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await res.text();
  for (const action of ACTIONS) assert.ok(html.includes(`'${action}'`), `missing control ${action}`);
  assert.match(html, /sessionStorage/);
  assert.doesNotMatch(html, /localStorage/);
  assert.match(html, /\/auth\/login/);
});

test('the admin page is not rewritten by the Studio localization middleware', async () => {
  const context = {
    req: { path: '/model-admin' },
    res: new Response(MODEL_ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  };
  await studioChineseMiddleware.handler(context, async () => {});
  assert.equal(await context.res.text(), MODEL_ADMIN_HTML);
});

test('without a token the page shows only the login form and makes no API call', async () => {
  const { calls, doc } = await openPage(() => response(500, {}));
  assert.ok(doc.querySelector('#login-form'));
  assert.equal(doc.querySelector('[data-action]'), null);
  assert.equal(calls.length, 0);
});

test('401 from the public API clears the token and shows the login form', async () => {
  const { dom, doc } = await openPage(() => response(401, { error: '未登录' }), 'stale');
  assert.ok(doc.querySelector('#login-form'));
  assert.equal(doc.querySelector('[data-form="create"]'), null);
  assert.equal(doc.querySelector('[data-action]'), null);
  assert.equal(dom.window.sessionStorage.getItem('model-admin-token'), null);
});

test('403 from the public API shows 无权访问 without editable controls', async () => {
  const { doc } = await openPage(() => response(403, { error: '无权管理公共模型' }), 'user-token');
  assert.match(doc.body.textContent ?? '', /无权访问/);
  assert.equal(doc.querySelector('form'), null);
  assert.equal(doc.querySelector('input'), null);
  for (const action of ACTIONS) assert.equal(doc.querySelector(`[data-action="${action}"]`), null);
});

test('admin sees create/edit/replace-key/enable/default/delete controls and calls the API with Bearer', async () => {
  const { calls, doc } = await openPage(call => {
    if (call.method === 'GET') return response(200, { models: [PUBLIC_MODEL] });
    return response(200, { model: PUBLIC_MODEL, ok: true });
  }, 'admin-token');
  assert.equal(calls[0].url, '/model-catalog/public');
  assert.equal(calls[0].headers.Authorization, 'Bearer admin-token');
  for (const action of ['create', 'edit', 'replace-key', 'toggle-enabled', 'set-default', 'delete']) {
    assert.ok(doc.querySelector(`[data-action="${action}"]`), `missing ${action}`);
  }
  assert.doesNotMatch(doc.body.innerHTML, /sk-/);

  const click = (selector: string) => (doc.querySelector(selector) as HTMLElement).click();
  const id = PUBLIC_MODEL.ref.slice('public:'.length);

  click('[data-action="toggle-enabled"]');
  await flush();
  assert.deepEqual(
    [calls[1].method, calls[1].url, calls[1].body],
    ['PATCH', `/model-catalog/public/${id}`, JSON.stringify({ enabled: false })],
  );

  click('[data-action="set-default"]');
  await flush();
  const setDefault = calls.find(call => call.body === JSON.stringify({ isDefault: true }));
  assert.ok(setDefault);

  click('[data-action="replace-key"]');
  const keyForm = doc.querySelector('[data-form="replace-key"]') as HTMLFormElement;
  (keyForm.elements.namedItem('apiKey') as HTMLInputElement).value = 'sk-new';
  keyForm.dispatchEvent(new doc.defaultView!.Event('submit', { cancelable: true }));
  await flush();
  assert.ok(calls.some(call => call.method === 'PATCH' && call.body === JSON.stringify({ apiKey: 'sk-new' })));

  click('[data-action="delete"]');
  assert.ok(doc.querySelector('[data-action="confirm-delete"]'));
  click('[data-action="confirm-delete"]');
  await flush();
  assert.ok(calls.some(call => call.method === 'DELETE' && call.url === `/model-catalog/public/${id}`));
});

test('login stores the token per tab and loads the list; edit submits a PATCH without apiKey', async () => {
  const { dom, calls, doc } = await openPage(call => {
    if (call.url === '/auth/login') return response(200, { token: 'fresh', user: { id: 'u', roles: ['admin'] } });
    return response(200, { models: [PUBLIC_MODEL] });
  });
  const form = doc.querySelector('#login-form') as HTMLFormElement;
  (form.elements.namedItem('email') as HTMLInputElement).value = 'admin@example.test';
  (form.elements.namedItem('password') as HTMLInputElement).value = 'secret';
  form.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await flush();
  assert.equal(dom.window.sessionStorage.getItem('model-admin-token'), 'fresh');
  assert.equal(calls[0].body, JSON.stringify({ email: 'admin@example.test', password: 'secret' }));
  assert.equal(calls[1].headers.Authorization, 'Bearer fresh');

  (doc.querySelector('[data-action="edit"]') as HTMLElement).click();
  const edit = doc.querySelector('[data-form="edit"]') as HTMLFormElement;
  assert.equal(edit.elements.namedItem('apiKey'), null);
  (edit.elements.namedItem('displayName') as HTMLInputElement).value = '新名称';
  edit.dispatchEvent(new dom.window.Event('submit', { cancelable: true }));
  await flush();
  const patch = calls.find(call => call.method === 'PATCH');
  assert.ok(patch);
  assert.equal(JSON.parse(patch.body!).displayName, '新名称');
  assert.equal('apiKey' in JSON.parse(patch.body!), false);
});

test('domestic catalog sync previews differences and submits only selected edited new models', async () => {
  const { calls, doc, dom } = await openPage(call => {
    if (call.url.endsWith('/sync/preview')) return response(200, {
      source: '已有网关模型',
      incoming: [
        { modelId: 'glm-5.2', displayName: 'GLM 5.2', status: 'new' },
        { modelId: 'kimi-k2.7', displayName: 'Kimi', status: 'new' },
        { modelId: 'old', displayName: '已有模型', status: 'existing' },
      ],
      missing: [{ modelId: 'local', displayName: '本地模型' }],
    });
    if (call.url.endsWith('/sync/apply')) return response(200, { created: 1 });
    return response(200, { models: [PUBLIC_MODEL] });
  }, 'admin-token');
  const managementInput = doc.querySelector('input[aria-label="模型中心只读管理 API Token"]') as HTMLInputElement;
  managementInput.value = 'wbt_readonly_example_token_123456789';
  managementInput.dispatchEvent(new dom.window.Event('input'));
  (doc.querySelector('[data-action="preview-sync"]') as HTMLElement).click();
  await flush();
  assert.ok(calls.some(call => call.url === '/model-catalog/public/sync/preview'
    && call.method === 'POST' && call.headers.Authorization === 'Bearer admin-token'
    && JSON.parse(call.body!).managementToken === 'wbt_readonly_example_token_123456789'));
  const rows = doc.querySelectorAll('.sync-row[data-new]');
  assert.equal(rows.length, 2);
  assert.equal((rows[0].querySelector('input[type=checkbox]') as HTMLInputElement).checked, false);
  (rows[0].querySelector('input[type=checkbox]') as HTMLInputElement).checked = true;
  (rows[0].querySelector('input[type=text]') as HTMLInputElement).value = '新 GLM';
  (rows[1].querySelector('input[type=checkbox]') as HTMLInputElement).checked = false;
  (doc.querySelector('[data-action="apply-sync"]') as HTMLElement).click();
  await flush();
  const applied = calls.find(call => call.url === '/model-catalog/public/sync/apply');
  assert.deepEqual(JSON.parse(applied!.body!), { items: [{ modelId: 'glm-5.2', displayName: '新 GLM' }], managementToken: 'wbt_readonly_example_token_123456789' });
  assert.match(doc.body.textContent ?? '', /已同步 1 个公共模型/);
});
