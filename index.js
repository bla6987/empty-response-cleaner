const extensionName = 'empty-response-cleaner';

// Default settings
const defaultSettings = {
    enabled: true,
    autoDelete: true,
    retryOnApiError: true,
    maxRetries: 3,
    retryDelayMs: 2000,
};

let isProcessing = false;
let lastScheduledCleanup = {
    messageIndex: null,
    at: 0,
};

// Module-level timer ID so we can clear any pending timer before scheduling a new one
let autoCleanupTimerId = null;

// Module-level event listener references so they can be removed later
let boundOnCharacterMessageRendered = null;
let boundOnMessageReceived = null;
let boundOnGenerationStarted = null;
let boundOnGenerateAfterData = null;
let boundOnGenerationStopped = null;
let boundOnChatChanged = null;
let usingCharacterMessageRenderedEvent = false;
let usingGenerateAfterDataEvent = false;

/**
 * Get extension settings from context
 * @returns {object} Extension settings object
 */
function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    return extensionSettings[extensionName];
}

/**
 * Initialize extension settings
 */
function loadSettings() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();

    if (!extensionSettings[extensionName]) {
        extensionSettings[extensionName] = {};
    }

    // Apply defaults for any missing settings
    for (const [key, value] of Object.entries(defaultSettings)) {
        if (extensionSettings[extensionName][key] === undefined) {
            extensionSettings[extensionName][key] = value;
        }
    }

    saveSettingsDebounced();
}

/**
 * Check if a swipe is empty (empty string or whitespace only)
 * @param {string} swipe - The swipe text to check
 * @returns {boolean} - True if the swipe is empty
 */
function isSwipeEmpty(swipe) {
    return !swipe || swipe.trim() === '';
}

const DEBUG = false;

function log(...args) {
    if (DEBUG) {
        console.debug(`[${extensionName}]`, ...args);
    }
}


const GENERATION_ENDPOINTS = new Set([
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/novelai/generate',
]);

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);
const FETCH_PATCH_KEY = '__empty_response_cleaner_fetch_patch__';
const MAX_BACKOFF_MS = 30_000;
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const RETRY_IDLE_POLL_MS = 500;
const RETRY_IDLE_MAX_WAIT_MS = 5 * 60_000;

let generationSequence = 0;
let generationEpoch = 0;
let generationStack = [];
let retryState = {
    attempts: 0,
    timerId: null,
    scheduledForGenerationId: null,
    chatKey: null,
    launching: false,
};

function clampNumber(value, min, max, fallback) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, numericValue));
}

function getMaxRetries() {
    return Math.round(clampNumber(getSettings()?.maxRetries, 0, 10, defaultSettings.maxRetries));
}

function getRetryDelayMs() {
    return Math.round(clampNumber(getSettings()?.retryDelayMs, 250, 60_000, defaultSettings.retryDelayMs));
}

function getCurrentChatKey() {
    const context = SillyTavern.getContext();
    const chatId = context.chatId ?? '';

    if (context.groupId !== undefined && context.groupId !== null) {
        return 'group:' + String(context.groupId) + ':' + String(chatId);
    }

    return 'character:' + String(context.characterId ?? '') + ':' + String(chatId);
}

function copyRetryOptions(options) {
    if (!options || typeof options !== 'object') {
        return {};
    }

    const retryOptions = { ...options };
    // Never reuse an AbortSignal from the failed request.
    delete retryOptions.signal;
    return retryOptions;
}

function isRetryableGenerationType(type) {
    return [undefined, null, 'normal', 'regenerate', 'swipe', 'continue', 'impersonate'].includes(type);
}

function cancelPendingRetry(resetAttempts = false) {
    if (resetAttempts) {
        // Invalidate results from requests that have already left the stack.
        generationEpoch++;
    }
    if (retryState.timerId !== null) {
        clearTimeout(retryState.timerId);
        retryState.timerId = null;
    }

    retryState.scheduledForGenerationId = null;

    if (resetAttempts) {
        retryState.attempts = 0;
        retryState.chatKey = null;
    }
}

function onGenerationStarted(type, options = {}, dryRun = false) {
    if (dryRun) {
        return;
    }

    const normalizedType = type ?? 'normal';
    const generation = {
        id: ++generationSequence,
        type: normalizedType,
        options: copyRetryOptions(options),
        chatKey: getCurrentChatKey(),
        retryable: isRetryableGenerationType(type) && normalizedType !== 'quiet',
        // Prompt building may run helper requests before the foreground payload
        // exists. Later requests must also match that payload before claiming it.
        armed: !usingGenerateAfterDataEvent,
        requestData: null,
    };

    // A new foreground generation supersedes stale generation contexts.
    // If the user started it manually, it also starts a fresh retry budget.
    if (normalizedType !== 'quiet') {
        generationEpoch++;
        if (!retryState.launching) {
            cancelPendingRetry(true);
            retryState.chatKey = generation.chatKey;
        }
        generationStack = [];
    }

    generation.epoch = generationEpoch;
    generationStack.push(generation);
    log('Generation started', {
        id: generation.id,
        type: generation.type,
        retryable: generation.retryable,
        autoRetry: retryState.launching,
    });
}

function onGenerateAfterData(generateData, dryRun = false) {
    if (dryRun) {
        return;
    }

    const generation = getActiveGeneration();
    if (generation) {
        generation.armed = true;
        // Keep the reference so later listeners' edits are included at fetch time.
        generation.requestData = generateData;
        log('Generation armed for API request', { id: generation.id, type: generation.type });
    }
}

function onGenerationStopped() {
    generationStack = [];
    cancelPendingRetry(true);
    log('Generation stopped; pending API retry cancelled');
}

