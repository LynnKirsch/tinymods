// CI-only browser acceptance. No application modules, private fixtures or extra packages.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { access, appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const LIMIT = 180_000;
const results = [];
let activeStep = 'startup';
let browser, server, protocol, temporary, origin, cleanupPromise;
const pages = new Set();
const safeUrl = value => {
  try { const u = new URL(value); return /^(data|blob):$/.test(u.protocol) ? u.protocol : u.origin + u.pathname; }
  catch { return 'unknown URL'; }
};
const brief = error => String(error?.message ?? error).slice(0, 1200);
function step(value) { activeStep = value; console.log('STEP ' + value); }
async function until(probe, description, milliseconds = 15_000) {
  const deadline = Date.now() + milliseconds;
  let last;
  do {
    last = await probe();
    if (last) return last;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error('Timeout: ' + description);
}

class CDP {
  constructor(socket) {
    this.socket = socket; this.next = 0; this.pending = new Map(); this.listeners = new Set();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const task = this.pending.get(message.id);
        if (!task) return;
        clearTimeout(task.timer); this.pending.delete(message.id);
        if (message.error) task.reject(new Error(task.method + ': ' + message.error.message));
        else task.resolve(message.result ?? {});
      } else for (const listener of this.listeners) listener(message);
    });
    socket.addEventListener('close', () => {
      for (const task of this.pending.values()) {
        clearTimeout(task.timer); task.reject(new Error('CDP connection closed'));
      }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 10_000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')); }, { once: true });
    });
    return new CDP(socket);
  }
  send(method, params = {}, sessionId, timeout = 15_000) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error('CDP timeout: ' + method));
      }, timeout);
      this.pending.set(id, { method, resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  listen(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}

class Page {
  constructor(context, target, session, analytics) {
    this.context = context; this.target = target; this.session = session; this.analytics = analytics;
    this.errors = []; this.failures = []; this.protocolErrors = []; this.requests = new Map();
    this.external = []; this.workerTargets = []; this.downloads = new Map(); this.closed = false;
    this.sessions = new Map([[session, { sessionId: session, targetId: target, type: 'page',
      parentSession: null, attached: true, ready: true }]]);
    this.removeListener = protocol.listen(message => {
      if (message.method === 'Browser.downloadWillBegin' && (!message.params.browserContextId || message.params.browserContextId === this.context)) {
        // Only one page can download at a time; each context is disposed before the next scenario.
        this.downloads.set(message.params.guid, { ...message.params, state: 'inProgress' });
      }
      if (message.method === 'Browser.downloadProgress' && this.downloads.has(message.params.guid)) {
        Object.assign(this.downloads.get(message.params.guid), message.params);
      }
      const source = this.sessions.get(message.sessionId);
      if (!source?.attached) return;
      const p = message.params;
      if (message.method === 'Target.attachedToTarget') {
        const child = { sessionId: p.sessionId, targetId: p.targetInfo.targetId, type: p.targetInfo.type,
          parentSession: message.sessionId, attached: true, ready: false };
        this.sessions.set(p.sessionId, child);
        if (child.type === 'worker') this.workerTargets.push({ type: child.type, url: safeUrl(p.targetInfo.url) });
        if (child.type === 'iframe') void this.prepareFrameSession(child);
      }
      if (message.method === 'Target.detachedFromTarget') this.detachSession(p.sessionId);
      // Observe Preview errors in its renderer too; existing main-page network interception is unchanged.
      if (source.type !== 'page' && source.type !== 'iframe') return;
      if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(brief(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));
      }
      if (message.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
        this.errors.push(p.args.map(a => brief(a.value ?? a.description)).join(' ').slice(0, 1200));
      }
      if (message.sessionId !== this.session) return;
      if (message.method === 'Network.requestWillBeSent') this.requests.set(p.requestId, p.request.url);
      if (message.method === 'Network.responseReceived' && p.response.status >= 400 && p.response.url.startsWith(origin)) {
        this.failures.push({ url: safeUrl(p.response.url), status: p.response.status });
      }
      if (message.method === 'Network.loadingFailed') {
        const url = this.requests.get(p.requestId) ?? '';
        if (url.startsWith(origin) && !p.canceled) this.failures.push({ url: safeUrl(url), error: p.errorText });
      }
      if (message.method === 'Fetch.requestPaused') {
        void this.intercept(p).catch(error => { if (!this.closed) this.protocolErrors.push(brief(error)); });
      }
    });
  }
  send(method, params = {}) { return protocol.send(method, params, this.session); }
  detachSession(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (entry) { entry.attached = false; entry.ready = false; }
    for (const child of this.sessions.values()) {
      if (child.parentSession === sessionId && child.attached) this.detachSession(child.sessionId);
    }
  }
  async prepareFrameSession(entry) {
    try {
      for (const method of ['Page.enable', 'Runtime.enable']) {
        if (!entry.attached || this.closed) return;
        await protocol.send(method, {}, entry.sessionId);
      }
      if (!entry.attached || this.closed) return;
      await protocol.send('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
      }, entry.sessionId);
      entry.ready = entry.attached;
    } catch (error) {
      entry.error = brief(error);
      if (this.frameRace(error)) this.detachSession(entry.sessionId);
      else if (!this.closed && entry.attached) this.protocolErrors.push('Preview session: ' + brief(error));
    }
  }
  frameRace(error) {
    return /No frame with given id|Cannot find frame|Cannot find context|context.*destroyed|Cannot find execution context|No node with given id|Could not find node|Session (?:with given id )?not found|Target closed|target.*closed|Inspected target navigated or closed/i.test(error.message);
  }
  async intercept(event) {
    const { requestId, request } = event;
    const url = new URL(request.url);
    if (url.origin === origin || ['data:', 'blob:', 'about:'].includes(url.protocol)) {
      await this.send('Fetch.continueRequest', { requestId }); return;
    }
    const record = { url: safeUrl(request.url), phase: this.phase ?? 'before-consent', outcome: 'paused' };
    this.external.push(record);
    if (this.analytics && url.hostname === 'mc.yandex.ru' && url.pathname === '/metrika/tag.js') {
      // A local probe SDK verifies UI/loader/destruct wiring, NOT real Yandex SDK behavior.
      record.outcome = 'fulfilled-locally';
      await this.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/javascript' }],
        body: Buffer.from('(' + analyticsProbe.toString() + ')();').toString('base64'),
      });
    } else {
      await this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      record.outcome = 'cancelled-before-send';
    }
  }
  async evaluate(expression, contextId, sessionId = this.session) {
    const result = await protocol.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true, timeout: 12_000,
      ...(contextId ? { contextId } : {}),
    }, sessionId);
    if (result.exceptionDetails) throw new Error(brief(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
    return result.result?.value;
  }
  fn(fn, ...args) { return this.evaluate('(' + fn.toString() + ')(' + args.map(a => JSON.stringify(a)).join(',') + ')'); }
  wait(fn, description, ms) { return until(() => this.fn(fn).catch(error => {
    if (/context.*destroyed|Cannot find context/i.test(error.message)) return false;
    throw error;
  }), description, ms); }
  async navigate(path) {
    step('navigate ' + path);
    const result = await this.send('Page.navigate', { url: origin + path });
    assert.ok(!result.errorText, 'Navigation failed: ' + result.errorText);
    await this.wait(() => document.readyState === 'complete', 'document complete');
    await this.wait(() => Boolean(document.querySelector('next-route-announcer')), 'Next client hydration');
  }
  async clickExpression(expression) {
    const point = await this.evaluate('(() => { const el = ' + expression + '; if (!el) throw Error("UI element not found"); if (el.disabled) throw Error("UI control disabled"); el.scrollIntoView({block:"center",inline:"center",behavior:"instant"}); const r=el.getBoundingClientRect(); if(!r.width || !r.height) throw Error("UI element is not visible"); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()');
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  click(selector) { return this.clickExpression('document.querySelector(' + JSON.stringify(selector) + ')'); }
  clickText(text, root = 'document') {
    return this.clickExpression('Array.from(' + root + '.querySelectorAll("button")).find(el => el.textContent.trim() === ' + JSON.stringify(text) + ' && el.getClientRects().length)');
  }
  async key(key, modifiers = 0) {
    const definition = { Tab: { code: 'Tab', windowsVirtualKeyCode: 9 },
      Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
      a: { code: 'KeyA', windowsVirtualKeyCode: 65 } }[key];
    assert.ok(definition, 'Known CDP keyboard key');
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, ...definition, modifiers });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, ...definition, modifiers });
  }
  async fill(selector, value) {
    await this.fn(selector => {
      const el = document.querySelector(selector);
      if (!el || el.readOnly || el.disabled) throw Error('Editable input not found');
      el.focus();
    }, selector);
    // Chromium resolves Ctrl+A through virtual key 65; key/code alone are insufficient.
    await this.key('a', 2);
    assert.equal(await this.fn(selector => {
      const el = document.querySelector(selector);
      return el.selectionStart === null || (el.selectionStart === 0 && el.selectionEnd === el.value.length);
    }, selector), true, 'Ctrl+A selected the complete editable value');
    await this.send('Input.insertText', { text: value });
    assert.equal(await this.fn((selector, value) => document.querySelector(selector)?.value === value, selector, value),
      true, 'Input.insertText replaced the complete value');
    await this.key('Tab');
    assert.equal(await this.fn((selector, value) => document.querySelector(selector)?.value === value, selector, value),
      true, 'Controlled input retains replacement after blur');
  }
  async focusState() {
    return this.fn(() => {
      const el = document.activeElement;
      const dialog = document.querySelector('#service-help-panel');
      const controls = dialog ? Array.from(dialog.querySelectorAll(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
      )).filter(item => item.getClientRects().length > 0) : [];
      return { tag: el?.tagName, role: el?.getAttribute('role'), ariaLabel: el?.getAttribute('aria-label'),
        text: el?.matches('button,a,summary') ? el.textContent.trim().slice(0, 80) : '',
        inside: Boolean(el?.closest('#service-help-panel')), first: el === controls[0], last: el === controls.at(-1),
        controlCount: controls.length };
    });
  }
  async previewOwner() {
    const { root } = await this.send('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await this.send('DOM.querySelectorAll', {
      nodeId: root.nodeId, selector: 'iframe[title="Предпросмотр HTML-блоков"]',
    });
    assert.ok(nodeIds.length <= 1, 'Exactly one live Preview iframe owner');
    if (!nodeIds.length) return null;
    const { node } = await this.send('DOM.describeNode', { nodeId: nodeIds[0] });
    return { backendNodeId: node.backendNodeId, frameId: node.frameId };
  }
  async frameHeading() {
    this.lastPreview = { targets: this.targetDiagnostics(), frames: [] };
    try {
      const owner = await this.previewOwner();
      this.lastPreview.owner = owner;
      if (!owner?.frameId) return null;
      // Page.getFrameTree is session-local. Resolve the owner's frame ID in the renderer
      // which actually contains it; do not assume targetId == frameId or select by URL.
      let candidate;
      for (const entry of this.sessions.values()) {
        if (!entry.attached || !entry.ready || !['page', 'iframe'].includes(entry.type)) continue;
        try {
          const { frameTree } = await protocol.send('Page.getFrameTree', {}, entry.sessionId);
          const frames = [];
          const visit = node => { frames.push(node.frame); for (const child of node.childFrames ?? []) visit(child); };
          visit(frameTree);
          this.lastPreview.frames.push(...frames.map(frame => ({
            id: frame.id, sessionId: entry.sessionId, targetType: entry.type,
          })));
          if (frames.some(frame => frame.id === owner.frameId)) {
            // An OOPIF's own root is authoritative if a parent also lists its placeholder.
            if (!candidate || frameTree.frame.id === owner.frameId) candidate = entry;
            if (frameTree.frame.id === owner.frameId) break;
          }
        } catch (error) {
          if (!this.frameRace(error)) throw error;
          this.lastPreview.sessionRace = { sessionId: entry.sessionId, error: brief(error) };
          if (/Session .*not found|Target closed|target.*closed/i.test(error.message)) this.detachSession(entry.sessionId);
        }
      }
      if (!candidate) return null;
      this.lastPreview.selectedSessionId = candidate.sessionId;
      this.lastPreview.selectedTargetType = candidate.type;
      const { executionContextId } = await protocol.send('Page.createIsolatedWorld', {
        frameId: owner.frameId, worldName: 'optima-smoke-read-only',
      }, candidate.sessionId);
      const preview = await this.evaluate('({ heading:document.querySelector("#smoke-block h2")?.textContent, width:innerWidth, overflow:document.documentElement.scrollWidth>innerWidth+2, readyState:document.readyState })',
        executionContextId, candidate.sessionId);
      const current = await this.previewOwner();
      if (!candidate.attached || current?.backendNodeId !== owner.backendNodeId || current?.frameId !== owner.frameId) {
        this.lastPreview.state = 'Preview owner replaced during DOM read';
        return null;
      }
      this.lastPreview.headingState = preview.heading === undefined ? 'absent' :
        preview.heading === 'Smoke updated heading' ? 'expected' :
        preview.heading === 'Sample card one' ? 'original' : 'different';
      this.lastPreview.headingLength = preview.heading?.length ?? 0;
      this.lastPreview.readyState = preview.readyState;
      return preview;
    } catch (error) {
      this.lastPreview.error = brief(error);
      // React recreates the iframe. Retry only known stale node/frame/session/context races.
      if (this.frameRace(error)) return null;
      throw error;
    }
  }
  targetDiagnostics() {
    return Array.from(this.sessions.values(), entry => ({
      type: entry.type, targetId: entry.targetId, sessionId: entry.sessionId,
      parentSession: entry.parentSession, attached: entry.attached, ready: entry.ready,
      ...(entry.error ? { error: entry.error } : {}),
    }));
  }
  async diagnostics() {
    return { focus: await this.focusState(), targets: this.targetDiagnostics(), preview: this.lastPreview ?? null,
      editor: await this.fn(() => {
        const input = document.querySelector('input[aria-label="Заголовок"]');
        return { headingInputPresent: Boolean(input), headingLength: input?.value.length ?? 0,
          headingMatchesExpected: input?.value === 'Smoke updated heading',
          iframes: Array.from(document.querySelectorAll('iframe')).map(el => ({
            title: el.title, srcdoc: el.hasAttribute('srcdoc'), sandbox: el.getAttribute('sandbox'),
            srcdocHasExpectedHeading: el.srcdoc.includes('Smoke updated heading'),
            srcdocHasOriginalHeading: el.srcdoc.includes('Sample card one'),
          })) };
      }) };
  }
  healthy() {
    assert.deepEqual(this.errors, [], 'Critical browser JS/console errors');
    assert.deepEqual(this.failures, [], 'Failed local application requests');
    assert.deepEqual(this.protocolErrors, [], 'CDP interception errors');
  }
  async dispose() {
    this.closed = true; this.removeListener(); pages.delete(this);
    await protocol.send('Target.disposeBrowserContext', { browserContextId: this.context });
  }
}

