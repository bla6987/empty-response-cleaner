const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const source = readFileSync(require('node:path').join(__dirname, '..', 'index.js'), 'utf8');
const endpoint = '/api/backends/chat-completions/generate';

function setup({ autoDelete = true, maxRetries = 3, streaming = false } = {}) {
    const timers = new Map();
    const calls = [];
    const warnings = [];
    const delays = [];
    const deletions = [];
    const clock = { now: 1_000_000 };
    let timerId = 0;
    let nextResponse = 'empty';
    const message = {
        is_user: false, mes: 'Original answer', swipe_id: 1,
        swipes: ['Original answer'], swipe_info: [{ extra: { model: 'original' } }],
    };
    const context = {
        chatId: 'chat', characterId: 1, chat: [{ is_user: true, mes: 'Hi' }, message],
        extensionSettings: { 'empty-response-cleaner': {
            enabled: true, retryOnApiError: true, autoDelete, maxRetries, retryDelayMs: 250,
        } },
        eventSource: { removeListener() {} }, event_types: {},
        deleteMessage: async (id, swipeId) => {
            deletions.push({ id, swipeId });
            if (swipeId === undefined) { context.chat.splice(id, 1); return; }
            const item = context.chat[id];
            item.swipes.splice(swipeId, 1);
            item.swipe_info.splice(swipeId, 1);
            if (swipeId < item.swipe_id) item.swipe_id--;
            else if (swipeId === item.swipe_id) {
                item.swipe_id = Math.min(swipeId, item.swipes.length - 1);
                item.mes = item.swipes[item.swipe_id];
            }
        },
    };
    const document = { body: { dataset: {} } };
    class FakeDate extends Date { static now() { return clock.now; } }
    const sandbox = vm.createContext({
        SillyTavern: { getContext: () => context }, jQuery: () => {}, console, URL, Response, TextDecoder,
        window: { location: { href: 'http://localhost:8000/' } }, document, Date: FakeDate,
        requestAnimationFrame: callback => callback(),
        fetch: async () => nextResponse === 'error'
            ? Response.json({ error: { message: '<none>' } })
            : nextResponse === 'permanent'
                ? Response.json({ error: { message: 'invalid API key' } }, { status: 401 })
                : nextResponse === 'stream'
                    ? new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })
                    : Response.json({ choices: [{ message: { content: nextResponse === 'empty' ? '' : nextResponse } }] }),
        toastr: { info() {}, warning: text => warnings.push(text) },
        setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
        clearTimeout: id => timers.delete(id),
    });
    const run = code => vm.runInContext(code, sandbox);
    vm.runInContext(source, sandbox);
    run('installFetchInterceptor()');
    const request = async (response = 'empty') => {
        nextResponse = response;
        return sandbox.fetch(endpoint, { body: JSON.stringify({ stream: streaming, type: 'swipe' }) });
    };
    // Reproduce ST's render-before-swipes[]-write ordering, and overwrite at
    // swipe_id just like saveReply. A retry at an old ID would corrupt the reply.
    const render = (text = '', { type = 'swipe', duplicate = false } = {}) => {
        message.swipes.length++;
        message.mes = text;
        run(`onCharacterMessageRendered(1, ${JSON.stringify(type)})`);
        if (duplicate) run(`onCharacterMessageRendered(1, ${JSON.stringify(type)})`);
        message.swipes[message.swipe_id] = message.mes;
        message.swipe_info[message.swipe_id] = { extra: { model: 'retry' } };
    };
    context.generate = async (type, options) => {
        calls.push({ type, options, swipeId: message.swipe_id });
        run(`onGenerationStarted(${JSON.stringify(type)}, ${JSON.stringify(options)})`);
        await request('empty');
        render('');
    };
    return {
        run, context, message, document, timers, calls, warnings, delays, deletions, clock, request, render,
        settings: context.extensionSettings['empty-response-cleaner'],
        start: async (response = 'empty') => {
            run("onGenerationStarted('swipe', { custom: 'preserved', signal: {} })");
            await request(response);
        },
        fire: async () => {
            assert.ok(timers.size, 'expected a pending timer');
            const [id, { callback, delay }] = [...timers][0];
            timers.delete(id);
            clock.now += delay;
            delays.push(delay);
            await callback();
            for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
        },
        drain: async function () {
            for (let i = 0; timers.size; i++) {
                assert.ok(i < 40, 'retry must terminate');
                await this.fire();
            }
        },
    };
}

for (const text of ['', ' \n\t']) {
    test(`empty generated swipe retries without overwriting the original (${JSON.stringify(text)})`, async () => {
        const h = setup();
        await h.start();
        assert.equal(h.timers.size, 0, 'fetch success waits for the rendered swipe');
        h.render(text);
        await h.fire();
        assert.deepEqual(h.message.swipes, ['Original answer']);
        assert.equal(h.message.mes, 'Original answer');
        assert.deepEqual(h.message.swipe_info, [{ extra: { model: 'original' } }]);
        await h.fire();
        assert.equal(h.calls[0].type, 'swipe');
        assert.equal(h.calls[0].swipeId, 1, 'new slot selected before saveReply');
        assert.equal(h.calls[0].options.custom, 'preserved');
        assert.equal('signal' in h.calls[0].options, false);
        assert.equal(h.message.swipes[0], 'Original answer');
        assert.deepEqual(h.message.swipe_info[0], { extra: { model: 'original' } });
    });
}