function onChatChangedForExtension() {
    if (autoCleanupTimerId !== null) {
        clearTimeout(autoCleanupTimerId);
        autoCleanupTimerId = null;
    }

    lastScheduledCleanup = { messageIndex: null, at: 0 };
    generationStack = [];
    cancelPendingRetry(true);
}

function getActiveGeneration() {
    return generationStack.length ? generationStack[generationStack.length - 1] : null;
}

function consumeGeneration(generationId) {
    const index = generationStack.findIndex((item) => item.id === generationId);
    if (index !== -1) {
        generationStack.splice(index, 1);
    }
}

function getRequestPath(input) {
    try {
        let rawUrl = '';

        if (typeof input === 'string') {
            rawUrl = input;
        } else if (typeof URL !== 'undefined' && input instanceof URL) {
            rawUrl = input.href;
        } else if (input && typeof input.url === 'string') {
            rawUrl = input.url;
        }

        if (!rawUrl) {
            return '';
        }

        return new URL(rawUrl, window.location.href).pathname;
    } catch {
        return '';
    }
}

function parseRequestBody(init) {
    if (typeof init?.body !== 'string') {
        return null;
    }

    try {
        return JSON.parse(init.body);
    } catch {
        return null;
    }
}

function getGenerationRequestInfo(input, init) {
    const path = getRequestPath(input);
    if (!GENERATION_ENDPOINTS.has(path)) {
        return null;
    }

    const body = parseRequestBody(init);
    return {
        path,
        body,
        streaming: body?.stream === true || body?.streaming === true,
    };
}

function isCurrentGeneration(generation) {
    return generation.epoch === generationEpoch && generation.chatKey === getCurrentChatKey();
}

function matchesGenerationRequest(generation, requestInfo) {
    const body = requestInfo.body;
    if (body?.type !== undefined && (body.type ?? 'normal') !== generation.type) {
        return false;
    }

    const data = generation.requestData;
    if (!data) {
        return true; // Older ST without GENERATE_AFTER_DATA.
    }

    // generateRaw uses the same endpoints, including from hooks after arming.
    // Match the actual prompt as well as the request type before claiming it.
    if (requestInfo.path === '/api/backends/chat-completions/generate') {
        if (!Array.isArray(data.prompt) || !Array.isArray(body?.messages)) return false;
        const messages = data.prompt.filter(message => message && typeof message === 'object');
        return JSON.stringify(messages) === JSON.stringify(body.messages);
    }
    const field = Object.hasOwn(data, 'input') ? 'input' : 'prompt';
    return data[field] !== undefined && JSON.stringify(data[field]) === JSON.stringify(body?.[field]);
}

function isAbortError(error) {
    const name = String(error?.name ?? '');
    const message = String(error?.message ?? error ?? '');
    return name === 'AbortError' || /\babort(?:ed|ing)?\b/i.test(message);
}

function isRetryableHttpStatus(status) {
    const code = Number(status);
    return RETRYABLE_HTTP_STATUSES.has(code) || (code >= 500 && code <= 599);
}

function extractStatusCode(payload) {
    const candidates = [
        payload?.status,
        payload?.status_code,
        payload?.statusCode,
        payload?.code,
        payload?.error?.status,
        payload?.error?.status_code,
        payload?.error?.statusCode,
        payload?.error?.code,
        payload?.detail?.status,
        payload?.detail?.status_code,
        payload?.detail?.error?.status,
        payload?.detail?.error?.code,
    ];

    for (const value of candidates) {
        if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) {
            return value;
        }

        if (typeof value === 'string' && /^\d{3}$/.test(value.trim())) {
            const parsed = Number(value.trim());
            if (parsed >= 100 && parsed <= 599) {
                return parsed;
            }
        }
    }

    return null;
}