function observeWorkers() {
  const NativeWorker = window.Worker;
  window.__optimaSmokeWorkers = [];
  window.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      if (!String(url).includes('optima-avif')) return;
      const record = { sent: [], received: [] };
      window.__optimaSmokeWorkers.push(record);
      const originalPost = this.postMessage;
      this.postMessage = function (message, ...rest) {
        record.sent.push({ kind: message.kind, requestId: message.requestId, quality: message.quality,
          width: message.width, height: message.height });
        return originalPost.call(this, message, ...rest);
      };
      this.addEventListener('message', event => {
        record.received.push({ kind: event.data.kind, requestId: event.data.requestId,
          bytes: event.data.buffer?.byteLength ?? 0 });
      });
    }
  };
}

function analyticsProbe() {
  const state = window.__optimaSmokeAnalytics = { init: 0, destruct: 0, probeAttempts: 0 };
  let active = false;
  const ping = () => {
    if (!active) return;
    state.probeAttempts++;
    void fetch('https://mc.yandex.ru/__optima_smoke_probe__', {
      mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer',
    }).catch(() => {});
  };
  window.ym = (_id, method) => {
    if (method === 'init') {
      state.init++; active = true; document.addEventListener('click', ping); ping();
    } else if (method === 'destruct') {
      state.destruct++; active = false; document.removeEventListener('click', ping);
    }
  };
}