test('repeated empty swipes exhaust the shared limit with exponential backoff', async () => {
    const h = setup();
    await h.start();
    h.render('', { duplicate: true });
    await h.drain();
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.delays.filter(delay => delay !== 50), [250, 500, 1000]);
    assert.deepEqual(h.message.swipes, ['Original answer']);
    assert.equal(h.message.swipe_id, 0);
    assert.equal(h.message.mes, 'Original answer');
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], /limit reached \(3\)/);
});

test('mixed API errors and empty swipes consume one budget; failed slots are restored', async () => {
    const h = setup();
    const responses = ['empty', 'error', 'empty'];
    h.context.generate = async type => {
        h.calls.push(type);
        h.run(`onGenerationStarted(${JSON.stringify(type)})`);
        const response = responses.shift();
        await h.request(response);
        if (response !== 'error') h.render('');
    };
    await h.start('error');
    await h.drain();
    assert.deepEqual(h.calls, ['swipe', 'swipe', 'swipe']);
    assert.deepEqual(h.delays.filter(delay => delay !== 50), [250, 500, 1000]);
    assert.deepEqual(h.message.swipes, ['Original answer']);
    assert.equal(h.message.swipe_id, 0);
    assert.equal(h.message.mes, 'Original answer');
});

test('a valid retry completes the chain and preserves original text and metadata', async () => {
    const h = setup();
    h.context.generate = async type => {
        h.calls.push(type);
        h.run(`onGenerationStarted(${JSON.stringify(type)})`);
        await h.request('New answer');
        assert.equal(h.run('retryState.attempts'), 1, 'HTTP success does not reset the swipe budget');
        h.render('New answer');
    };
    await h.start();
    h.render('');
    await h.drain();
    assert.deepEqual(h.calls, ['swipe']);
    assert.equal(h.run('retryState.attempts'), 0);
    assert.deepEqual(h.message.swipes, ['Original answer', 'New answer']);
    assert.equal(h.message.mes, 'New answer');
    assert.deepEqual(h.message.swipe_info[0], { extra: { model: 'original' } });
});

test('streamed empty text is evaluated at final render without consuming the SSE body', async () => {
    const h = setup({ streaming: true });
    await h.start('stream');
    assert.equal(h.timers.size, 0);
    h.render('');
    await h.fire();
    await h.fire();
    assert.equal(h.calls.length, 1);
    assert.equal(h.message.swipes[0], 'Original answer');
});

test('empty retries also work when automatic deletion is disabled', async () => {
    const h = setup({ autoDelete: false, maxRetries: 2 });
    await h.start();
    h.render('');
    await h.drain();
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0].swipeId, 2);
    assert.equal(h.calls[1].swipeId, 3);
    assert.deepEqual(h.deletions, []);
    assert.deepEqual(h.message.swipes, ['Original answer', '', '', '']);
    assert.equal(h.message.swipe_info[0].extra.model, 'original');
});

for (const phase of ['before cleanup', 'during retry delay']) {
    for (const action of ['onGenerationStopped()', 'onChatChangedForExtension()', "onGenerationStarted('normal')", 'cleanupExtension()']) {
        test(`${action} cancels empty retry ${phase}`, async () => {
            const h = setup();
            await h.start();
            h.render('');
            if (phase === 'during retry delay') await h.fire();
            h.run(action);
            await h.drain();
            assert.deepEqual(h.calls, []);
            assert.equal(h.message.swipes[0], 'Original answer');
        });
    }
}

for (const phase of ['before cleanup', 'during retry delay']) {
    test(`browsing a different swipe cancels empty retry ${phase}`, async () => {
        const h = setup();
        h.message.swipes.push('Other answer');
        h.message.swipe_id = 2;
        await h.start();
        h.render('');
        if (phase === 'during retry delay') await h.fire();
        h.message.swipe_id = 0;
        h.message.mes = 'Original answer';
        await h.drain();
        assert.deepEqual(h.calls, []);
        assert.equal(h.message.swipes[0], 'Original answer');
    });
}

for (const setting of ['enabled', 'retryOnApiError']) {
    test(`disabling ${setting} cancels the pending empty retry`, async () => {
        const h = setup();
        await h.start();
        h.render('');
        await h.fire();
        h.settings[setting] = false;
        await h.drain();
        assert.deepEqual(h.calls, []);
    });
}

test('zero retry limit still cleans the empty swipe', async () => {
    const h = setup({ maxRetries: 0 });
    await h.start();
    h.render('');
    await h.drain();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.message.swipes, ['Original answer']);
});