function stringifyErrorValue(value) {
    if (value === undefined || value === null || value === false) {
        return '';
    }

    if (typeof value === 'string') {
        return value;
    }

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function getErrorText(payload, rawText = '') {
    const pieces = [
        stringifyErrorValue(payload?.error),
        stringifyErrorValue(payload?.detail?.error),
        stringifyErrorValue(payload?.detail),
        stringifyErrorValue(payload?.message),
        stringifyErrorValue(payload?.response),
    ].filter(Boolean);

    const combined = pieces.join(' ');
    return (combined || rawText || '').slice(0, 4000);
}

function payloadContainsError(payload) {
    return Boolean(
        payload
        && (
            payload.error
            || payload?.detail?.error
            || payload.quota_error === true
        )
    );
}

const NON_RETRYABLE_ERROR_PATTERN = /insufficient[_\s-]?quota|quota\s+(?:exceeded|exhausted)|billing|invalid[_\s-]?(?:api[_\s-]?)?key|authentication|unauthori[sz]ed|forbidden|permission\s+denied|invalid[_\s-]?request|bad\s+request|context\s+(?:length|window)|maximum\s+context|content\s+(?:policy|moderation)|moderation|model\s+.*not\s+found/i;
const TRANSIENT_ERROR_PATTERN = /\b429\b|rate[\s_-]*limit|too\s+many\s+requests|temporar(?:y|ily)|overload(?:ed)?|capacity|server\s+busy|try\s+again|timeout|timed\s+out|connection\s+(?:reset|refused|closed)|econnreset|econnrefused|socket\s+hang\s+up|internal\s+server\s+error|bad\s+gateway|service\s+unavailable|gateway\s+timeout|\b5\d\d\b/i;

function isUnspecifiedPayloadError(payload) {
    const error = payload?.error ?? payload?.detail?.error;
    const description = typeof error === 'object' && error !== null
        ? error.message ?? error.code ?? error.type
        : error;
    return description === true || description == null
        || /^(?:\s*|<none>|unknown error(?: occurred)?)$/i.test(String(description).trim());
}

function classifyGenerationResponse(response, payload, rawText) {
    const hasPayloadError = payloadContainsError(payload);
    const isError = !response.ok || hasPayloadError;

    if (!isError) {
        return { isError: false, retryable: false };
    }

    const errorText = getErrorText(payload, rawText);
    const explicitStatus = extractStatusCode(payload);
    const status = explicitStatus ?? response.status;

    // A concrete permanent status takes precedence over vague provider wording.
    const isPermanentStatus = (code) => code >= 400 && code < 500 && !isRetryableHttpStatus(code);
    if (payload?.quota_error === true || NON_RETRYABLE_ERROR_PATTERN.test(errorText)
        || isPermanentStatus(explicitStatus) || isPermanentStatus(response.status)) {
        return {
            isError: true,
            retryable: false,
            status,
            label: errorText || ('HTTP ' + String(status)),
        };
    }

    // ST can replace an upstream failure with HTTP 200 and an error envelope,
    // losing the original status. Retry unspecified failures within the budget.
    if (isRetryableHttpStatus(explicitStatus) || isRetryableHttpStatus(response.status) || TRANSIENT_ERROR_PATTERN.test(errorText)
        || (response.ok && hasPayloadError && isUnspecifiedPayloadError(payload))) {
        return {
            isError: true,
            retryable: true,
            status,
            label: errorText || ('HTTP ' + String(status)),
        };
    }

    return {
        isError: true,
        retryable: false,
        status,
        label: errorText || ('HTTP ' + String(status)),
    };
}

function parseRetryAfterMs(response) {
    const value = response?.headers?.get?.('Retry-After');
    if (!value) {
        return null;
    }

    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
        return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
    }

    const date = Date.parse(value);
    if (Number.isFinite(date)) {
        return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - Date.now()));
    }

    return null;
}

function computeRetryDelayMs(attempt, retryAfterMs = null) {
    const exponentialDelay = Math.min(
        MAX_BACKOFF_MS,
        getRetryDelayMs() * Math.pow(2, Math.max(0, attempt - 1)),
    );

    if (Number.isFinite(retryAfterMs)) {
        return Math.max(exponentialDelay, retryAfterMs);
    }

    return exponentialDelay;
}

function formatRetryDelay(ms) {
    if (ms < 1000) {
        return String(Math.round(ms)) + ' ms';
    }

    const seconds = ms / 1000;
    return (Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)) + ' s';
}

function getRetryGenerationType(generation) {
    const context = SillyTavern.getContext();
    const originalType = generation.type ?? 'normal';

    // A failed normal generation has usually already saved the user's message.
    // "regenerate" safely retries from that user turn without sending an empty
    // or send_if_empty user message.
    if (originalType === 'normal') {
        const lastMessage = context.chat?.[context.chat.length - 1];
        if (lastMessage?.is_user === true) {
            return 'regenerate';
        }
    }

    return originalType;
}

function markSuccessfulGenerationRequest(generation) {
    if (!isCurrentGeneration(generation)) return;
    if (retryState.attempts > 0 && retryState.chatKey === generation.chatKey) {
        log('API retry succeeded', { attempts: retryState.attempts });
        cancelPendingRetry(true);
    }
}

function markNonRetryableGenerationFailure(generation) {
    if (!isCurrentGeneration(generation)) return;
    if (retryState.chatKey === generation.chatKey) {
        cancelPendingRetry(true);
    }
}

/**
 * ST marks the body while Generate() runs and has no busy guard of its own,
 * so starting a retry now would run a second generation over the first.
 * @returns {boolean}
 */
function isGenerationInProgress() {
    return typeof document !== 'undefined' && Boolean(document.body?.dataset?.generating);
}

/**
 * Record the end of the chat at the moment a request failed.
 * @returns {{chatLength: number, lastMessage: object|null, lastMes: string, swipeId: number|undefined, swipeCount: number}}
 */
function takeChatSnapshot() {
    const { chat } = SillyTavern.getContext();
    const lastMessage = chat?.[chat.length - 1] ?? null;

    return {
        chatLength: chat?.length ?? 0,
        lastMessage,
        lastMes: lastMessage?.mes ?? '',
        swipeId: lastMessage?.swipe_id,
        swipeCount: Array.isArray(lastMessage?.swipes) ? lastMessage.swipes.length : 0,
    };
}

/**
 * Decide whether launching the retry now could destroy or duplicate a real reply.
 * @param {object} snapshot - Chat state from takeChatSnapshot() at failure time
 * @param {string} retryType - Generation type the retry would use
 * @returns {'reply-arrived'|'would-delete'|null}
 */
function getRetryBlocker(snapshot, retryType) {
    const { chat } = SillyTavern.getContext();
    const lastMessage = chat?.[chat.length - 1];

    // Only a non-empty AI message at the end of the chat is at risk.
    if (!lastMessage || lastMessage.is_user === true || isSwipeEmpty(lastMessage.mes)) {
        return null;
    }

    const swipeCount = Array.isArray(lastMessage.swipes) ? lastMessage.swipes.length : 0;
    if (chat.length !== snapshot.chatLength
        || lastMessage !== snapshot.lastMessage
        || lastMessage.mes !== snapshot.lastMes
        || lastMessage.swipe_id !== snapshot.swipeId
        || swipeCount !== snapshot.swipeCount) {
        return 'reply-arrived';
    }

    // ST's regenerate deletes the last message when it isn't the user's.
    if (retryType === 'regenerate') {
        return 'would-delete';
    }

    return null;
}