async function newPage({ analytics = false, workers = false } = {}) {
  const { browserContextId } = await protocol.send('Target.createBrowserContext', { disposeOnDetach: true });
  const { targetId } = await protocol.send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await protocol.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(browserContextId, targetId, sessionId, analytics);
  pages.add(page);
  for (const method of ['Runtime.enable', 'Page.enable', 'Network.enable', 'DOM.enable']) await page.send(method);
  await page.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  await page.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  if (workers) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: '(' + observeWorkers.toString() + ')();' });
  await protocol.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName', browserContextId, downloadPath: join(temporary, 'downloads'), eventsEnabled: true,
  });
  return page;
}

async function checkHelp(page, retained = null) {
  step('instruction / FAQ / Escape / X');
  const trigger = 'nav[aria-label="Сервисы Tinymods"] [aria-label="Справка текущего инструмента"] button:first-child';
  await page.click(trigger);
  await page.wait(() => Boolean(document.querySelector('dialog#service-help-panel[open]')), 'instruction drawer');
  const initialFocus = await page.focusState();
  assert.equal(initialFocus.first && initialFocus.ariaLabel === 'Закрыть справку', true,
    'Drawer initially focuses close control: ' + JSON.stringify(initialFocus));
  // CDP modifiers: Alt=1, Ctrl=2, Meta=4, Shift=8.
  await page.key('Tab', 8);
  const backwardFocus = await page.focusState();
  assert.equal(backwardFocus.inside && backwardFocus.last, true,
    'Shift-Tab wraps to last control: ' + JSON.stringify(backwardFocus));
  await page.key('Tab');
  const forwardFocus = await page.focusState();
  assert.equal(forwardFocus.first && forwardFocus.ariaLabel === 'Закрыть справку', true,
    'Tab wraps to first control: ' + JSON.stringify(forwardFocus));
  await page.clickText('Вопрос-ответ', 'document.querySelector("#service-help-panel")');
  await page.wait(() => document.querySelector('#service-help-panel h2')?.textContent === 'Вопрос-ответ' &&
    document.querySelectorAll('#service-help-panel details').length > 0, 'FAQ contents');
  await page.key('Escape');
  await page.wait(() => !document.querySelector('dialog#service-help-panel[open]'), 'Escape closes drawer');
  assert.equal(await page.fn(selector => document.activeElement === document.querySelector(selector), trigger), true, 'Focus returns to trigger');
  await page.click(trigger);
  await page.wait(() => Boolean(document.querySelector('dialog#service-help-panel[open]')), 'reopen help');
  await page.click('#service-help-panel button[aria-label="Закрыть справку"]');
  await page.wait(() => !document.querySelector('dialog#service-help-panel[open]'), 'X closes drawer');
  assert.equal(await page.fn(selector => document.activeElement === document.querySelector(selector), trigger), true, 'X returns focus');
  if (retained) assert.equal(await page.fn(selector => document.querySelector(selector)?.value, retained.selector), retained.value, 'Help preserves input state');
}