test('cleanup and retry wait for generation and swipe animation to finish', async () => {
    const h = setup();
    await h.start();
    h.render('');
    h.document.body.dataset.generating = 'true';
    await h.fire();
    assert.deepEqual(h.deletions, []);
    delete h.document.body.dataset.generating;
    h.document.body.dataset.swiping = 'true';
    await h.fire();
    assert.deepEqual(h.deletions, []);
    delete h.document.body.dataset.swiping;
    await h.fire();
    assert.equal(h.deletions.length, 1);
    await h.fire();
    assert.equal(h.calls.length, 1);
});

test('a reply arriving during the delay cancels empty retry', async () => {
    const h = setup();
    await h.start();
    h.render('');
    await h.fire();
    h.context.chat.push({ is_user: false, mes: 'Later reply' });
    await h.drain();
    assert.deepEqual(h.calls, []);
    assert.equal(h.context.chat.at(-1).mes, 'Later reply');
});

test('a late render after stop and an unrelated empty render never trigger retry', async () => {
    for (const stopped of [true, false]) {
        const h = setup();
        if (stopped) {
            await h.start();
            h.run('onGenerationStopped()');
        }
        h.render('');
        await h.drain();
        assert.deepEqual(h.calls, []);
    }
});

test('permanent API failure cannot be upgraded to an empty-swipe retry', async () => {
    const h = setup();
    await h.start('permanent');
    h.render('');
    await h.drain();
    assert.deepEqual(h.calls, []);
});

test('text stripped to empty by ST also retries, using rendered text as the result', async () => {
    const h = setup();
    await h.start('Text removed by an output filter');
    h.render('');
    await h.fire();
    await h.fire();
    assert.equal(h.calls.length, 1);
});

test('user navigation while asynchronous cleanup runs cancels retry', async () => {
    const h = setup();
    h.message.swipes.push('Other answer');
    h.message.swipe_id = 2;
    const deleteMessage = h.context.deleteMessage;
    h.context.deleteMessage = async (...args) => {
        await deleteMessage(...args);
        h.message.swipe_id = 0;
        h.message.mes = 'Original answer';
    };
    await h.start();
    h.render('');
    await h.drain();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.message.swipes, ['Original answer', 'Other answer']);
    assert.equal(h.message.mes, 'Original answer');
});

test('missing cleanup API fails safely without retrying or removing a saved answer', async () => {
    const h = setup();
    delete h.context.deleteMessage;
    await h.start();
    h.render('');
    await h.drain();
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.message.swipes, ['Original answer', '']);
    assert.deepEqual(h.message.swipe_info[0], { extra: { model: 'original' } });
});

test('empty-swipe completion gives up when the generation stays busy', async () => {
    const h = setup();
    await h.start();
    h.render('');
    h.document.body.dataset.generating = 'true';
    await h.fire();
    h.clock.now += 5 * 60_000;
    await h.fire();
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.calls, []);
    assert.equal(h.message.swipes[0], 'Original answer');
});

test('newly started manual swipes get a fresh budget after the prior limit is reached', async () => {
    const h = setup({ maxRetries: 1 });
    await h.start();
    h.render('');
    await h.drain();
    assert.equal(h.calls.length, 1);
    h.message.swipe_id = h.message.swipes.length;
    await h.start();
    h.render('');
    await h.drain();
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.message.swipes, ['Original answer']);
});

test('valid replies and other generation types do not retry historical empty swipes', async () => {
    for (const type of ['swipe', 'normal', 'continue', 'quiet']) {
        const h = setup();
        h.message.swipes = ['', 'Original answer'];
        h.message.swipe_id = 2;
        h.run(`onGenerationStarted(${JSON.stringify(type)})`);
        await h.request('Real answer');
        h.render(type === 'swipe' ? 'Real answer' : '', { type });
        await h.drain();
        assert.deepEqual(h.calls, []);
        assert.ok(h.message.swipes.includes('Original answer'));
    }
});

test('an older failed retry cannot roll back a newer foreground generation', async () => {
    const h = setup();
    let finishRetry;
    h.context.generate = async type => {
        h.calls.push(type);
        h.run(`onGenerationStarted(${JSON.stringify(type)})`);
        await h.request('error');
        h.run("onGenerationStarted('swipe')");
        assert.equal(h.run('retryState.attempts'), 0, 'new foreground generation starts a fresh budget');
        await new Promise(resolve => { finishRetry = resolve; });
    };
    await h.start();
    h.render('');
    await h.fire();
    const oldRetry = h.fire();
    for (let i = 0; !finishRetry; i++) {
        assert.ok(i < 10);
        await new Promise(resolve => setImmediate(resolve));
    }
    finishRetry();
    await oldRetry;
    assert.equal(h.message.swipe_id, 1, 'new generation still owns its pending swipe slot');
    assert.equal(h.message.swipes[0], 'Original answer');
    assert.equal(h.timers.size, 0);
});