function scheduleGenerationRetry(generation, failure) {
    if (!isCurrentGeneration(generation)) return;
    const settings = getSettings();

    if (!settings?.enabled || !settings?.retryOnApiError || !generation?.retryable) {
        return;
    }

    if (getCurrentChatKey() !== generation.chatKey) {
        cancelPendingRetry(true);
        return;
    }

    if (retryState.scheduledForGenerationId === generation.id) {
        return;
    }

    if (retryState.chatKey && retryState.chatKey !== generation.chatKey) {
        cancelPendingRetry(true);
    }
    retryState.chatKey = generation.chatKey;

    const maxRetries = getMaxRetries();
    if (maxRetries <= 0) {
        return;
    }

    if (retryState.attempts >= maxRetries) {
        retryState.scheduledForGenerationId = generation.id;
        toastr.warning(
            'Automatic API retry limit reached (' + String(maxRetries) + ').',
            'Empty Response Cleaner',
            { timeOut: 8000 },
        );
        return;
    }

    retryState.attempts += 1;
    const attempt = retryState.attempts;
    const delayMs = computeRetryDelayMs(attempt, failure.retryAfterMs);
    retryState.scheduledForGenerationId = generation.id;

    const reason = String(failure.label || failure.reason || 'Transient API error')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);

    toastr.info(
        (reason ? reason + '. ' : '') +
        'Retrying in ' + formatRetryDelay(delayMs) +
        ' (' + String(attempt) + '/' + String(maxRetries) + ').',
        'Empty Response Cleaner',
        { timeOut: Math.min(10_000, Math.max(4000, delayMs)) },
    );

    log('Scheduled API retry', {
        generationId: generation.id,
        type: generation.type,
        attempt,
        maxRetries,
        delayMs,
        reason,
    });

    const snapshot = takeChatSnapshot();
    let idleWaitStartedAt = null;

    const launchRetry = async () => {
        if (!isCurrentGeneration(generation)) return;
        retryState.timerId = null;

        const currentSettings = getSettings();
        if (!currentSettings?.enabled || !currentSettings?.retryOnApiError) {
            cancelPendingRetry(true);
            return;
        }

        if (getCurrentChatKey() !== generation.chatKey) {
            cancelPendingRetry(true);
            return;
        }

        if (isGenerationInProgress()) {
            idleWaitStartedAt ??= Date.now();
            if (Date.now() - idleWaitStartedAt >= RETRY_IDLE_MAX_WAIT_MS) {
                log('API retry cancelled; generation still running', { generationId: generation.id });
                cancelPendingRetry(true);
                return;
            }

            retryState.timerId = setTimeout(launchRetry, RETRY_IDLE_POLL_MS);
            return;
        }

        retryState.scheduledForGenerationId = null;

        const context = SillyTavern.getContext();
        const retryType = getRetryGenerationType(generation);

        const blocker = getRetryBlocker(snapshot, retryType);
        if (blocker) {
            log('API retry skipped', { generationId: generation.id, retryType, blocker });
            cancelPendingRetry(true);

            if (blocker === 'would-delete') {
                toastr.warning(
                    'Automatic retry skipped so an existing message is not deleted.',
                    'Empty Response Cleaner',
                );
            }
            return;
        }

        retryState.launching = true;
        try {
            log('Starting API retry', {
                originalType: generation.type,
                retryType,
                attempt,
            });

            await context.generate(retryType, copyRetryOptions(generation.options));
        } catch (error) {
            // Retryable request failures are detected by the fetch wrapper and
            // schedule the next attempt there. Avoid double-scheduling here.
            if (!isAbortError(error)) {
                console.warn('[' + extensionName + '] Retry generation failed', error);
            }
        } finally {
            retryState.launching = false;
        }
    };

    retryState.timerId = setTimeout(launchRetry, delayMs);
}

async function inspectGenerationResponse(response, requestInfo) {
    let rawText = '';
    let payload = null;

    // A streaming request may receive a finite JSON error envelope with HTTP
    // 200. Inspect that body, but never wait for an actual SSE stream to finish.
    const contentType = response.headers?.get?.('Content-Type') ?? '';
    const isJsonResponse = /\bapplication\/(?:[\w.-]+\+)?json\b/i.test(contentType);
    if (!response.ok || !requestInfo.streaming || isJsonResponse) {
        try {
            rawText = await response.clone().text();
            if (rawText) {
                try {
                    payload = JSON.parse(rawText);
                } catch {
                    payload = null;
                }
            }
        } catch (error) {
            log('Could not inspect generation response body', error);
        }
    }

    return {
        ...classifyGenerationResponse(response, payload, rawText),
        retryAfterMs: parseRetryAfterMs(response),
    };
}

