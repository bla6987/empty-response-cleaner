const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');

const source = readFileSync(require('node:path').join(__dirname, '..', 'index.js'), 'utf8');
const endpoint = '/api/backends/chat-completions/generate';

function setup(responseFactory) {
    const timers = new Map();
    const calls = [];
    let timerId = 0;
    const context = {
        chatId: 'chat', characterId: 1, chat: [{ is_user: false, mes: 'Original answer' }],
        extensionSettings: { 'empty-response-cleaner': {
            enabled: true, retryOnApiError: true, maxRetries: 3, retryDelayMs: 250,
        } },
        generate: async (type, options) => { calls.push({ type, options }); },
    };
    const sandbox = vm.createContext({
        SillyTavern: { getContext: () => context },
        jQuery: () => {}, console, URL, Response,
        window: { location: { href: 'http://localhost:8000/' } },
        fetch: async () => responseFactory(),
        toastr: { info() {}, warning() {} },
        setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: (id) => timers.delete(id),
    });
    vm.runInContext(source, sandbox);
    vm.runInContext('installFetchInterceptor()', sandbox);
    return {
        context, calls, timers,
        run: (code) => vm.runInContext(code, sandbox),
        request: (stream = false) => sandbox.fetch(endpoint, { body: JSON.stringify({ stream }) }),
        fire: async () => {
            assert.equal(timers.size, 1);
            const [id, callback] = [...timers][0];
            timers.delete(id);
            await callback();
        },
    };
}

for (const stream of [false, true]) {
    test(`HTTP 200 <none> error retries a swipe (stream requested: ${stream})`, async () => {
        const payload = { error: { message: '<none>' }, quota_error: false };
        const h = setup(() => Response.json(payload));
        h.run("onGenerationStarted('swipe', { custom: 'preserved', signal: {} })");
        const response = await h.request(stream);
        assert.deepEqual(await response.json(), payload, 'original body remains readable');
        await h.fire();
        assert.equal(h.calls[0].type, 'swipe');
        assert.equal(h.calls[0].options.custom, 'preserved');
        assert.equal('signal' in h.calls[0].options, false);
    });
}

test('unspecified error forms retry, normal completions do not', async () => {
    for (const error of [true, {}, { message: '' }, { message: 'Unknown error occurred' }]) {
        const h = setup(() => Response.json({ error }));
        h.run("onGenerationStarted('swipe')");
        await h.request();
        assert.equal(h.timers.size, 1);
    }
    const h = setup(() => Response.json({ choices: [{ message: { content: 'hello' } }] }));
    h.run("onGenerationStarted('swipe')");
    await h.request();
    assert.equal(h.timers.size, 0);
});

test('permanent failures never retry, including masked statuses', async () => {
    for (const [status, payload] of [
        [401, { error: { message: '<none>' } }],
        [200, { error: { message: '<none>', status: 400 } }],
        [200, { error: { message: '<none>' }, quota_error: true }],
        [200, { error: { message: 'invalid API key' } }],
        [200, { error: { message: 'requires moderation' } }],
        [200, { error: { message: 'Unknown error', code: 403 } }],
    ]) {
        const h = setup(() => Response.json(payload, { status }));
        h.run("onGenerationStarted('swipe')");
        await h.request(true);
        assert.equal(h.timers.size, 0, JSON.stringify(payload));
    }
});

test('real SSE streams are returned without reading or cloning', async () => {
    const response = {
        ok: true, status: 200,
        headers: new Headers({ 'Content-Type': 'text/event-stream' }),
        clone() { throw new Error('must not clone streaming response'); },
    };
    const h = setup(() => response);
    h.run("onGenerationStarted('swipe')");
    assert.equal(await h.request(true), response);
    assert.equal(h.timers.size, 0);
});

test('stop, chat change, manual generation, and disabled retries prevent retry', async () => {
    for (const action of [
        "onGenerationStopped()", "onChatChangedForExtension()", "onGenerationStarted('normal')",
        "SillyTavern.getContext().extensionSettings['empty-response-cleaner'].retryOnApiError = false",
    ]) {
        const h = setup(() => Response.json({ error: { message: '<none>' } }));
        h.run("onGenerationStarted('swipe')");
        await h.request();
        h.run(action);
        if (h.timers.size) await h.fire();
        assert.equal(h.calls.length, 0);
    }
});

test('repeated unspecified failures exhaust the configured retry budget', async () => {
    const h = setup(() => Response.json({ error: { message: '<none>' } }));
    h.context.generate = async (type, options) => {
        h.calls.push(type);
        h.run(`onGenerationStarted(${JSON.stringify(type)})`);
        await h.request();
    };
    h.run("onGenerationStarted('swipe')");
    await h.request();
    for (let i = 0; i < 3; i++) await h.fire();
    assert.deepEqual(h.calls, ['swipe', 'swipe', 'swipe']);
    assert.equal(h.timers.size, 0);
});