async function checkFooterAndBanner(page, theme) {
  step('shared footer and neutral cookie geometry / ' + theme);
  const widths = [320, 390, 479, 480, 639, 640, 959, 960, 1199, 1200, 1439, 1440, 1919, 1920, 2559, 2560];
  await page.wait(() => document.querySelectorAll('.cookie-consent').length === 1, 'one shared cookie banner');
  await page.fn(async () => { await document.fonts.ready; });
  for (const width of widths) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    const ui = await page.fn(async () => {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const footer = document.querySelector('[data-tinymods-footer]');
      const banner = document.querySelector('.cookie-consent');
      const image = footer.querySelector('img');
      const r = footer.getBoundingClientRect(), ir = image.getBoundingClientRect(), b = banner.getBoundingClientRect();
      const primary = banner.querySelector('.is-primary'), secondary = banner.querySelector('.cookie-consent-actions button:not(.is-primary)');
      const close = banner.querySelector('.cookie-consent-close').getBoundingClientRect();
      const title = banner.querySelector('strong').getBoundingClientRect();
      return { count: document.querySelectorAll('[data-tinymods-footer]').length,
        theme: footer.dataset.tinymodsFooter, accent: getComputedStyle(footer).getPropertyValue('--ui-accent').trim(),
        overflow: document.documentElement.scrollWidth > innerWidth + 2 || footer.scrollWidth > footer.clientWidth + 2,
        footerFits: r.left >= -2 && r.right <= innerWidth + 2,
        logoFits: ir.width > 0 && ir.left >= r.left - 2 && ir.right <= r.right + 2,
        logoRatio: ir.width / ir.height, logoSrc: image.getAttribute('src'),
        bannerFits: b.left >= -2 && b.right <= innerWidth + 2 && banner.scrollWidth <= banner.clientWidth + 2,
        closeOverlapsTitle: close.left < title.right && close.right > title.left && close.top < title.bottom && close.bottom > title.top,
        background: getComputedStyle(banner).backgroundColor,
        headingColor: getComputedStyle(banner.querySelector('strong')).color,
        primaryBackground: getComputedStyle(primary).backgroundColor, primaryColor: getComputedStyle(primary).color,
        secondaryBackground: getComputedStyle(secondary).backgroundColor,
        iconAbsent: !banner.querySelector('.cookie-consent-mark'),
        vk: footer.querySelector('.footer-contact a').textContent.trim(), copyright: footer.querySelector('.footer-copyright').textContent.trim() };
    });
    assert.equal(ui.count, 1, 'one footer at ' + width);
    assert.equal(ui.theme, theme);
    assert.equal(ui.accent.toLowerCase(), theme === 'editor' ? '#5b7cfa' : '#3f7847');
    assert.equal(ui.overflow, false, theme + ' no horizontal overflow at ' + width);
    assert.equal(ui.footerFits && ui.logoFits && ui.bannerFits, true, theme + ' footer/banner fit at ' + width);
    assert.equal(ui.closeOverlapsTitle, false, 'close does not overlap title at ' + width);
    assert.ok(Math.abs(ui.logoRatio - 1997 / 385) < .02, 'author SVG proportions at ' + width);
    assert.equal(ui.logoSrc, '/brand/tinymods-logo.svg?v=1a069a98abb4');
    assert.equal(ui.background, 'rgb(255, 255, 255)');
    assert.equal(ui.headingColor, 'rgb(37, 41, 43)');
    assert.equal(ui.primaryBackground, 'rgb(52, 57, 60)');
    assert.equal(ui.primaryColor, 'rgb(255, 255, 255)');
    assert.equal(ui.secondaryBackground, 'rgb(255, 255, 255)');
    assert.equal(ui.iconAbsent, true);
    assert.equal(ui.vk, 'Напишите в ВК');
    assert.equal(ui.copyright, '© 2026 Tinymods. Сервис, дизайн и материалы защищены авторским правом.');
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.fn(() => scrollTo({ top: 0, behavior: 'instant' }));
  console.log('Footer/banner geometry and computed colors PASS: ' + theme + ' at ' + widths.join('/'));
}