function installFetchInterceptor() {
    if (globalThis[FETCH_PATCH_KEY]?.installed) {
        return;
    }

    const originalFetch = globalThis.fetch.bind(globalThis);

    const wrappedFetch = async function (input, init) {
        const requestInfo = getGenerationRequestInfo(input, init);
        if (!requestInfo) {
            return originalFetch(input, init);
        }

        const generation = getActiveGeneration();

        // Extensions also call these endpoints (generateRaw, connection profiles)
        // without their own GENERATION_STARTED. Leave any request that isn't
        // the armed generation's own alone.
        if (!generation || !generation.armed || !isCurrentGeneration(generation)
            || !matchesGenerationRequest(generation, requestInfo)) {
            return originalFetch(input, init);
        }

        // Claim the generation before awaiting, so a concurrent helper request
        // can't be counted as this generation's result.
        consumeGeneration(generation.id);

        try {
            const response = await originalFetch(input, init);

            if (!generation.retryable) {
                return response;
            }

            const classification = await inspectGenerationResponse(response, requestInfo);

            if (!classification.isError) {
                markSuccessfulGenerationRequest(generation);
            } else if (classification.retryable) {
                scheduleGenerationRetry(generation, classification);
            } else {
                markNonRetryableGenerationFailure(generation);
            }

            return response;
        } catch (error) {
            if (generation.retryable && !isAbortError(error)) {
                scheduleGenerationRetry(generation, {
                    reason: 'Network error',
                    label: String(error?.message || 'Network error'),
                    retryAfterMs: null,
                });
            }

            throw error;
        }
    };

    globalThis.fetch = wrappedFetch;
    globalThis[FETCH_PATCH_KEY] = {
        installed: true,
        originalFetch,
    };

    log('Installed generation API retry interceptor');
}

function onRetryToggle() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const enabled = $('#empty_response_cleaner_retry_api_errors').prop('checked');
    extensionSettings[extensionName].retryOnApiError = enabled;

    if (!enabled) {
        cancelPendingRetry(true);
    }

    saveSettingsDebounced();
}

function onMaxRetriesChange() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const value = Math.round(clampNumber(
        $('#empty_response_cleaner_max_retries').val(),
        0,
        10,
        defaultSettings.maxRetries,
    ));

    extensionSettings[extensionName].maxRetries = value;
    $('#empty_response_cleaner_max_retries').val(value);
    saveSettingsDebounced();
}

function onRetryDelayChange() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const seconds = clampNumber(
        $('#empty_response_cleaner_retry_delay').val(),
        0.25,
        60,
        defaultSettings.retryDelayMs / 1000,
    );

    const milliseconds = Math.round(seconds * 1000);
    extensionSettings[extensionName].retryDelayMs = milliseconds;
    $('#empty_response_cleaner_retry_delay').val(milliseconds / 1000);
    saveSettingsDebounced();
}

/**
 * Wait one UI tick so DOM/state updates from deleteMessage settle first.
 * @returns {Promise<void>}
 */
