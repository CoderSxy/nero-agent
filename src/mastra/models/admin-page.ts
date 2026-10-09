import { registerApiRoute } from '@mastra/core/server';

export const MODEL_ADMIN_PATH = '/model-admin';

const STYLE = `
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; background: #f6f7f9; color: #1c2024; }
@media (prefers-color-scheme: dark) { body { background: #111315; color: #e8eaed; } }
main { max-width: 1080px; margin: 0 auto; padding: 24px 16px 64px; }
header.bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 16px; margin: 0 0 12px; }
section.card { background: #fff; border: 1px solid #d9dde3; border-radius: 10px; padding: 16px; margin-bottom: 16px; }
@media (prefers-color-scheme: dark) { section.card { background: #1b1e21; border-color: #30353a; } }
form.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; align-items: end; }
label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
label.check { flex-direction: row; align-items: center; gap: 6px; }
input[type=text], input[type=url], input[type=email], input[type=password], select {
  padding: 7px 9px; border: 1px solid #b9c0c8; border-radius: 6px; font: inherit; background: transparent; color: inherit; }
button { padding: 6px 12px; border: 1px solid #b9c0c8; border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
button.danger { color: #c62828; border-color: #c62828; }
button:disabled { opacity: .5; cursor: not-allowed; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #d9dde3; vertical-align: top; }
@media (prefers-color-scheme: dark) { th, td { border-color: #30353a; } }
td.actions { display: flex; flex-wrap: wrap; gap: 6px; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; background: #e5e9f0; color: #1c2024; }
.badge.ok { background: #d9f2e1; } .badge.default { background: #dbe7ff; }
.notice { padding: 8px 12px; border-radius: 6px; margin-bottom: 12px; background: #dbe7ff; color: #11306b; }
.notice.error { background: #fde0e0; color: #7a1313; }
.muted { opacity: .7; font-size: 12px; }
.login { max-width: 360px; margin: 64px auto; }
.login form { display: flex; flex-direction: column; gap: 12px; }
.sync-list { display: grid; gap: 8px; margin: 12px 0; max-height: 360px; overflow-y: auto; }
.sync-row { display: grid; grid-template-columns: auto minmax(0, 1fr) minmax(150px, 1fr); align-items: center; gap: 10px; padding: 8px; border: 1px solid #d9dde3; border-radius: 8px; font-size: 12px; }
.sync-row input[type=text] { width: 100%; min-width: 0; }
.sync-row code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 600px) { .sync-row { grid-template-columns: auto minmax(0, 1fr); } .sync-row input[type=text] { grid-column: 2; } }
`;