async function checkFooterSettings(page) {
  await page.click('[data-tinymods-footer] .cookie-settings-button');
  await page.wait(() => document.querySelectorAll('.cookie-consent').length === 1, 'footer opens the single cookie banner');
  await page.click('.cookie-consent-close');
  await page.wait(() => !document.querySelector('.cookie-consent'), 'cookie close preserves saved choice');
  await page.fn(() => scrollTo({ top: 0, behavior: 'instant' }));
}

async function imageScenario(page) {
  await page.navigate('/');
  await page.wait(() => Boolean(document.querySelector('.dropzone')), 'Optimizer upload UI');
  await page.wait(() => Boolean(document.querySelector('.cookie-consent')), 'fresh consent UI');
  await checkFooterAndBanner(page, 'optima');
  await page.clickText('Только необходимые', 'document.querySelector(".cookie-consent")');
  await page.wait(() => !document.querySelector('.cookie-consent'), 'dismiss banner via necessary choice');
  await checkFooterSettings(page);
  // Native browser Canvas makes the synthetic input JPEG; it is never an output substitute.
  const jpeg = await page.fn(() => {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 192;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 256, 192);
    gradient.addColorStop(0, '#164c38'); gradient.addColorStop(1, '#eeaa77');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 256, 192);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(40, 40, 70, 90);
    return canvas.toDataURL('image/jpeg', .9).split(',')[1];
  });
  const bytes = Buffer.from(jpeg, 'base64');
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'ffd8ff', 'Synthetic input is JPEG');
  const inputPath = join(temporary, 'synthetic.jpg'); await writeFile(inputPath, bytes);
  step('native file input upload');
  const { root } = await page.send('DOM.getDocument');
  const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"]' });
  assert.ok(nodeId, 'Native file input exists');
  await page.send('DOM.setFileInputFiles', { nodeId, files: [inputPath] });
  await page.wait(() => Boolean(document.querySelector('.crop-stage img')?.naturalWidth), 'uploaded image decoded');
  assert.equal(await page.fn(() => document.querySelector('.crop-stage img').naturalWidth), 256);
  step('Photo / available custom target 192px / Q65');
  if (!await page.fn(() => document.querySelector('input[name="optimization-mode"][value="photo"]')?.checked)) {
    await page.clickExpression('document.querySelector(\'input[name="optimization-mode"][value="photo"]\').closest("label")');
  }
  const widthSelector = 'input[aria-label="Нужная ширина файла в пикселях"]';
  assert.ok(Number(await page.fn(s => document.querySelector(s).max, widthSelector)) <= 256, 'No upscale offered');
  await page.fill(widthSelector, '192');
  await page.click('[data-quality-tier="q65"]');
  assert.equal(await page.fn(() => document.querySelector('[data-quality-tier="q65"]').getAttribute('aria-pressed')), 'true');
  await checkHelp(page, { selector: widthSelector, value: '192' });
  assert.equal(await page.fn(() => window.__optimaSmokeWorkers.flatMap(w => w.sent).filter(m => m.kind === 'encode').length), 0,
    'Changing quality/settings does not encode');
  step('Optimize and wait for real AVIF/WebP');
  await page.click('.batch-action-grid .primary-button');
  await page.wait(() => {
    const error = document.querySelector('.error-message');
    if (error?.textContent) throw Error('Optimizer error: ' + error.textContent);
    return document.querySelectorAll('.format-result-row').length === 2;
  }, 'two Photo formats', 45_000);
  const formats = await page.fn(() => Array.from(document.querySelectorAll('.format-result-row')).map(row => ({
    text: row.querySelector('span strong')?.textContent,
    label: row.querySelector('input').getAttribute('aria-label'),
    checked: row.querySelector('input').checked,
  })));
  assert.deepEqual(formats.map(f => f.text).sort(), ['AVIF', 'WEBP']);
  for (const f of formats) assert.ok(f.label.includes('192×144'), 'Result dimensions match selected target, without upscaling');
  assert.equal(await page.fn(() => document.querySelector('.result-quality')?.textContent), 'Q65');
  for (const format of ['WEBP', 'AVIF']) {
    const selector = '.format-result-row input[aria-label^="Выбрать ' + format + ' "]';
    const before = await page.fn(s => document.querySelector(s).checked, selector);
    await page.clickExpression('document.querySelector(' + JSON.stringify(selector) + ').closest("label")');
    await page.wait(() => document.querySelectorAll('.format-result-row').length === 2, 'results retained after format selection');
    assert.equal(await page.fn(s => document.querySelector(s).checked, selector), !before);
  }
  // Select AVIF alone through the actual checkbox handlers.
  for (const format of ['AVIF', 'WEBP']) {
    const selector = '.format-result-row input[aria-label^="Выбрать ' + format + ' "]';
    if (await page.fn(s => document.querySelector(s).checked, selector) !== (format === 'AVIF')) {
      await page.clickExpression('document.querySelector(' + JSON.stringify(selector) + ').closest("label")');
    }
  }
  const worker = await page.fn(() => window.__optimaSmokeWorkers);
  const sent = worker.flatMap(w => w.sent).filter(m => m.kind === 'encode');
  const completed = worker.flatMap(w => w.received).filter(m => m.kind === 'result' && m.bytes > 0);
  assert.equal(sent.length, 1, 'One real AVIF Worker encode, no benchmark');
  assert.equal(sent[0].quality, 65); assert.equal(sent[0].width, 192); assert.equal(sent[0].height, 144);
  assert.ok(completed.some(m => m.requestId === sent[0].requestId), 'Native Worker returned encoded bytes');
  assert.ok(page.workerTargets.some(t => t.type === 'worker'), 'CDP observed DedicatedWorker');
  step('real AVIF download / signature / decode');
  await page.click('.result-download-button');
  const download = await until(() => [...page.downloads.values()].find(d => d.state === 'completed'), 'download complete', 15_000);
  assert.ok(download.suggestedFilename.endsWith('.avif'), 'AVIF download filename');
  const output = await readFile(join(temporary, 'downloads', download.guid));
  assert.equal(output.subarray(4, 8).toString('ascii'), 'ftyp', 'ISO BMFF signature');
  const ftypSize = output.readUInt32BE(0);
  assert.ok(ftypSize >= 16 && ftypSize <= output.length, 'Valid ftyp box');
  const brands = [];
  for (let offset = 8; offset + 4 <= ftypSize; offset += 4) if (offset !== 12) brands.push(output.subarray(offset, offset + 4).toString('ascii'));
  assert.ok(brands.includes('avif') || brands.includes('avis'), 'AVIF brand, not Blob.type');
  const decoded = await page.fn(async base64 => {
    const blob = await (await fetch('data:application/octet-stream;base64,' + base64)).blob();
    const bitmap = await createImageBitmap(blob);
    const value = { width: bitmap.width, height: bitmap.height }; bitmap.close(); return value;
  }, output.toString('base64'));
  assert.deepEqual(decoded, { width: 192, height: 144 });
  page.healthy();
  return { jpegBytes: bytes.length, avifBytes: output.length, dimensions: decoded, workerRequests: sent.length,
    dedicatedWorkerTargets: page.workerTargets.length };
}