async function waitForUiTick() {
    await Promise.resolve();

    if (typeof requestAnimationFrame === 'function') {
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        return;
    }

    await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Clamp swipe_id and force the visible message content to the active swipe,
 * then re-render only that message block.
 * @param {number} messageIndex
 * @returns {Promise<boolean>}
 */
async function repairAndRerenderMessage(messageIndex) {
    const { chat, updateMessageBlock, swipe } = SillyTavern.getContext();
    const canRerender = typeof updateMessageBlock === 'function';

    if (!chat || messageIndex < 0 || messageIndex >= chat.length) {
        return false;
    }

    const message = chat[messageIndex];
    if (!message || message.is_user === true) {
        return false;
    }

    if (Array.isArray(message.swipes) && message.swipes.length > 0) {
        const currentSwipeId = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
        const clampedSwipeId = Math.max(0, Math.min(currentSwipeId, message.swipes.length - 1));
        message.swipe_id = clampedSwipeId;

        const activeSwipe = message.swipes[clampedSwipeId];
        if (clampedSwipeId === currentSwipeId && isSwipeEmpty(activeSwipe) && !isSwipeEmpty(message.mes)) {
            // ST's saveReply renders a new swipe before storing it in swipes[];
            // keep the visible text instead of blanking it.
            message.swipes[clampedSwipeId] = message.mes;
        } else {
            message.mes = typeof activeSwipe === 'string' ? activeSwipe : String(activeSwipe ?? '');
        }
    }

    await waitForUiTick();

    if (canRerender) {
        try {
            updateMessageBlock(messageIndex, message, { rerenderMessage: true });
        } catch (error) {
            console.warn(`[${extensionName}] updateMessageBlock failed`, { messageIndex, error });
        }
    }

    if (swipe && typeof swipe.refresh === 'function') {
        try {
            swipe.refresh(true, false);
        } catch {
            try {
                swipe.refresh();
            } catch (error) {
                console.warn(`[${extensionName}] swipe.refresh failed`, { messageIndex, error });
            }
        }
    }

    if (canRerender) {
        log('Repaired and re-rendered message after swipe cleanup', {
            messageIndex,
            swipeId: message.swipe_id,
        });
    }

    return canRerender;
}

/**
 * Get the SillyTavern deleteMessage API from context
 * @returns {Function|null}
 */
function getDeleteMessageApi() {
    const { deleteMessage } = SillyTavern.getContext();
    return typeof deleteMessage === 'function' ? deleteMessage : null;
}

/**
 * Delete a whole message or a single swipe via official ST API.
 * Returns false if API is unavailable or the operation fails.
 * @param {number} messageIndex
 * @param {number|undefined} swipeIndex
 * @returns {Promise<boolean>}
 */
async function deleteViaApi(messageIndex, swipeIndex = undefined) {
    const deleteMessage = getDeleteMessageApi();
    if (!deleteMessage) {
        toastr.warning('Cleanup skipped: compatible delete API not available', 'Empty Response Cleaner');
        console.warn(`[${extensionName}] deleteMessage API unavailable; skipping cleanup`);
        return false;
    }

    try {
        await deleteMessage(messageIndex, swipeIndex, false);
        return true;
    } catch (error) {
        console.warn(`[${extensionName}] delete API call failed`, { messageIndex, swipeIndex, error });
        toastr.warning('Cleanup skipped: delete API failed', 'Empty Response Cleaner');
        return false;
    }
}

/**
 * Analyze empty swipes from a message without mutating it
 * @param {object} message - The message object to clean
 * @returns {object} - Result with information about what was cleaned
 */
function cleanMessageSwipes(message) {
    const result = {
        emptySwipeIndexes: [],
        removedSwipes: 0,
        messageDeleted: false,
        modified: false,
    };

    // Check if message has swipes array
    if (!message.swipes || !Array.isArray(message.swipes)) {
        // If no swipes array, check the main 'mes' property
        if (isSwipeEmpty(message.mes)) {
            result.messageDeleted = true;
            result.modified = true;
        }
        return result;
    }

    // ST's saveReply emits CHARACTER_MESSAGE_RENDERED for a new swipe before it
    // copies mes into swipes[swipe_id]. Visible text means the swipe isn't empty.
    const activeSwipeId = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
    const hasVisibleText = !isSwipeEmpty(message.mes);

    for (let i = 0; i < message.swipes.length; i++) {
        if (i === activeSwipeId && hasVisibleText) {
            continue;
        }

        if (isSwipeEmpty(message.swipes[i])) {
            result.emptySwipeIndexes.push(i);
        }
    }

    result.removedSwipes = result.emptySwipeIndexes.length;

    // If no empty swipes, no work to do
    if (result.removedSwipes === 0) {
        return result;
    }

    result.modified = true;

    // If all swipes are empty, mark for full message deletion
    if (result.removedSwipes === message.swipes.length) {
        result.messageDeleted = true;
    }

    return result;
}

/**
 * Process the last AI message and clean empty swipes
 * @param {boolean} isManual - Whether this is a manual trigger
 * @param {object|null} targetMessage - Message whose render triggered automatic cleanup;
 *   when omitted, the last AI message is cleaned
 * @returns {Promise<boolean>} - True if any changes were made
 */
async function processLastMessage(isManual = false, targetMessage = null) {
    const { chat } = SillyTavern.getContext();

    // Do nothing if chat is empty
    if (!chat || chat.length === 0) {
        if (isManual) {
            toastr.warning('Chat is empty', 'Empty Response Cleaner');
        }
        return false;
    }

    let messageIndex = -1;
    if (targetMessage) {
        // Clean only the message that triggered this run, wherever it is now.
        const targetIndex = chat.indexOf(targetMessage);
        if (targetIndex !== -1 && targetMessage.is_user === false) {
            messageIndex = targetIndex;
        }
    } else {
        // Find the last AI message
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i].is_user === false) {
                messageIndex = i;
                break;
            }
        }
    }

    // Do nothing if no AI message found
    if (messageIndex === -1) {
        if (isManual) {
            toastr.warning('No AI message found', 'Empty Response Cleaner');
        }
        return false;
    }

    // When auto-delete is disabled, skip all automatic cleanup/deletion.
    if (!isManual && !getSettings()?.autoDelete) {
        return false;
    }

    const message = chat[messageIndex];
    const result = cleanMessageSwipes(message);

    if (!result.modified) {
        if (isManual) {
            toastr.info('No empty swipes found', 'Empty Response Cleaner');
        }
        return false;
    }

    if (result.messageDeleted) {
        // Don't delete if this is the only message in the chat
        // SillyTavern UI fails to render this correctly
        if (chat.length <= 1) {
            if (isManual) {
                toastr.warning('Cannot remove the only message in chat', 'Empty Response Cleaner');
            }
            return false;
        }

        const deleted = await deleteViaApi(messageIndex);
        if (!deleted) {
            return false;
        }

        log('Deleted empty AI message via deleteMessage API', { messageIndex });
        toastr.info('Removed empty AI response', 'Empty Response Cleaner');
        return true;
    }

    let removedSwipes = 0;
    const emptyIndexesDescending = [...result.emptySwipeIndexes].sort((a, b) => b - a);

    // Delete each empty swipe through API so ST emits MESSAGE_SWIPE_DELETED.
    for (const swipeIndex of emptyIndexesDescending) {
        const deleted = await deleteViaApi(messageIndex, swipeIndex);
        if (deleted) {
            removedSwipes++;
            log('Deleted empty swipe via deleteMessage API', {
                messageIndex,
                swipeIndex,
            });

            // Keep UI in sync immediately after each deletion.
            await repairAndRerenderMessage(messageIndex);
        }
    }

    if (removedSwipes > 0) {
        toastr.info(`Removed ${removedSwipes} empty swipe${removedSwipes > 1 ? 's' : ''}`, 'Empty Response Cleaner');
        return true;
    }

    if (isManual) {
        toastr.warning('Unable to remove empty swipes', 'Empty Response Cleaner');
    }

    return false;
}

/**
 * Prevent overlapping cleanup runs from rapid event bursts.
 * @param {boolean} isManual
 * @param {object|null} targetMessage
 * @returns {Promise<boolean>}
 */
async function processLastMessageLocked(isManual = false, targetMessage = null) {
    if (isProcessing) {
        return false;
    }

    isProcessing = true;
    try {
        return await processLastMessage(isManual, targetMessage);
    } finally {
        isProcessing = false;
    }
}

/**
 * Cancel any pending auto-cleanup timer and remove registered event listeners.
 * Safe to call multiple times.
 */
