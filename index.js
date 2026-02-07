const extensionName = 'empty-response-cleaner';

// Default settings
const defaultSettings = {
    enabled: true,
    autoDelete: true,
};

let isProcessing = false;
let lastScheduledCleanup = {
    messageIndex: null,
    at: 0,
};

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

function log(...args) {
    console.debug(`[${extensionName}]`, ...args);
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
        message.mes = typeof activeSwipe === 'string' ? activeSwipe : String(activeSwipe ?? '');
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

    for (let i = 0; i < message.swipes.length; i++) {
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
 * @returns {Promise<boolean>} - True if any changes were made
 */
async function processLastMessage(isManual = false) {
    const { chat } = SillyTavern.getContext();

    // Do nothing if chat is empty
    if (!chat || chat.length === 0) {
        if (isManual) {
            toastr.warning('Chat is empty', 'Empty Response Cleaner');
        }
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

    // Do nothing if no AI message found
    if (lastAiMessageIndex === -1) {
        if (isManual) {
            toastr.warning('No AI message found', 'Empty Response Cleaner');
        }
        return false;
    }

    // When auto-delete is disabled, skip all automatic cleanup/deletion.
    if (!isManual && !getSettings()?.autoDelete) {
        return false;
    }

    const message = chat[lastAiMessageIndex];
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

        const deleted = await deleteViaApi(lastAiMessageIndex);
        if (!deleted) {
            return false;
        }

        log('Deleted empty AI message via deleteMessage API', { messageIndex: lastAiMessageIndex });
        toastr.info('Removed empty AI response', 'Empty Response Cleaner');
        return true;
    }

    let removedSwipes = 0;
    const emptyIndexesDescending = [...result.emptySwipeIndexes].sort((a, b) => b - a);

    // Delete each empty swipe through API so ST emits MESSAGE_SWIPE_DELETED.
    for (const swipeIndex of emptyIndexesDescending) {
        const deleted = await deleteViaApi(lastAiMessageIndex, swipeIndex);
        if (deleted) {
            removedSwipes++;
            log('Deleted empty swipe via deleteMessage API', {
                messageIndex: lastAiMessageIndex,
                swipeIndex,
            });

            // Keep UI in sync immediately after each deletion.
            await repairAndRerenderMessage(lastAiMessageIndex);
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
 * @returns {Promise<boolean>}
 */
async function processLastMessageLocked(isManual = false) {
    if (isProcessing) {
        return false;
    }

    isProcessing = true;
    try {
        return await processLastMessage(isManual);
    } finally {
        isProcessing = false;
    }
}

/**
 * Schedule automatic cleanup with short dedupe window to avoid
 * duplicate runs from nearby events.
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

    setTimeout(() => {
        processLastMessageLocked(false).catch((error) => {
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
 * Handle settings toggle change
 */
function onEnabledToggle() {
    const { extensionSettings, saveSettingsDebounced } = SillyTavern.getContext();
    const enabled = $('#empty_response_cleaner_enabled').prop('checked');
    extensionSettings[extensionName].enabled = enabled;
    saveSettingsDebounced();
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

    // Bind event handlers
    $('#empty_response_cleaner_enabled').on('change', onEnabledToggle);
    $('#empty_response_cleaner_auto_delete').on('change', onAutoDeleteToggle);
    $('#empty_response_cleaner_clean_btn').on('click', onCleanLastMessageClick);
    $('#empty_response_cleaner_delete_btn').on('click', onDeleteLastMessageClick);
}

/**
 * Initialize the extension
 */
jQuery(async () => {
    const { eventSource, event_types } = SillyTavern.getContext();

    // Load settings
    loadSettings();

    // Create settings UI
    createSettingsUI();

    // Prefer post-render event so cleanup happens after the visible message is built.
    if (event_types?.CHARACTER_MESSAGE_RENDERED) {
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    } else {
        // Fallback for older ST versions.
        eventSource.on(event_types.MESSAGE_RECEIVED, onCharacterMessageRendered);
    }

    console.log(`[${extensionName}] Extension loaded`);
});