async function editorScenario(page) {
  await page.navigate('/html-content-editor/');
  await page.wait(() => Boolean(document.querySelector('#block-1-fragment-1')), 'Editor code input');
  await checkFooterAndBanner(page, 'editor');
  await page.clickText('Только необходимые', 'document.querySelector(".cookie-consent")');
  await page.wait(() => !document.querySelector('.cookie-consent'), 'Editor necessary choice');
  await checkFooterSettings(page);
  assert.equal(await page.fn(() => Array.from(document.querySelectorAll('label,button,h2,h3')).some(el => /^(Проект|Проекты|Сохранить проект|Восстановить проект)$/i.test(el.textContent.trim()))), false);
  const fixture = await readFile('tests/fixtures/html-content-editor/responsive-slider.html', 'utf8');
  const article = fixture.match(/<article\b[\s\S]*?<\/article>/)?.[0];
  assert.ok(article?.includes('<h2>Sample card one</h2>'), 'Existing synthetic fixture structure');
  const pixel = await page.fn(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    return canvas.toDataURL('image/png');
  });
  const source = '<!-- smoke-preserve -->\n<section id="smoke-block">' + article +
    '<a href="/privacy/">Smoke link</a><img alt="Smoke pixel" src="' + pixel + '"></section>';
  step('load existing synthetic HTML fixture through UI');
  await page.fill('#block-1-fragment-1', source);
  await page.clickText('Загрузить код', 'document.querySelector("section[aria-label=\\"Загрузка кода\\"]")');
  await page.wait(() => Boolean(document.querySelector('input[aria-label="Заголовок"]')), 'Content heading input');
  const headingSelector = 'input[aria-label="Заголовок"]';
  await page.fill(headingSelector, 'Smoke updated heading');
  step('verify edited text inside real sandboxed Preview');
  await until(async () => (await page.frameHeading())?.heading === 'Smoke updated heading', 'Preview shows edited heading');
  for (const width of [390, 1440]) {
    await page.clickExpression('Array.from(document.querySelectorAll("[aria-label=\\"Размер предпросмотра\\"] button")).find(el => el.querySelector("small")?.textContent === ' + JSON.stringify(String(width)) + ')');
    await until(async () => {
      const preview = await page.frameHeading();
      return preview?.width === width && preview.heading === 'Smoke updated heading' && !preview.overflow;
    }, 'Preview width ' + width + ' without horizontal overflow');
    assert.equal(await page.fn(() => document.documentElement.scrollWidth <= innerWidth + 2), true, 'Editor page has no horizontal overflow');
  }
  step('copy edited block and read native clipboard');
  await protocol.send('Browser.grantPermissions', {
    browserContextId: page.context, origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
  });
  await page.clickText('СКОПИРОВАТЬ КОД БЛОКА');
  const copied = await until(async () => {
    const text = await page.evaluate('navigator.clipboard.readText()');
    return text.includes('Smoke updated heading') ? text : null;
  }, 'clipboard contains exported heading');
  assert.ok(copied === source.replace('Sample card one', 'Smoke updated heading'),
    'Copied HTML preserves all unchanged source; actual length=' + copied.length);
  assert.ok(!/data-tinymods|installPreview|preview-controls/.test(copied), 'Export contains no Preview service controls');
  await checkHelp(page, { selector: headingSelector, value: 'Smoke updated heading' });
  const canonical = await page.fn(() => document.querySelector('link[rel="canonical"]')?.href);
  assert.match(canonical, /^https:\/\/tinymods\.ru\/html-content-editor\/?$/);
  page.healthy();
  return { previewWidths: [390, 1440], clipboardCharacters: copied.length, canonical };
}