const SCRIPT = `
(function () {
  'use strict';
  var TOKEN_KEY = 'model-admin-token';
  var API = '/model-catalog/public';
  var root = document.getElementById('app');
  var state = { models: [], editing: null, keyFor: null, confirmDelete: null, notice: null, syncPreview: null, syncBusy: false, managementToken: '' };

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      var value = attrs[key];
      if (value === false || value === null || value === undefined) return;
      if (key.indexOf('on') === 0) node.addEventListener(key.slice(2), value);
      else if (key === 'text') node.textContent = value;
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    });
    (children || []).forEach(function (child) {
      if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function mount() {
    root.textContent = '';
    for (var i = 0; i < arguments.length; i += 1) root.appendChild(arguments[i]);
  }

  function token() { return sessionStorage.getItem(TOKEN_KEY); }

  function request(method, path, body) {
    var headers = { Authorization: 'Bearer ' + (token() || '') };
    var init = { method: method, headers: headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var error = new Error((data && data.error) || '请求失败');
          error.status = res.status;
          throw error;
        }
        return data;
      });
    });
  }

  function resetState() {
    state.models = []; state.editing = null; state.keyFor = null; state.confirmDelete = null;
    state.notice = null; state.syncPreview = null; state.syncBusy = false; state.managementToken = '';
  }

  function fail(error) {
    if (error && error.status === 401) {
      sessionStorage.removeItem(TOKEN_KEY);
      resetState();
      renderLogin('登录已失效，请重新登录');
    } else if (error && error.status === 403) {
      resetState();
      renderForbidden();
    } else {
      state.notice = { error: true, text: (error && error.message) || '操作失败' };
      renderAdmin();
    }
  }

  function logout() {
    var current = token();
    sessionStorage.removeItem(TOKEN_KEY);
    resetState();
    if (current) fetch('/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + current } }).catch(function () {});
    renderLogin('');
  }

  function load() {
    if (!token()) return renderLogin('');
    return request('GET', API).then(function (data) {
      state.models = data.models || [];
      renderAdmin();
    }, fail);
  }

  function mutate(method, path, body, message) {
    return request(method, path, body).then(function () {
      state.editing = null; state.keyFor = null; state.confirmDelete = null; state.syncPreview = null;
      state.notice = { error: false, text: message };
      return load();
    }, fail);
  }

  function modelId(model) { return model.ref.slice('public:'.length); }

  function renderLogin(message) {
    var email = el('input', { type: 'email', name: 'email', required: true, autocomplete: 'username' });
    var password = el('input', { type: 'password', name: 'password', required: true, autocomplete: 'current-password' });
    var errorBox = el('div', { class: 'notice error', role: 'alert', hidden: !message, text: message || '' });
    var form = el('form', { id: 'login-form', onsubmit: function (event) {
      event.preventDefault();
      errorBox.hidden = true;
      fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.value, password: password.value }),
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || !data.token) throw new Error((data && data.error) || '登录失败');
          sessionStorage.setItem(TOKEN_KEY, data.token);
          password.value = '';
          return load();
        });
      }).catch(function (error) {
        errorBox.textContent = error.message || '登录失败';
        errorBox.hidden = false;
      });
    } }, [
      el('label', {}, ['邮箱', email]),
      el('label', {}, ['密码', password]),
      errorBox,
      el('button', { type: 'submit', class: 'primary', text: '登录' }),
    ]);
    mount(el('section', { class: 'card login' }, [el('h1', { text: '公共模型管理 · 登录' }), el('p', { class: 'muted', text: '请使用管理员账号登录。登录状态仅保存在当前标签页。' }), form]));
  }

  function renderForbidden() {
    mount(el('section', { class: 'card login' }, [
      el('h1', { text: '无权访问' }),
      el('p', { text: '当前账号不是管理员，无法管理公共模型。' }),
      el('button', { type: 'button', 'data-action': 'logout', onclick: logout, text: '退出登录' }),
    ]));
  }

  function textField(label, name, value, extra) {
    return el('label', {}, [label, el('input', Object.assign({ type: 'text', name: name, value: value || '', required: true, autocomplete: 'off' }, extra || {}))]);
  }

  function apiModeField(value) {
    var select = el('select', { name: 'apiMode' }, [
      el('option', { value: 'chat', text: 'Chat Completions', selected: value !== 'responses' }),
      el('option', { value: 'responses', text: 'Responses', selected: value === 'responses' }),
    ]);
    return el('label', {}, ['接口类型', select]);
  }

  function readField(form, name) { return form.elements[name].value.trim(); }

  function baseFields(model) {
    model = model || {};
    return [
      textField('显示名称', 'displayName', model.displayName),
      textField('服务商标识', 'providerId', model.providerId),
      textField('模型 ID', 'modelId', model.modelId),
      textField('Base URL', 'baseUrl', model.baseUrl, { type: 'url' }),
      apiModeField(model.apiMode),
    ];
  }

  function baseBody(form) {
    return {
      displayName: readField(form, 'displayName'),
      providerId: readField(form, 'providerId'),
      modelId: readField(form, 'modelId'),
      baseUrl: readField(form, 'baseUrl'),
      apiMode: form.elements.apiMode.value,
    };
  }

  function createForm() {
    var enabled = el('input', { type: 'checkbox', name: 'enabled', checked: true });
    var supportsVision = el('input', { type: 'checkbox', name: 'supportsVision' });
    var isDefault = el('input', { type: 'checkbox', name: 'isDefault' });
    var form = el('form', { class: 'grid', 'data-form': 'create', onsubmit: function (event) {
      event.preventDefault();
      var body = baseBody(form);
      body.apiKey = form.elements.apiKey.value;
      body.enabled = enabled.checked;
      body.supportsVision = supportsVision.checked;
      body.isDefault = isDefault.checked;
      mutate('POST', API, body, '已创建公共模型');
    } }, baseFields().concat([
      el('label', {}, ['API Key', el('input', { type: 'password', name: 'apiKey', required: true, autocomplete: 'new-password' })]),
      el('label', { class: 'check' }, [enabled, '启用']),
      el('label', { class: 'check' }, [supportsVision, '支持图片']),
      el('label', { class: 'check' }, [isDefault, '设为默认']),
      el('button', { type: 'submit', class: 'primary', 'data-action': 'create', text: '创建模型' }),
    ]));
    return el('section', { class: 'card' }, [el('h2', { text: '新建公共模型' }), form]);
  }

  function editForm(model) {
    var supportsVision = el('input', { type: 'checkbox', name: 'supportsVision', checked: !!model.supportsVision });
    var form = el('form', { class: 'grid', 'data-form': 'edit', onsubmit: function (event) {
      event.preventDefault();
      var body = baseBody(form);
      body.supportsVision = supportsVision.checked;
      mutate('PATCH', API + '/' + encodeURIComponent(modelId(model)), body, '已保存修改');
    } }, baseFields(model).concat([
      el('label', { class: 'check' }, [supportsVision, '支持图片']),
      el('button', { type: 'submit', class: 'primary', 'data-action': 'save-edit', text: '保存' }),
      el('button', { type: 'button', text: '取消', onclick: function () { state.editing = null; renderAdmin(); } }),
    ]));
    return form;
  }

  function keyForm(model) {
    var form = el('form', { class: 'grid', 'data-form': 'replace-key', onsubmit: function (event) {
      event.preventDefault();
      mutate('PATCH', API + '/' + encodeURIComponent(modelId(model)), { apiKey: form.elements.apiKey.value }, '已替换 API Key');
    } }, [
      el('label', {}, ['新的 API Key', el('input', { type: 'password', name: 'apiKey', required: true, autocomplete: 'new-password' })]),
      el('button', { type: 'submit', class: 'primary', 'data-action': 'save-key', text: '确认替换' }),
      el('button', { type: 'button', text: '取消', onclick: function () { state.keyFor = null; renderAdmin(); } }),
    ]);
    return form;
  }

  function actionButton(action, label, handler, extra) {
    return el('button', Object.assign({ type: 'button', 'data-action': action, onclick: handler, text: label }, extra || {}));
  }

  function modelRows(model) {
    var id = modelId(model);
    var path = API + '/' + encodeURIComponent(id);
    var status = [el('span', { class: 'badge' + (model.enabled ? ' ok' : ''), text: model.enabled ? '已启用' : '已停用' })];
    if (model.supportsVision) status.push(' ', el('span', { class: 'badge ok', text: '支持图片' }));
    if (model.isDefault) status.push(' ', el('span', { class: 'badge default', text: '默认' }));
    var buttons = [
      actionButton('edit', '编辑', function () { state.editing = model.ref; state.keyFor = null; state.confirmDelete = null; renderAdmin(); }),
      actionButton('replace-key', '替换 Key', function () { state.keyFor = model.ref; state.editing = null; state.confirmDelete = null; renderAdmin(); }),
      actionButton('toggle-enabled', model.enabled ? '停用' : '启用', function () {
        mutate('PATCH', path, { enabled: !model.enabled }, model.enabled ? '已停用' : '已启用');
      }),
      actionButton('set-default', '设为默认', function () { mutate('PATCH', path, { isDefault: true }, '已设为默认'); }, { disabled: !!model.isDefault || !model.enabled }),
    ];
    if (state.confirmDelete === model.ref) {
      buttons.push(
        actionButton('confirm-delete', '确认删除', function () { mutate('DELETE', path, undefined, '已删除'); }, { class: 'danger' }),
        actionButton('cancel-delete', '取消', function () { state.confirmDelete = null; renderAdmin(); })
      );
    } else {
      buttons.push(actionButton('delete', '删除', function () { state.confirmDelete = model.ref; state.editing = null; state.keyFor = null; renderAdmin(); }, { class: 'danger' }));
    }
    var rows = [el('tr', { 'data-ref': model.ref }, [
      el('td', { text: model.displayName }),
      el('td', {}, [model.providerId + ' / ' + model.modelId, el('div', { class: 'muted', text: model.baseUrl })]),
      el('td', { text: model.apiMode }),
      el('td', { text: model.hasApiKey ? '已配置 ' + (model.keyHint || '') : '未配置' }),
      el('td', {}, status),
      el('td', { class: 'actions' }, buttons),
    ])];
    if (state.editing === model.ref) rows.push(el('tr', {}, [el('td', { colspan: '6' }, [editForm(model)])]));
    if (state.keyFor === model.ref) rows.push(el('tr', {}, [el('td', { colspan: '6' }, [keyForm(model)])]));
    return rows;
  }

  function previewSync() {
    if (state.syncBusy) return;
    if (!state.managementToken.trim()) { state.notice = { error: true, text: '请填写模型中心只读管理 API Token。' }; renderAdmin(); return; }
    state.syncBusy = true;
    state.syncPreview = null;
    renderAdmin();
    request('POST', API + '/sync/preview', { managementToken: state.managementToken.trim() }).then(function (preview) {
      state.syncPreview = preview;
      state.syncBusy = false;
      state.notice = null;
      renderAdmin();
    }, function (error) { state.syncBusy = false; fail(error); });
  }

  function applySync() {
    if (state.syncBusy || !state.syncPreview) return;
    var items = Array.from(document.querySelectorAll('.sync-row[data-new]')).filter(function (row) {
      return row.querySelector('input[type=checkbox]').checked;
    }).map(function (row) {
      return { modelId: row.getAttribute('data-model-id'), displayName: row.querySelector('input[type=text]').value.trim() };
    });
    if (!items.length) {
      state.notice = { error: true, text: '请至少选择一个新增模型。' };
      renderAdmin();
      return;
    }
    if (items.some(function (item) { return !item.displayName; })) {
      state.notice = { error: true, text: '模型显示名称不能为空。' };
      renderAdmin();
      return;
    }
    state.syncBusy = true;
    var button = document.querySelector('[data-action=apply-sync]');
    if (button) button.disabled = true;
    request('POST', API + '/sync/apply', { items: items, managementToken: state.managementToken.trim() }).then(function (result) {
      state.syncPreview = null;
      state.managementToken = '';
      state.syncBusy = false;
      state.notice = { error: false, text: '已同步 ' + result.created + ' 个公共模型。' };
      load();
    }, function (error) { state.syncBusy = false; fail(error); });
  }

  function syncSection() {
    var preview = state.syncPreview;
    var nodes = [el('h2', { text: '同步 WorkBuddy 国内版模型' }),
      el('p', { class: 'muted', text: '读取模型中心的国内版目录，与页面显示范围一致。请在 WorkBuddy「设置 → 访问令牌」创建只读管理 Token；Token 仅用于本次预览和确认，不会保存。已有配置和仅本地存在的模型不会更改。' }),
      el('p', { class: 'muted', text: '当前 WorkBuddy 地址使用 HTTP，管理 Token 在传输过程中未加密。建议仅使用可随时吊销的短期只读 Token。' }),
      el('input', { type: 'password', autocomplete: 'off', placeholder: '只读管理 API Token（wbt_…）', 'aria-label': '模型中心只读管理 API Token', value: state.managementToken,
        oninput: function (event) { state.managementToken = event.target.value; state.syncPreview = null; } }),
      el('button', { type: 'button', 'data-action': 'preview-sync', disabled: state.syncBusy, onclick: previewSync,
        text: state.syncBusy ? '正在查询…' : '查询模型并预览差异' })];
    if (preview) {
      var fresh = preview.incoming.filter(function (item) { return item.status === 'new'; });
      var existing = preview.incoming.filter(function (item) { return item.status === 'existing'; });
      nodes.push(el('p', { class: 'muted', text: '来源：' + preview.source + ' · 新增 ' + fresh.length + ' · 已存在 ' + existing.length + ' · 仅本地存在 ' + preview.missing.length }));
      var rows = fresh.map(function (item) {
        return el('div', { class: 'sync-row', 'data-new': true, 'data-model-id': item.modelId }, [
          el('input', { type: 'checkbox', 'aria-label': '同步 ' + item.modelId }),
          el('code', { text: item.modelId }),
          el('input', { type: 'text', value: item.displayName, maxlength: '100', 'aria-label': item.modelId + ' 显示名称' }),
        ]);
      });
      existing.forEach(function (item) { rows.push(el('div', { class: 'sync-row' }, [
        el('span', { class: 'badge ok', text: '已有' }), el('code', { text: item.modelId }), el('span', { text: item.displayName }),
      ])); });
      preview.missing.forEach(function (item) { rows.push(el('div', { class: 'sync-row' }, [
        el('span', { class: 'badge', text: '本地' }), el('code', { text: item.modelId }), el('span', { text: item.displayName }),
      ])); });
      if (fresh.length) nodes.push(el('label', { class: 'check' }, [
        el('input', { type: 'checkbox', onchange: function (event) {
          rows.filter(function (row) { return row.hasAttribute('data-new'); }).forEach(function (row) {
            row.querySelector('input[type=checkbox]').checked = event.target.checked;
          });
        } }), '全选新增模型',
      ]));
      nodes.push(el('div', { class: 'sync-list' }, rows));
      if (fresh.length) nodes.push(el('button', { type: 'button', class: 'primary', 'data-action': 'apply-sync',
        disabled: state.syncBusy, onclick: applySync, text: '确认同步所选模型' }));
    }
    return el('section', { class: 'card' }, nodes);
  }

  function renderAdmin() {
    var header = el('header', { class: 'bar' }, [
      el('h1', { text: '公共模型管理' }),
      el('div', {}, [
        el('a', { href: '/', text: '返回平台', style: 'margin-right:12px' }),
        el('button', { type: 'button', 'data-action': 'logout', onclick: logout, text: '退出登录' }),
      ]),
    ]);
    var nodes = [header];
    if (state.notice) nodes.push(el('div', { class: 'notice' + (state.notice.error ? ' error' : ''), role: state.notice.error ? 'alert' : 'status', text: state.notice.text }));
    nodes.push(syncSection());
    nodes.push(createForm());
    var body = el('tbody', {});
    state.models.forEach(function (model) { modelRows(model).forEach(function (row) { body.appendChild(row); }); });
    var table = el('table', {}, [
      el('thead', {}, [el('tr', {}, ['名称', '服务商 / 模型', '接口', 'API Key', '状态', '操作'].map(function (name) { return el('th', { text: name }); }))]),
      body,
    ]);
    nodes.push(el('section', { class: 'card' }, [
      el('h2', { text: '公共模型列表' }),
      state.models.length ? table : el('p', { class: 'muted', text: '暂无公共模型。' }),
    ]));
    mount.apply(null, nodes);
  }

  load();
})();
`;

export const MODEL_ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>公共模型管理</title>
<style>${STYLE}</style>
</head>
<body>
<main id="app"></main>
<script>${SCRIPT}</script>
</body>
</html>
`;

export const modelAdminRoutes = [
  registerApiRoute(MODEL_ADMIN_PATH, {
    method: 'GET',
    requiresAuth: false,
    handler: async () =>
      new Response(MODEL_ADMIN_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy':
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        },
      }),
  }),
];