function cleanupExtension() {
    if (autoCleanupTimerId !== null) {
        clearTimeout(autoCleanupTimerId);
        autoCleanupTimerId = null;
    }

    generationStack = [];
    cancelPendingRetry(true);

    const { eventSource, event_types } = SillyTavern.getContext();

    if (usingCharacterMessageRenderedEvent && boundOnCharacterMessageRendered && event_types?.CHARACTER_MESSAGE_RENDERED) {
        eventSource.removeListener(event_types.CHARACTER_MESSAGE_RENDERED, boundOnCharacterMessageRendered);
    } else if (boundOnMessageReceived && event_types?.MESSAGE_RECEIVED) {
        eventSource.removeListener(event_types.MESSAGE_RECEIVED, boundOnMessageReceived);
    }

    if (boundOnGenerationStarted && event_types?.GENERATION_STARTED) {
        eventSource.removeListener(event_types.GENERATION_STARTED, boundOnGenerationStarted);
    }

    if (boundOnGenerateAfterData && event_types?.GENERATE_AFTER_DATA) {
        eventSource.removeListener(event_types.GENERATE_AFTER_DATA, boundOnGenerateAfterData);
    }

    if (boundOnGenerationStopped && event_types?.GENERATION_STOPPED) {
        eventSource.removeListener(event_types.GENERATION_STOPPED, boundOnGenerationStopped);
    }

    if (boundOnChatChanged && event_types?.CHAT_CHANGED) {
        eventSource.removeListener(event_types.CHAT_CHANGED, boundOnChatChanged);
    }

    boundOnCharacterMessageRendered = null;
    boundOnMessageReceived = null;
    boundOnGenerationStarted = null;
    boundOnGenerateAfterData = null;
    boundOnGenerationStopped = null;
    boundOnChatChanged = null;
    usingCharacterMessageRenderedEvent = false;
    usingGenerateAfterDataEvent = false;
}

/**
 * Schedule automatic cleanup with short dedupe window to avoid
 * duplicate runs from nearby events.
 * Only one timer is ever pending at a time.
 * @param {number} messageIndex
 * @returns {void}
 */
function scheduleAutoCleanup(messageIndex) {
    const now = Date.now();
    const dedupeWindowMs = 500;

    if (lastScheduledCleanup.messageIndex === messageIndex && (now - lastScheduledCleanup.at) < dedupeWindowMs) {
        return;
    }

    lastScheduledCleanup = {
        messageIndex,
        at: now,
    };

    // Tie the run to the rendered message itself; indexes can shift before the timer fires.
    const { chat } = SillyTavern.getContext();
    const targetMessage = messageIndex >= 0 ? (chat?.[messageIndex] ?? null) : null;

    // Cancel any previously pending timer before scheduling a new one
    if (autoCleanupTimerId !== null) {
        clearTimeout(autoCleanupTimerId);
    }

    autoCleanupTimerId = setTimeout(() => {
        autoCleanupTimerId = null;
        processLastMessageLocked(false, targetMessage).catch((error) => {
            console.warn(`[${extensionName}] Auto-clean failed`, error);
        });
    }, 50);
}

/**
 * Handler for message-rendered lifecycle event.
 * This runs after the UI has rendered, preventing stale/blank message text.
 * @param {number} messageIndex - Index of the received message
 */
function onCharacterMessageRendered(messageIndex) {
    const settings = getSettings();

    // Check if auto-clean is enabled
    if (!settings || !settings.enabled) {
        return;
    }

    const { chat } = SillyTavern.getContext();

    // Validate message index
    if (typeof messageIndex !== 'number' || messageIndex < 0 || messageIndex >= chat.length) {
        // If messageIndex is not valid, just process the last message.
        scheduleAutoCleanup(-1);
        return;
    }

    const message = chat[messageIndex];

    // Only process AI messages
    if (message.is_user === true) {
        return;
    }

    scheduleAutoCleanup(messageIndex);
}

/**
 * Register event listeners for message rendering events.
 * Cleans up existing listeners first to avoid duplicates.
 */
function registerEventListeners() {
    const { eventSource, event_types } = SillyTavern.getContext();

    // Clean up any existing listeners before re-registering
    cleanupExtension();

    if (event_types?.CHARACTER_MESSAGE_RENDERED) {
        boundOnCharacterMessageRendered = onCharacterMessageRendered;
        usingCharacterMessageRenderedEvent = true;
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, boundOnCharacterMessageRendered);
    } else {
        boundOnMessageReceived = onCharacterMessageRendered;
        usingCharacterMessageRenderedEvent = false;
        eventSource.on(event_types.MESSAGE_RECEIVED, boundOnMessageReceived);
    }

    if (event_types?.GENERATION_STARTED) {
        boundOnGenerationStarted = onGenerationStarted;
        eventSource.on(event_types.GENERATION_STARTED, boundOnGenerationStarted);
    }

    // Without this event (older ST), generations are armed as soon as they start.
    if (event_types?.GENERATE_AFTER_DATA) {
        boundOnGenerateAfterData = onGenerateAfterData;
        usingGenerateAfterDataEvent = true;
        eventSource.on(event_types.GENERATE_AFTER_DATA, boundOnGenerateAfterData);
    }

    if (event_types?.GENERATION_STOPPED) {
        boundOnGenerationStopped = onGenerationStopped;
        eventSource.on(event_types.GENERATION_STOPPED, boundOnGenerationStopped);
    }

    if (event_types?.CHAT_CHANGED) {
        boundOnChatChanged = onChatChangedForExtension;
        eventSource.on(event_types.CHAT_CHANGED, boundOnChatChanged);
    }
}

/**
 * Handle settings toggle change
 */
function onEnabledToggle() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const enabled = $('#empty_response_cleaner_enabled').prop('checked');
    extensionSettings[extensionName].enabled = enabled;
    saveSettingsDebounced();

    if (!enabled) {
        // Cancel pending timer and remove listeners when extension is disabled
        cleanupExtension();
    } else {
        // Re-register listeners when extension is re-enabled
        registerEventListeners();
    }
}

/**
 * Handle auto-delete toggle change
 */
