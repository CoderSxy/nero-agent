import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { localizeStudioHtml, studioChineseMiddleware } from '../src/mastra/studio-zh';

test('Studio middleware injects the Chinese UI only into HTML responses', async () => {
  const htmlContext = {
    req: { path: '/agents' },
    res: new Response('<html><head></head><body></body></html>', {
      headers: { 'content-type': 'text/html' },
    }),
  };
  await studioChineseMiddleware.handler(htmlContext, async () => {});
  const html = await htmlContext.res.text();
  assert.match(html, /智能体平台|\\u667A\\u80FD\\u4F53\\u5E73\\u53F0/);
  assert.match(html, /\/workflows/);

  const apiContext = {
    req: { path: '/api/agents' },
    res: new Response('{"agents":[]}', { headers: { 'content-type': 'application/json' } }),
  };
  await studioChineseMiddleware.handler(apiContext, async () => {});
  assert.equal(await apiContext.res.text(), '{"agents":[]}');
});

const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url));
const { JSDOM } = requireFromWeb('jsdom') as typeof import('jsdom');

const STUDIO_HTML = '<!doctype html><html><head><title>Mastra Studio</title></head><body><div id="root"></div></body></html>';

function countLinks(html: string) {
  return html.split('/model-admin').length - 1;
}

test('Studio HTML gets exactly one /model-admin link; non-Studio HTML is untouched', () => {
  assert.equal(countLinks(localizeStudioHtml(STUDIO_HTML)), 1);
  const fragment = '<p>no head here</p>';
  assert.equal(localizeStudioHtml(fragment), fragment);
  assert.equal(countLinks(fragment), 0);
});

test('Studio uses the page origin for API requests so login cookies stay on the same host', () => {
  const html = localizeStudioHtml(STUDIO_HTML);
  const dom = new JSDOM(html, { url: 'http://localhost:4111/', runScripts: 'dangerously', pretendToBeVisual: true });
  assert.equal((dom.window as Window & { MASTRA_AUTO_DETECT_URL?: string }).MASTRA_AUTO_DETECT_URL, 'true');
});

test('production Studio hands a tab session to Mastra without sending it in the HTTP URL', () => {
  const dom = new JSDOM(localizeStudioHtml(STUDIO_HTML), {
    url: 'https://agent.nerosun.cn/studio/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) { window.sessionStorage.setItem('nero-agent-session', 'admin-test-token'); },
  });
  assert.equal((dom.window as Window & { MASTRA_AUTO_DETECT_URL?: string }).MASTRA_AUTO_DETECT_URL, 'true');
  assert.equal(dom.window.location.search, '?auth_header=Bearer+admin-test-token');
  assert.equal(dom.window.localStorage.getItem('mastra-studio-config'), null);
});

test('Studio replaces an older saved API host with the current 4111 page origin', () => {
  const dom = new JSDOM(localizeStudioHtml(STUDIO_HTML), {
    url: 'http://127.0.0.1:4111/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      window.localStorage.setItem('mastra-studio-config', JSON.stringify({
        baseUrl: 'http://localhost:4111', apiPrefix: '/api', headers: {},
      }));
    },
  });
  const config = JSON.parse(dom.window.localStorage.getItem('mastra-studio-config') || '{}');
  assert.equal(config.baseUrl, 'http://127.0.0.1:4111');
});

async function renderStudio(path: string) {
  const dom = new JSDOM(localizeStudioHtml(STUDIO_HTML), {
    url: `http://localhost:4111${path}`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { document } = dom.window;
  const main = document.createElement('main');
  document.body.appendChild(main);
  await new Promise(resolve => setTimeout(resolve, 80));
  return document;
}

test('the Settings page shows one /model-admin link and other pages show none', async () => {
  const settings = await renderStudio('/settings');
  assert.equal(settings.querySelectorAll('a[href="/model-admin"]').length, 1);
  settings.body.appendChild(settings.createElement('div'));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(settings.querySelectorAll('a[href="/model-admin"]').length, 1);

  const agents = await renderStudio('/agents');
  assert.equal(agents.querySelectorAll('a[href="/model-admin"]').length, 0);
});