async function shellScenario(page) {
  await page.navigate('/');
  await page.wait(() => Boolean(document.querySelector('.dropzone')), 'Optimizer hydrated');
  await page.wait(() => Boolean(document.querySelector('.cookie-consent')), 'fresh Shell consent UI');
  await page.clickText('Только необходимые', 'document.querySelector(".cookie-consent")');
  await page.wait(() => !document.querySelector('.cookie-consent'), 'Shell banner dismissed');
  await page.click('nav[aria-label="Сервисы Tinymods"] a[href^="/html-content-editor"]');
  await page.wait(() => location.pathname.replace(/\/$/, '') === '/html-content-editor' &&
    Boolean(document.querySelector('#block-1-fragment-1')), 'client navigation to Editor');
  await checkHelp(page);
  await page.click('nav[aria-label="Сервисы Tinymods"] a[href="/"]:not([aria-label])');
  await page.wait(() => location.pathname === '/' && Boolean(document.querySelector('.dropzone')), 'client navigation back to Optimizer');
  await checkHelp(page);
  page.healthy();
  return { transitions: 2, helpOnBothServices: true };
}

async function consentScenario(page) {
  await page.navigate('/privacy/');
  await page.wait(() => Boolean(document.querySelector('.cookie-consent')), 'first visit consent banner');
  await page.click('h1');
  assert.equal(page.external.length, 0, 'No analytic request attempts before consent');
  step('necessary only');
  await page.clickText('Только необходимые', 'document.querySelector(".cookie-consent")');
  await page.wait(() => !document.querySelector('.cookie-consent'), 'necessary choice closes banner');
  await page.click('h1');
  assert.equal(page.external.length, 0, 'No analytic attempts after refusal');
  step('grant with locally fulfilled probe SDK');
  page.phase = 'grant';
  await page.click('.cookie-settings-button');
  await page.clickText('Разрешить аналитику', 'document.querySelector(".cookie-consent")');
  await page.wait(() => window.__optimaSmokeAnalytics?.init === 1, 'probe init after grant');
  await until(() => page.external.some(r => r.url.endsWith('/__optima_smoke_probe__') && r.outcome === 'cancelled-before-send'), 'probe attempt observed and cancelled');
  step('withdraw through UI; subsequent probe requests must stop');
  await page.click('.cookie-settings-button');
  await page.clickText('Только необходимые', 'document.querySelector(".cookie-consent")');
  await page.wait(() => window.__optimaSmokeAnalytics?.destruct === 1, 'destruct called on withdrawal');
  const expectedAttempts = await page.fn(() => window.__optimaSmokeAnalytics.probeAttempts);
  await until(() => page.external.filter(r => r.url.endsWith('/__optima_smoke_probe__')).length === expectedAttempts &&
    page.external.every(r => r.outcome !== 'paused'), 'all initiated pre-withdrawal requests intercepted');
  page.phase = 'after-withdrawal';
  const before = page.external.length;
  for (let i = 0; i < 3; i++) {
    await page.click('.cookie-settings-button');
    await page.click('.cookie-consent-close');
  }
  await delay(500); // Bounded observation window for the synchronous controlled probe.
  assert.equal(page.external.length, before, 'No new attempts after probe destruct; cancelled requests are NOT treated as absent attempts');
  assert.equal(page.external.filter(r => r.outcome === 'fulfilled-locally').length, 1, 'One local SDK fulfillment');
  assert.ok(page.external.every(r => ['fulfilled-locally', 'cancelled-before-send'].includes(r.outcome)), 'No external request continued');
  const cancelled = page.external.filter(r => r.outcome === 'cancelled-before-send').length;
  page.healthy();
  return { sdk: 'controlled local probe, NOT real Yandex SDK', attempts: page.external.length,
    fulfilledLocally: 1, cancelledBeforeSend: cancelled, continuedExternally: 0, attemptsAfterWithdrawal: 0 };
}

async function runCase(name, body, options = {}) {
  const before = Date.now();
  let page;
  try {
    page = await newPage(options);
    const details = await body(page);
    results.push({ name, status: 'PASS', milliseconds: Date.now() - before, details });
  } catch (error) {
    const diagnostics = { step: activeStep, error: brief(error), consoleErrors: page?.errors ?? [],
      localNetworkErrors: page?.failures ?? [], interceptionErrors: page?.protocolErrors ?? [],
      ui: page ? await page.diagnostics().catch(error => ({ error: brief(error) })) : null };
    results.push({ name, status: 'FAIL', diagnostics });
    console.error('FAIL ' + name + ': ' + JSON.stringify(diagnostics));
  } finally {
    if (page) await page.dispose().catch(error => {
      results.push({ name: name + ' context cleanup', status: 'FAIL', diagnostics: { error: brief(error) } });
    });
  }
}