function onAutoDeleteToggle() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const autoDelete = $('#empty_response_cleaner_auto_delete').prop('checked');
    extensionSettings[extensionName].autoDelete = autoDelete;
    saveSettingsDebounced();
}

/**
 * Handle manual clean button click
 */
async function onCleanLastMessageClick() {
    await processLastMessageLocked(true);
}

/**
 * Delete the last AI message from the chat regardless of content
 * @returns {Promise<boolean>} - True if a message was deleted
 */
async function deleteLastMessage() {
    const { chat } = SillyTavern.getContext();

    if (!chat || chat.length === 0) {
        toastr.warning('Chat is empty', 'Empty Response Cleaner');
        return false;
    }

    // Find the last AI message
    let lastAiMessageIndex = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user === false) {
            lastAiMessageIndex = i;
            break;
        }
    }

    if (lastAiMessageIndex === -1) {
        toastr.warning('No AI message found', 'Empty Response Cleaner');
        return false;
    }

    if (chat.length <= 1) {
        toastr.warning('Cannot remove the only message in chat', 'Empty Response Cleaner');
        return false;
    }

    const deleted = await deleteViaApi(lastAiMessageIndex);
    if (!deleted) {
        return false;
    }

    log('Deleted last AI message via deleteMessage API', { messageIndex: lastAiMessageIndex });
    toastr.info('Deleted last AI message', 'Empty Response Cleaner');
    return true;
}

/**
 * Handle manual delete button click
 */
async function onDeleteLastMessageClick() {
    await deleteLastMessage();
}

/**
 * Create and inject the settings HTML
 */
function createSettingsUI() {
    const settings = getSettings();

    const settingsHtml = `
    <div id="empty_response_cleaner_settings" class="empty-response-cleaner-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Empty Response Cleaner</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="empty_response_cleaner_block">
                    <label class="checkbox_label" for="empty_response_cleaner_enabled">
                        <input type="checkbox" id="empty_response_cleaner_enabled" />
                        <span>Enable automatic empty response detection</span>
                    </label>
                </div>
                <div class="empty_response_cleaner_block">
                    <label class="checkbox_label" for="empty_response_cleaner_auto_delete">
                        <input type="checkbox" id="empty_response_cleaner_auto_delete" />
                        <span>Automatically clean empty responses (swipes + fully empty messages)</span>
                    </label>
                </div>
                <hr class="sysHR" />
                <div class="empty_response_cleaner_block">
                    <label class="checkbox_label" for="empty_response_cleaner_retry_api_errors">
                        <input type="checkbox" id="empty_response_cleaner_retry_api_errors" />
                        <span>Automatically retry transient API errors</span>
                    </label>
                    <div class="empty_response_cleaner_hint">
                        Retries rate limits (429), 408/425, 5xx errors, timeouts, network failures, and unspecified API errors. Authentication, quota, bad-request, and moderation errors are not retried.
                    </div>
                </div>
                <div class="empty_response_cleaner_block empty_response_cleaner_setting_row">
                    <label for="empty_response_cleaner_max_retries">Max retries</label>
                    <input class="text_pole" type="number" id="empty_response_cleaner_max_retries" min="0" max="10" step="1" />
                </div>
                <div class="empty_response_cleaner_block empty_response_cleaner_setting_row">
                    <label for="empty_response_cleaner_retry_delay">Initial retry delay (seconds)</label>
                    <input class="text_pole" type="number" id="empty_response_cleaner_retry_delay" min="0.25" max="60" step="0.25" />
                </div>
                <div class="empty_response_cleaner_block">
                    <div class="menu_button menu_button_icon" id="empty_response_cleaner_clean_btn">
                        <i class="fa-solid fa-broom"></i>
                        <span>Clean Last Message</span>
                    </div>
                </div>
                <div class="empty_response_cleaner_block">
                    <div class="menu_button menu_button_icon" id="empty_response_cleaner_delete_btn">
                        <i class="fa-solid fa-trash"></i>
                        <span>Delete Last AI Message</span>
                    </div>
                </div>
                <hr class="sysHR" />
            </div>
        </div>
    </div>`;

    // Append to extensions settings
    $('#extensions_settings').append(settingsHtml);

    // Set initial state
    $('#empty_response_cleaner_enabled').prop('checked', settings?.enabled ?? true);
    $('#empty_response_cleaner_auto_delete').prop('checked', settings?.autoDelete ?? true);
    $('#empty_response_cleaner_retry_api_errors').prop('checked', settings?.retryOnApiError ?? true);
    $('#empty_response_cleaner_max_retries').val(getMaxRetries());
    $('#empty_response_cleaner_retry_delay').val(getRetryDelayMs() / 1000);

    // Bind event handlers
    $('#empty_response_cleaner_enabled').on('change', onEnabledToggle);
    $('#empty_response_cleaner_auto_delete').on('change', onAutoDeleteToggle);
    $('#empty_response_cleaner_retry_api_errors').on('change', onRetryToggle);
    $('#empty_response_cleaner_max_retries').on('change', onMaxRetriesChange);
    $('#empty_response_cleaner_retry_delay').on('change', onRetryDelayChange);
    $('#empty_response_cleaner_clean_btn').on('click', onCleanLastMessageClick);
    $('#empty_response_cleaner_delete_btn').on('click', onDeleteLastMessageClick);
}

/**
 * Initialize the extension
 */
jQuery(async () => {
    // Load settings
    loadSettings();

    // Create settings UI
    createSettingsUI();

    // Observe generation API requests so transient failures can be retried.
    installFetchInterceptor();

    // Register message, generation, and chat lifecycle listeners.
    registerEventListeners();

    console.log(`[${extensionName}] Extension loaded`);
});