const mime = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2' };
async function startServer() {
  const root = resolve('out');
  await access(join(root, 'index.html'));
  server = createServer(async (request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let file = resolve(root, '.' + path);
      if (!file.startsWith(root + sep) && file !== root) throw Error('path outside export');
      let info;
      try { info = await stat(file); }
      catch (error) {
        // Next static-export RSC requests may use /route.txt or /route/index.txt.
        if (!file.endsWith('.txt')) throw error;
        file = join(file.slice(0, -4), 'index.txt'); info = await stat(file);
      }
      if (info.isDirectory()) {
        file = join(file, request.headers.rsc === '1' ? 'index.txt' : 'index.html');
        info = await stat(file);
      }
      if (!info.isFile()) throw Error('not a file');
      response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
        'Content-Length': info.size, 'Cache-Control': 'no-store' });
      if (request.method === 'HEAD') response.end();
      else createReadStream(file).on('error', () => response.destroy()).pipe(response);
    } catch { response.writeHead(404, { 'Content-Type': 'text/plain' }); response.end('Not found'); }
  });
  server.requestTimeout = 5000; server.keepAliveTimeout = 1000;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = 'http://127.0.0.1:' + server.address().port;
}

async function startChrome() {
  const candidates = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
  let executable;
  for (const file of candidates) { try { await access(file); executable = file; break; } catch {} }
  assert.ok(executable, 'Installed Google Chrome not found; no installation will be attempted');
  const profile = join(temporary, 'profile');
  let launchError;
  browser = spawn(executable, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions',
    '--disable-breakpad', '--disable-crash-reporter',
    '--no-first-run', '--no-default-browser-check', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  browser.on('error', error => { launchError = error; });
  let stderr = '';
  browser.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  const portFile = await until(async () => {
    if (launchError) throw launchError;
    if (browser.exitCode !== null) throw Error('Chrome exited: ' + browser.exitCode + '; ' + stderr.slice(-800));
    try { return await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); } catch { return null; }
  }, 'Chrome local CDP endpoint', 15_000);
  const [port, path] = portFile.trim().split('\n');
  assert.match(port, /^\d+$/); assert.ok(path.startsWith('/devtools/browser/'));
  protocol = await CDP.connect('ws://127.0.0.1:' + port + path);
  const version = await protocol.send('Browser.getVersion');
  console.log('Browser: ' + version.product + '; Node: ' + process.version + '; OS: ' + process.platform);
}

async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (protocol) await protocol.send('Browser.close', {}, undefined, 1500).catch(() => {});
    if (browser?.pid) {
      // The detached Linux process group belongs exclusively to this spawned Chrome.
      const signalGroup = signal => {
        try { process.kill(-browser.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      };
      signalGroup('SIGTERM');
      if (browser.exitCode === null && browser.signalCode === null) {
        await Promise.race([once(browser, 'exit').catch(() => {}), delay(2000)]);
      }
      signalGroup('SIGKILL'); // Also remove any surviving children of our own group.
      if (browser.exitCode === null && browser.signalCode === null) {
        await Promise.race([once(browser, 'exit').catch(() => {}), delay(1000)]);
      }
    }
    for (const page of pages) { page.closed = true; page.removeListener(); }
    pages.clear();
    protocol?.socket.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    if (temporary) {
      assert.ok(basename(temporary).startsWith('optima-browser-smoke-') && dirname(temporary) === resolve(tmpdir()));
      await rm(temporary, { recursive: true, force: true });
    }
  })();
  return cleanupPromise;
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'CI-only: do not execute this browser test on the local laptop');
  assert.equal(process.platform, 'linux', 'Use the Ubuntu GitHub runner');
  temporary = await mkdtemp(join(resolve(tmpdir()), 'optima-browser-smoke-'));
  await mkdir(join(temporary, 'downloads'));
  const timer = setTimeout(() => {
    console.error('FAIL whole browser smoke timeout: ' + JSON.stringify({ step: activeStep,
      consoleErrors: [...pages].flatMap(p => p.errors), localNetworkErrors: [...pages].flatMap(p => p.failures) }));
    void cleanup().finally(() => process.exit(1));
  }, LIMIT);
  const terminate = () => { void cleanup().finally(() => process.exit(1)); };
  process.once('SIGTERM', terminate); process.once('SIGINT', terminate);
  try {
    await startServer(); await startChrome();
    await runCase('Image Optimizer: JPEG/Q65/AVIF/Worker/download', imageScenario, { workers: true });
    await runCase('HTML Editor: load/edit/Preview/clipboard', editorScenario);
    await runCase('Shell navigation and help', shellScenario);
    await runCase('Consent UI with intercepted local probe SDK', consentScenario, { analytics: true });
    results.push({ name: 'Browser AVIF fallback fault injection', status: 'NOT TESTED',
      reason: 'No Worker fault injection; existing Node fallback tests remain unchanged.' });
    results.push({ name: 'Real Yandex SDK post-withdrawal network behavior', status: 'NOT TESTED',
      reason: 'Only local probe SDK is fulfilled. A separate controlled real-SDK interception scenario is still required.' });
  } finally {
    await cleanup();
    clearTimeout(timer); process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', terminate);
  }
  console.log(JSON.stringify({ browserSmoke: results }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = ['\n## Browser smoke (Chrome / CDP)\n', '| Scenario | Result |', '|---|---|',
      ...results.map(r => '| ' + r.name + ' | ' + r.status + ' |'),
      '\nPASS applies only to the named assertions. Real Yandex SDK revocation and browser fallback are NOT TESTED. No screenshots, HTML or downloads are uploaded.\n'];
    await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
  }
  assert.ok(results.filter(r => r.status === 'PASS').length === 4 && !results.some(r => r.status === 'FAIL'),
    'Mandatory browser smoke scenarios did not all pass');
}

main().catch(error => { console.error('Browser smoke failed at ' + activeStep + ': ' + brief(error)); process.exitCode = 1; });
