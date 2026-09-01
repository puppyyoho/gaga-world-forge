import {
    ACTIVATION_STRATEGIES,
    CLASS_PRESETS,
    DISPLAY_NAME,
    EXTENSION_NAME,
    GREETING_INTENSITY_PRESETS,
    GREETING_LENGTH_PRESETS,
    GREETING_STYLE_PRESETS,
    GREETING_USER_PRESETS,
    LENGTH_PRESETS,
    LITERARY_STYLE_PRESETS,
    LORE_CATEGORIES,
    MODULE_GROUPS,
    PERSONALITY_PRESETS,
    RELATION_PRESETS,
    SECTION_LENGTH_GROUPS,
    SECTION_LENGTH_OPTIONS,
    SETTINGS_KEY,
    THEME_OPTIONS,
    TONE_PRESETS,
    VERSION,
    WORLD_PRESETS,
    buildGenerationPrompt,
    buildGreetingPrompt,
    buildGreetingSystemPrompt,
    buildRepairPrompt,
    buildSystemPrompt,
    createDefaultOptions,
    normalizeOptions,
    outputSchemaExamples,
    resolveLengthPlan,
} from './studio-data.js';
import {
    JsonlStreamParser,
    aggregateBlueprint,
    applyPatches,
    findLengthIssues,
    findStyleIssues,
    parsePatchJsonl,
    validateBlueprint,
} from './jsonl.js';
import {
    compileCharacterCard,
    compilePersonaText,
    compileWorldBook,
    serializeBlueprint,
    serializeJsonl,
    simulateLoreActivation,
} from './compiler.js';
import { generateWithFallback } from './streaming.js';

const state = {
    overlay: null,
    events: [],
    raw: '',
    selectedId: '',
    activeTab: 'blueprint',
    generating: false,
    complete: false,
    abortController: null,
    parser: null,
    greetingGenerating: false,
    greetingAbortController: null,
    greetingParser: null,
    greetingEvents: [],
    greetingRaw: '',
    savedWorldName: '',
    validation: { valid: false, errors: [], warnings: [] },
    styleIssues: [],
    lengthIssues: [],
    shellOffset: { x: 0, y: 0 },
};

function getContext() {
    const st = globalThis.SillyTavern;
    if (!st?.getContext) throw new Error('未检测到 SillyTavern.getContext()。');
    return st.getContext();
}

function notify(type, message) {
    if (globalThis.toastr?.[type]) globalThis.toastr[type](message, DISPLAY_NAME);
    else console[type === 'error' ? 'error' : 'log'](`[${DISPLAY_NAME}] ${message}`);
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function settings() {
    const ctx = getContext();
    const root = ctx.extensionSettings;
    root[SETTINGS_KEY] ??= {
        showFloatingButton: true,
        options: createDefaultOptions(),
        draftEvents: [],
    };
    root[SETTINGS_KEY].options = normalizeOptions(root[SETTINGS_KEY].options);
    return root[SETTINGS_KEY];
}

function persistSettings() {
    try {
        getContext().saveSettingsDebounced?.();
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] 保存扩展设置失败`, error);
    }
}

function checkedChoices(definitions, group) {
    return definitions.map(item => `
        <label class="gwf-chip">
            <input type="checkbox" data-preset-group="${group}" value="${item.id}">
            <span>${escapeHtml(item.label)}</span>
        </label>`).join('');
}

function moduleChoices() {
    return MODULE_GROUPS.map(group => `
        <div class="gwf-module-group">
            <div class="gwf-module-title">${escapeHtml(group.label)}</div>
            <div class="gwf-check-grid">
                ${group.modules.map(module => `
                    <label class="gwf-check">
                        <input type="checkbox" data-module="${module.id}" ${module.locked ? 'checked disabled' : ''}>
                        <span>${escapeHtml(module.label)}</span>
                    </label>`).join('')}
            </div>
        </div>`).join('');
}

function sectionLengthRows() {
    return SECTION_LENGTH_GROUPS.map(group => `
        <label class="gwf-mini-field">
            <span>${escapeHtml(group.label)}</span>
            <select data-section-length="${group.id}">
                ${SECTION_LENGTH_OPTIONS.map(option => `<option value="${option.id}">${escapeHtml(option.label)}</option>`).join('')}
            </select>
            <input data-section-custom="${group.id}" type="number" min="100" max="20000" value="800" placeholder="目标字数" hidden>
        </label>`).join('');
}

function selectOptions(items, selected, { emptyLabel = '' } = {}) {
    return [
        ...(emptyLabel ? [`<option value="">${escapeHtml(emptyLabel)}</option>`] : []),
        ...items.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? 'selected' : ''}>${escapeHtml(item.label)}</option>`),
    ].join('');
}

function literaryStylePrompt(id) {
    return LITERARY_STYLE_PRESETS.find(item => item.id === id)?.prompt || LITERARY_STYLE_PRESETS[0]?.prompt || '';
}

function greetingSlotCard(slot, index) {
    return `
        <article class="gwf-greeting-slot" data-greeting-slot data-slot-id="${escapeHtml(slot.id)}">
            <div class="gwf-greeting-slot-heading">
                <div><strong>开场白 ${index + 1}</strong><code>${escapeHtml(slot.id)}</code></div>
                <button type="button" class="gwf-greeting-slot-remove" data-remove-greeting-slot aria-label="删除开场白任务 ${index + 1}">×</button>
            </div>
            <label class="gwf-greeting-slot-area"><span>自定义要求，留空时随机创作</span><textarea data-greeting-slot-field="customRequirement" rows="4" placeholder="例如：雨夜停电，角色在旧教学楼发现正在找人的 U">${escapeHtml(slot.customRequirement)}</textarea></label>
            <div class="gwf-greeting-slot-grid">
                <label><span>开场类型</span><select data-greeting-slot-field="openingStyle">${selectOptions(GREETING_STYLE_PRESETS, slot.openingStyle)}</select></label>
                <label><span>文学文风</span><select data-greeting-slot-field="literaryStyle">${selectOptions(LITERARY_STYLE_PRESETS, slot.literaryStyle)}</select></label>
                <label><span>文风强度</span><select data-greeting-slot-field="intensity">${selectOptions(GREETING_INTENSITY_PRESETS, slot.intensity)}</select></label>
                <label><span>开场长度</span><select data-greeting-slot-field="length">${selectOptions(GREETING_LENGTH_PRESETS, slot.length)}</select></label>
                <label class="gwf-greeting-slot-wide"><span>U 设定预设</span><select data-greeting-slot-field="userPreset">${selectOptions(GREETING_USER_PRESETS, slot.userPreset, { emptyLabel: '随机或使用下方自定义' })}</select></label>
            </div>
            <label class="gwf-greeting-slot-area"><span>自定义 U 设定，留空时随机设计</span><textarea data-greeting-slot-field="userSetting" rows="3" placeholder="例如：刚转来的奖学金生，和角色曾在小学短暂同班">${escapeHtml(slot.userSetting)}</textarea></label>
            <label class="gwf-check gwf-greeting-default"><input type="checkbox" data-greeting-slot-field="asDefault" ${slot.asDefault ? 'checked' : ''}><span>将这一条写入默认开场白</span></label>
            <details class="gwf-style-prompt-preview">
                <summary>查看内置文风提示词</summary>
                <pre class="gwf-style-preview-text">${escapeHtml(literaryStylePrompt(slot.literaryStyle))}</pre>
            </details>
        </article>`;
}

function collectGreetingSlotsFromForm() {
    if (!state.overlay) return [];
    return [...state.overlay.querySelectorAll('[data-greeting-slot]')].map((card, index) => {
        const value = field => card.querySelector(`[data-greeting-slot-field="${field}"]`);
        return {
            id: card.dataset.slotId || `greeting.slot.${String(index + 1).padStart(2, '0')}`,
            customRequirement: value('customRequirement')?.value || '',
            userPreset: value('userPreset')?.value || '',
            userSetting: value('userSetting')?.value || '',
            openingStyle: value('openingStyle')?.value || 'random',
            literaryStyle: value('literaryStyle')?.value || 'sliceRealism',
            intensity: value('intensity')?.value || 'medium',
            length: value('length')?.value || 'standard',
            asDefault: Boolean(value('asDefault')?.checked),
        };
    });
}

function renderGreetingSlots(slots) {
    const outlet = state.overlay?.querySelector('#gwf-greeting-slots');
    if (!outlet) return;
    outlet.innerHTML = slots.map(greetingSlotCard).join('');
}

function persistGreetingSlots() {
    const root = settings();
    root.options = normalizeOptions({ ...root.options, greetingSlots: collectGreetingSlotsFromForm() });
    persistSettings();
}

function nextGreetingSlotId(slots) {
    const used = new Set(slots.map(slot => slot.id));
    for (let index = 1; index <= 99; index += 1) {
        const id = `greeting.slot.${String(index).padStart(2, '0')}`;
        if (!used.has(id)) return id;
    }
    return `greeting.slot.${Date.now()}`;
}

function addGreetingSlot() {
    const slots = collectGreetingSlotsFromForm();
    if (slots.length >= 12) {
        notify('warning', '最多可以创建 12 张开场白任务卡。');
        return;
    }
    slots.push({
        id: nextGreetingSlotId(slots),
        customRequirement: '',
        userPreset: '',
        userSetting: '',
        openingStyle: 'random',
        literaryStyle: 'sliceRealism',
        intensity: 'medium',
        length: 'standard',
        asDefault: false,
    });
    renderGreetingSlots(slots);
    persistGreetingSlots();
}

function createOverlay() {
    if (state.overlay) return state.overlay;
    const overlay = document.createElement('div');
    overlay.id = 'gwf-overlay';
    overlay.className = 'gwf-overlay';
    overlay.innerHTML = `
        <div class="gwf-shell" role="dialog" aria-modal="true" aria-label="${DISPLAY_NAME}">
            <header class="gwf-header" title="拖动窗口，双击复位">
                <div>
                    <div class="gwf-eyebrow">SillyTavern Creation Studio</div>
                    <h2>${DISPLAY_NAME}</h2>
                </div>
                <div class="gwf-header-actions">
                    <label class="gwf-header-theme">
                        <span>配色</span>
                        <select id="gwf-theme-header" aria-label="配色方案">
                            ${THEME_OPTIONS.map(theme => `<option value="${theme.id}">${escapeHtml(theme.shortLabel || theme.label)}</option>`).join('')}
                        </select>
                    </label>
                    <span class="gwf-version">v${VERSION}</span>
                    <button id="gwf-close" class="menu_button gwf-icon-button" type="button" title="关闭" aria-label="关闭世界与角色工坊">×</button>
                </div>
            </header>
            <div class="gwf-workspace">
                <aside class="gwf-compose">
                    <section class="gwf-section gwf-hero-section">
                        <label for="gwf-brief" class="gwf-label">你想创作什么？</label>
                        <textarea id="gwf-brief" rows="7" placeholder="例如：现代校园背景。主角色是奖学金生，和家境优越的同桌从互相防备开始熟悉。希望阶层差异真正影响日常选择，NPC都有自己的生活。"></textarea>
                        <input id="gwf-project-name" type="text" maxlength="100" placeholder="项目名，可留空让模型命名">
                    </section>

                    <details class="gwf-section" open>
                        <summary>创作预设</summary>
                        <div class="gwf-field-block"><div class="gwf-subtitle">世界</div><div class="gwf-chip-grid">${checkedChoices(WORLD_PRESETS, 'worldPresets')}</div></div>
                        <div class="gwf-field-block"><div class="gwf-subtitle">气质</div><div class="gwf-chip-grid">${checkedChoices(TONE_PRESETS, 'tonePresets')}</div></div>
                        <div class="gwf-field-block"><div class="gwf-subtitle">主角色倾向</div><div class="gwf-chip-grid">${checkedChoices(PERSONALITY_PRESETS, 'personalityPresets')}</div></div>
                        <div class="gwf-field-block"><div class="gwf-subtitle">关系起点</div><div class="gwf-chip-grid">${checkedChoices(RELATION_PRESETS, 'relationPresets')}</div></div>
                        <div class="gwf-field-block"><div class="gwf-subtitle">经济与阶层</div><div class="gwf-chip-grid">${checkedChoices(CLASS_PRESETS, 'classPresets')}</div></div>
                    </details>

                    <details class="gwf-section" open>
                        <summary>生成内容</summary>
                        ${moduleChoices()}
                        <div class="gwf-count-row">
                            <label>NPC 数量<input id="gwf-npc-count" type="number" min="0" max="40" value="4"></label>
                            <label>关系条目<input id="gwf-relation-count" type="number" min="0" max="60" value="5"></label>
                        </div>
                    </details>

                    <details class="gwf-section" open>
                        <summary>世界书触发</summary>
                        <div class="gwf-activation-legend" aria-label="蓝灯和绿灯说明">
                            <span><b>蓝灯</b> 常驻上下文</span>
                            <span><b>绿灯</b> 关键词触发</span>
                        </div>
                        <div class="gwf-activation-guide">
                            <span><b>全部蓝灯</b> 全部常驻，记忆最完整</span>
                            <span class="is-recommended"><b>核心蓝灯</b> 核心常驻，细节触发，推荐</span>
                            <span><b>节省 Token</b> 极少常驻，占用最低</span>
                        </div>
                        <label class="gwf-row-field"><span>蓝绿灯策略</span><select id="gwf-activation-strategy">
                            ${ACTIVATION_STRATEGIES.map(strategy => `<option value="${strategy.id}">${escapeHtml(strategy.label)}</option>`).join('')}
                        </select></label>
                        <div id="gwf-activation-hint" class="gwf-hint"></div>
                    </details>

                    <details class="gwf-section" open>
                        <summary>长度与密度</summary>
                        <label class="gwf-row-field"><span>总长度</span><select id="gwf-length-preset">
                            ${Object.entries(LENGTH_PRESETS).map(([id, item]) => `<option value="${id}">${escapeHtml(item.label)}</option>`).join('')}
                        </select></label>
                        <div id="gwf-length-hint" class="gwf-hint"></div>
                        <div id="gwf-custom-length" class="gwf-custom-grid" hidden>
                            <label>角色卡目标字数<input id="gwf-custom-character" type="number" min="300" max="12000" value="1600"></label>
                            <label>世界书条目数<input id="gwf-custom-entry-count" type="number" min="3" max="150" value="22"></label>
                            <label>普通条目最少字数<input id="gwf-custom-entry-min" type="number" min="40" max="1200" value="120"></label>
                            <label>普通条目最多字数<input id="gwf-custom-entry-max" type="number" min="60" max="2000" value="240"></label>
                            <label>重要条目字数上限<input id="gwf-custom-important-max" type="number" min="100" max="3000" value="420"></label>
                            <label>NPC 数量<input id="gwf-custom-npc-count" type="number" min="0" max="40" value="4"></label>
                            <label>关系条目数<input id="gwf-custom-relation-count" type="number" min="0" max="60" value="5"></label>
                        </div>
                        <details class="gwf-nested-details">
                            <summary>分模块长度</summary>
                            <div class="gwf-section-lengths">${sectionLengthRows()}</div>
                        </details>
                    </details>

                    <details class="gwf-section" open>
                        <summary>开场白工坊</summary>
                        <div id="gwf-greeting-slots" class="gwf-greeting-slots"></div>
                        <button id="gwf-add-greeting-slot" class="menu_button gwf-greeting-slot-add" type="button">新建一个开场白</button>
                        <div class="gwf-hint">每张任务卡严格生成一条开场白。自定义要求或 U 设定留空时，模型会依据角色卡和世界书随机设计。</div>
                        <div class="gwf-greeting-actions">
                            <button id="gwf-generate-greetings" class="menu_button" type="button" disabled>生成任务卡中的开场白</button>
                            <button id="gwf-stop-greetings" class="menu_button gwf-danger" type="button" hidden>停止生成</button>
                        </div>
                        <div id="gwf-greeting-status" class="gwf-greeting-status" aria-live="polite">等待生成</div>
                    </details>

                    <details class="gwf-section" open>
                        <summary>界面外观</summary>
                        <label class="gwf-row-field"><span>配色方案</span><select id="gwf-theme">
                            ${THEME_OPTIONS.map(theme => `<option value="${theme.id}">${escapeHtml(theme.label)}</option>`).join('')}
                        </select></label>
                        <div class="gwf-hint">配色会保存在当前酒馆设置中，切换后立即应用。</div>
                    </details>

                    <details class="gwf-section">
                        <summary>参考资料</summary>
                        <label class="gwf-check"><input id="gwf-reference-character" type="checkbox"><span>参考当前角色卡</span></label>
                        <label class="gwf-check"><input id="gwf-reference-lore" type="checkbox"><span>参考当前角色的主世界书</span></label>
                        <textarea id="gwf-reference-text" rows="5" placeholder="可粘贴旧设定、灵感片段或必须保留的事实"></textarea>
                    </details>

                    <div class="gwf-generation-bar">
                        <label class="gwf-check gwf-stream-toggle"><input id="gwf-stream" type="checkbox" checked><span>流式生成</span></label>
                        <button id="gwf-generate" class="menu_button gwf-primary" type="button">开始创作</button>
                        <button id="gwf-stop" class="menu_button gwf-danger" type="button" hidden>停止</button>
                    </div>
                    <div id="gwf-status" class="gwf-status">等待创作要求</div>
                </aside>

                <main class="gwf-result-pane">
                    <div class="gwf-result-toolbar">
                        <div class="gwf-tabs">
                            <button class="gwf-tab is-active" data-tab="blueprint" type="button">蓝图编辑</button>
                            <button class="gwf-tab" data-tab="raw" type="button">JSONL</button>
                            <button class="gwf-tab" data-tab="compiled" type="button">编译预览</button>
                        </div>
                        <div id="gwf-validation" class="gwf-validation is-idle">尚未生成</div>
                    </div>
                    <div id="gwf-empty" class="gwf-empty">
                        <div class="gwf-orbit">界</div>
                        <h3>世界还在等待第一句话</h3>
                        <p>生成时，世界、角色、NPC和关系会逐项出现在这里。</p>
                    </div>
                    <div id="gwf-blueprint-view" class="gwf-blueprint-view" hidden>
                        <nav id="gwf-event-list" class="gwf-event-list"></nav>
                        <section id="gwf-event-editor" class="gwf-event-editor"></section>
                    </div>
                    <div id="gwf-raw-view" class="gwf-raw-view" hidden>
                        <textarea id="gwf-raw" spellcheck="false" readonly></textarea>
                    </div>
                    <div id="gwf-compiled-view" class="gwf-compiled-view" hidden>
                        <div class="gwf-simulator">
                            <input id="gwf-simulator-input" type="text" placeholder="输入一句聊天文本，测试世界书触发">
                            <button id="gwf-run-simulator" class="menu_button" type="button">测试触发</button>
                            <div id="gwf-simulator-result" class="gwf-simulator-result">等待测试文本</div>
                        </div>
                        <div class="gwf-compiled-columns">
                            <section><h3>角色卡</h3><pre id="gwf-card-preview"></pre></section>
                            <section><h3>世界书</h3><pre id="gwf-book-preview"></pre></section>
                        </div>
                    </div>
                    <footer id="gwf-result-actions" class="gwf-result-actions" hidden>
                        <div class="gwf-action-group">
                            <button id="gwf-export-blueprint" class="menu_button" type="button">导出蓝图</button>
                            <button id="gwf-export-jsonl" class="menu_button" type="button">导出 JSONL</button>
                            <button id="gwf-export-world" class="menu_button" type="button">导出世界书</button>
                            <button id="gwf-export-card" class="menu_button" type="button">下载角色卡</button>
                        </div>
                        <div class="gwf-action-group gwf-action-primary">
                            <button id="gwf-copy-persona" class="menu_button" type="button" hidden>复制 User 人设</button>
                            <button id="gwf-save-world" class="menu_button" type="button">写入世界书</button>
                            <button id="gwf-bind-world" class="menu_button" type="button">绑定当前角色</button>
                            <button id="gwf-create-character" class="menu_button gwf-primary" type="button">在酒馆创建角色</button>
                        </div>
                    </footer>
                </main>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    state.overlay = overlay;
    bindUi();
    fillForm(settings().options);
    const draft = settings().draftEvents;
    if (Array.isArray(draft) && draft.length) {
        state.events = draft;
        state.complete = validateBlueprint(draft).valid;
        state.selectedId = draft[0]?.id || '';
        refreshResults();
        setStatus('已恢复上次草稿');
    }
    return overlay;
}

function openStudio() {
    const overlay = createOverlay();
    overlay.classList.add('is-open');
    document.body.classList.add('gwf-modal-open');
    ensureStudioVisible();
    const shell = overlay.querySelector('.gwf-shell');
    if (shell) keepShellInViewport(overlay, shell);
}

function closeStudio() {
    if (state.generating) {
        notify('warning', '请先停止当前生成。');
        return;
    }
    state.overlay?.classList.remove('is-open');
    document.body.classList.remove('gwf-modal-open');
}

function applyShellOffset(shell) {
    const { x, y } = state.shellOffset;
    shell.style.transform = x || y ? `translate3d(${x}px, ${y}px, 0)` : '';
}

function ensureStudioVisible() {
    const header = state.overlay?.querySelector('.gwf-header');
    const workspace = state.overlay?.querySelector('.gwf-workspace');
    if (!header || !workspace) return false;
    state.overlay.scrollTop = 0;
    state.overlay.scrollLeft = 0;
    header.hidden = false;
    workspace.hidden = false;
    header.style.setProperty('display', 'flex', 'important');
    header.style.setProperty('visibility', 'visible', 'important');
    header.style.setProperty('opacity', '1', 'important');
    workspace.style.setProperty('display', globalThis.matchMedia?.('(max-width: 760px)')?.matches ? 'block' : 'grid', 'important');
    workspace.style.setProperty('visibility', 'visible', 'important');
    workspace.style.setProperty('opacity', '1', 'important');
    return true;
}

function scheduleStudioVisibilityCheck() {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(ensureStudioVisible);
    else setTimeout(ensureStudioVisible, 0);
}

function shellDragBounds(root, shell, handle) {
    const shellRect = shell.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const handleRect = handle?.getBoundingClientRect();
    if (!shellRect.width || !shellRect.height || !rootRect.width || !rootRect.height) return null;

    const padding = 10;
    const visibleWidth = Math.min(shellRect.width, Math.max(120, Math.min(180, shellRect.width * 0.18)));
    const visibleHeader = Math.min(shellRect.height, Math.max(48, Math.min(80, handleRect?.height || 64)));
    return {
        minLeft: rootRect.left - shellRect.width + visibleWidth,
        maxLeft: rootRect.right - visibleWidth,
        minTop: rootRect.top + padding,
        maxTop: Math.max(rootRect.top + padding, rootRect.bottom - visibleHeader - padding),
    };
}

function keepShellInViewport(root, shell) {
    const shellRect = shell.getBoundingClientRect();
    const bounds = shellDragBounds(root, shell, shell.querySelector('.gwf-header'));
    if (!bounds) return;
    const left = Math.min(Math.max(shellRect.left, bounds.minLeft), bounds.maxLeft);
    const top = Math.min(Math.max(shellRect.top, bounds.minTop), bounds.maxTop);
    const deltaX = left - shellRect.left;
    const deltaY = top - shellRect.top;

    if (deltaX || deltaY) {
        state.shellOffset = {
            x: state.shellOffset.x + deltaX,
            y: state.shellOffset.y + deltaY,
        };
        applyShellOffset(shell);
    }
}

function bindShellDrag(root) {
    const shell = root.querySelector('.gwf-shell');
    const handle = root.querySelector('.gwf-header');
    if (!shell || !handle) return;

    const drag = {
        active: false,
        pointerId: null,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        startOffsetX: 0,
        startOffsetY: 0,
    };

    const stopDragging = event => {
        if (!drag.active || (event.pointerId != null && event.pointerId !== drag.pointerId)) return;
        drag.active = false;
        shell.classList.remove('is-dragging');
        if (event.pointerId != null && handle.hasPointerCapture?.(event.pointerId)) {
            handle.releasePointerCapture(event.pointerId);
        }
    };

    const moveDragging = event => {
        if (!drag.active || event.pointerId !== drag.pointerId) return;

        const bounds = shellDragBounds(root, shell, handle);
        if (!bounds) return;
        const left = Math.min(Math.max(drag.startLeft + event.clientX - drag.startX, bounds.minLeft), bounds.maxLeft);
        const top = Math.min(Math.max(drag.startTop + event.clientY - drag.startY, bounds.minTop), bounds.maxTop);

        state.shellOffset = {
            x: drag.startOffsetX + left - drag.startLeft,
            y: drag.startOffsetY + top - drag.startTop,
        };
        applyShellOffset(shell);
        event.preventDefault();
    };

    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.isPrimary === false || event.target.closest?.('button, a, input, textarea, select, [contenteditable="true"]')) return;

        const shellRect = shell.getBoundingClientRect();
        drag.active = true;
        drag.pointerId = event.pointerId;
        drag.startX = event.clientX;
        drag.startY = event.clientY;
        drag.startLeft = shellRect.left;
        drag.startTop = shellRect.top;
        drag.startOffsetX = state.shellOffset.x;
        drag.startOffsetY = state.shellOffset.y;
        shell.classList.add('is-dragging');
        handle.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    });

    handle.addEventListener('dblclick', event => {
        if (event.target.closest?.('button, a, input, textarea, select, [contenteditable="true"]')) return;
        state.shellOffset = { x: 0, y: 0 };
        applyShellOffset(shell);
        keepShellInViewport(root, shell);
    });

    window.addEventListener('pointermove', moveDragging, { capture: true, passive: false });
    window.addEventListener('pointerup', stopDragging, { capture: true });
    window.addEventListener('pointercancel', stopDragging, { capture: true });
    handle.addEventListener('lostpointercapture', stopDragging);
    window.addEventListener('resize', () => keepShellInViewport(root, shell), { passive: true });
    applyShellOffset(shell);
}

function createEntryPoints() {
    if (!document.querySelector('#gwf-settings-block')) {
        const block = document.createElement('div');
        block.id = 'gwf-settings-block';
        block.className = 'extension_container';
        block.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>${DISPLAY_NAME}</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <p>使用当前酒馆连接生成角色卡与世界书，无需额外 API Key。</p>
                    <button id="gwf-open-settings" class="menu_button" type="button">打开创作工坊</button>
                    <label class="checkbox_label"><input id="gwf-show-fab" type="checkbox"><span>显示悬浮入口</span></label>
                </div>
            </div>`;
        document.querySelector('#extensions_settings2')?.appendChild(block);
        block.querySelector('#gwf-open-settings')?.addEventListener('click', openStudio);
        const toggle = block.querySelector('#gwf-show-fab');
        toggle.checked = settings().showFloatingButton !== false;
        toggle.addEventListener('change', event => {
            settings().showFloatingButton = Boolean(event.target.checked);
            updateFab();
            persistSettings();
        });
    }
    if (!document.querySelector('#gwf-fab')) {
        const fab = document.createElement('button');
        fab.id = 'gwf-fab';
        fab.className = 'gwf-fab';
        fab.type = 'button';
        fab.title = '点击打开工坊，拖动调整位置';
        fab.setAttribute('aria-label', `打开${DISPLAY_NAME}`);
        bindFabDrag(fab);
        document.body.appendChild(fab);
        applyFabPosition(fab);
    }
    applyTheme(settings().options.theme);
    updateFab();
}

function clampFabCoordinate(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function applyFabPosition(fab, { save = false } = {}) {
    const stored = settings().fabPosition;
    const leftValue = Number(stored?.left);
    const topValue = Number(stored?.top);
    if (!Number.isFinite(leftValue) || !Number.isFinite(topValue)) {
        fab.style.removeProperty('left');
        fab.style.removeProperty('top');
        fab.style.removeProperty('right');
        fab.style.removeProperty('bottom');
        return;
    }

    const margin = 8;
    const width = fab.offsetWidth || 52;
    const height = fab.offsetHeight || 52;
    const left = clampFabCoordinate(leftValue, margin, window.innerWidth - width - margin);
    const top = clampFabCoordinate(topValue, margin, window.innerHeight - height - margin);
    fab.style.left = `${left}px`;
    fab.style.top = `${top}px`;
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';

    if (save && (left !== leftValue || top !== topValue)) {
        settings().fabPosition = { left: Math.round(left), top: Math.round(top) };
        persistSettings();
    }
}

function bindFabDrag(fab) {
    const drag = {
        active: false,
        moved: false,
        pointerId: null,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
    };
    let suppressClick = false;
    let suppressTimer = 0;

    const stopDragging = event => {
        if (!drag.active || event.pointerId !== drag.pointerId) return;
        drag.active = false;
        fab.classList.remove('is-dragging');
        try {
            if (fab.hasPointerCapture?.(event.pointerId)) fab.releasePointerCapture(event.pointerId);
        } catch { /* pointer capture is optional */ }

        if (drag.moved) {
            settings().fabPosition = {
                left: Math.round(Number.parseFloat(fab.style.left) || fab.getBoundingClientRect().left),
                top: Math.round(Number.parseFloat(fab.style.top) || fab.getBoundingClientRect().top),
            };
            persistSettings();
            suppressClick = true;
            clearTimeout(suppressTimer);
            suppressTimer = window.setTimeout(() => { suppressClick = false; }, 400);
        }
    };

    fab.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.isPrimary === false) return;
        fab.classList.add('is-dragging');
        const rect = fab.getBoundingClientRect();
        drag.active = true;
        drag.moved = false;
        drag.pointerId = event.pointerId;
        drag.startX = event.clientX;
        drag.startY = event.clientY;
        drag.startLeft = rect.left;
        drag.startTop = rect.top;
        try { fab.setPointerCapture?.(event.pointerId); } catch { /* pointer capture is optional */ }
    });

    window.addEventListener('pointermove', event => {
        if (!drag.active || event.pointerId !== drag.pointerId) return;
        const deltaX = event.clientX - drag.startX;
        const deltaY = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(deltaX, deltaY) < 4) return;
        drag.moved = true;

        const margin = 8;
        const left = clampFabCoordinate(drag.startLeft + deltaX, margin, window.innerWidth - fab.offsetWidth - margin);
        const top = clampFabCoordinate(drag.startTop + deltaY, margin, window.innerHeight - fab.offsetHeight - margin);
        fab.style.left = `${left}px`;
        fab.style.top = `${top}px`;
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        event.preventDefault();
    }, { capture: true, passive: false });

    window.addEventListener('pointerup', stopDragging, { capture: true });
    window.addEventListener('pointercancel', stopDragging, { capture: true });
    window.addEventListener('resize', () => applyFabPosition(fab, { save: true }), { passive: true });
    fab.addEventListener('dragstart', event => event.preventDefault());
    fab.addEventListener('click', event => {
        if (suppressClick) {
            suppressClick = false;
            clearTimeout(suppressTimer);
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        openStudio();
    });
}

function updateFab() {
    const fab = document.querySelector('#gwf-fab');
    if (fab) fab.hidden = settings().showFloatingButton === false;
}

function applyTheme(theme) {
    const normalized = normalizeOptions({ theme }).theme;
    if (state.overlay) state.overlay.dataset.theme = normalized;
    document.body.dataset.gwfTheme = normalized;
    for (const selector of ['#gwf-theme', '#gwf-theme-header']) {
        const control = state.overlay?.querySelector(selector);
        if (control && control.value !== normalized) control.value = normalized;
    }
}

function setStatus(message, tone = '') {
    const element = state.overlay?.querySelector('#gwf-status');
    if (!element) return;
    element.textContent = message;
    element.dataset.tone = tone;
}

function setGenerating(value) {
    state.generating = value;
    const generate = state.overlay?.querySelector('#gwf-generate');
    const stop = state.overlay?.querySelector('#gwf-stop');
    if (generate) generate.disabled = value;
    if (stop) stop.hidden = !value;
}

function selectedValues(selector) {
    return [...state.overlay.querySelectorAll(`${selector}:checked`)].map(input => input.value);
}

function numberValue(selector, fallback) {
    const value = Number(state.overlay.querySelector(selector)?.value);
    return Number.isFinite(value) ? value : fallback;
}

function collectOptions() {
    const options = normalizeOptions({
        brief: state.overlay.querySelector('#gwf-brief')?.value,
        projectName: state.overlay.querySelector('#gwf-project-name')?.value,
        referenceText: state.overlay.querySelector('#gwf-reference-text')?.value,
        worldPresets: selectedValues('[data-preset-group="worldPresets"]'),
        tonePresets: selectedValues('[data-preset-group="tonePresets"]'),
        personalityPresets: selectedValues('[data-preset-group="personalityPresets"]'),
        relationPresets: selectedValues('[data-preset-group="relationPresets"]'),
        classPresets: selectedValues('[data-preset-group="classPresets"]'),
        modules: Object.fromEntries([...state.overlay.querySelectorAll('[data-module]')].map(input => [input.dataset.module, input.checked])),
        lengthPreset: state.overlay.querySelector('#gwf-length-preset')?.value,
        theme: state.overlay.querySelector('#gwf-theme-header')?.value || state.overlay.querySelector('#gwf-theme')?.value,
        activationStrategy: state.overlay.querySelector('#gwf-activation-strategy')?.value,
        greetingSlots: collectGreetingSlotsFromForm(),
        customLength: {
            characterChars: numberValue('#gwf-custom-character', 1600),
            entryCount: numberValue('#gwf-custom-entry-count', 22),
            entryMinChars: numberValue('#gwf-custom-entry-min', 120),
            entryMaxChars: numberValue('#gwf-custom-entry-max', 240),
            importantEntryMaxChars: numberValue('#gwf-custom-important-max', 420),
            npcCount: numberValue('#gwf-custom-npc-count', 4),
            relationCount: numberValue('#gwf-custom-relation-count', 5),
        },
        sectionLengths: Object.fromEntries([...state.overlay.querySelectorAll('[data-section-length]')].map(select => {
            const target = numberValue(`[data-section-custom="${select.dataset.sectionLength}"]`, 800);
            return [select.dataset.sectionLength, select.value === 'custom' ? { mode: 'custom', targetChars: target } : select.value];
        })),
        npcCount: numberValue('#gwf-npc-count', 4),
        relationCount: numberValue('#gwf-relation-count', 5),
        stream: state.overlay.querySelector('#gwf-stream')?.checked,
        referenceCurrentCharacter: state.overlay.querySelector('#gwf-reference-character')?.checked,
        referencePrimaryLorebook: state.overlay.querySelector('#gwf-reference-lore')?.checked,
    });
    settings().options = options;
    persistSettings();
    return options;
}

function fillForm(rawOptions) {
    const options = normalizeOptions(rawOptions);
    const setValue = (selector, value) => {
        const element = state.overlay.querySelector(selector);
        if (element) element.value = value ?? '';
    };
    setValue('#gwf-brief', options.brief);
    setValue('#gwf-project-name', options.projectName);
    setValue('#gwf-reference-text', options.referenceText);
    setValue('#gwf-length-preset', options.lengthPreset);
    setValue('#gwf-theme', options.theme);
    setValue('#gwf-theme-header', options.theme);
    setValue('#gwf-activation-strategy', options.activationStrategy);
    setValue('#gwf-npc-count', options.npcCount);
    setValue('#gwf-relation-count', options.relationCount);
    setValue('#gwf-custom-character', options.customLength.characterChars);
    setValue('#gwf-custom-entry-count', options.customLength.entryCount);
    setValue('#gwf-custom-entry-min', options.customLength.entryMinChars);
    setValue('#gwf-custom-entry-max', options.customLength.entryMaxChars);
    setValue('#gwf-custom-important-max', options.customLength.importantEntryMaxChars);
    setValue('#gwf-custom-npc-count', options.customLength.npcCount);
    setValue('#gwf-custom-relation-count', options.customLength.relationCount);
    for (const input of state.overlay.querySelectorAll('[data-preset-group]')) input.checked = options[input.dataset.presetGroup]?.includes(input.value) || false;
    for (const input of state.overlay.querySelectorAll('[data-module]')) input.checked = input.disabled || Boolean(options.modules[input.dataset.module]);
    for (const select of state.overlay.querySelectorAll('[data-section-length]')) {
        const selected = options.sectionLengths?.[select.dataset.sectionLength] || 'global';
        select.value = typeof selected === 'object' ? selected.mode || 'global' : selected;
        const custom = state.overlay.querySelector(`[data-section-custom="${select.dataset.sectionLength}"]`);
        if (custom) custom.value = typeof selected === 'object' ? selected.targetChars || 800 : 800;
    }
    state.overlay.querySelector('#gwf-stream').checked = options.stream !== false;
    state.overlay.querySelector('#gwf-reference-character').checked = options.referenceCurrentCharacter;
    state.overlay.querySelector('#gwf-reference-lore').checked = options.referencePrimaryLorebook;
    renderGreetingSlots(options.greetingSlots);
    applyTheme(options.theme);
    updateActivationStrategyUi();
    updateLengthUi();
    updateSectionLengthUi();
}

function updateSectionLengthUi() {
    for (const select of state.overlay.querySelectorAll('[data-section-length]')) {
        const custom = state.overlay.querySelector(`[data-section-custom="${select.dataset.sectionLength}"]`);
        if (custom) custom.hidden = select.value !== 'custom';
    }
}

function updateActivationStrategyUi() {
    const id = state.overlay?.querySelector('#gwf-activation-strategy')?.value || 'coreBlue';
    const strategy = ACTIVATION_STRATEGIES.find(item => item.id === id) || ACTIVATION_STRATEGIES[1] || ACTIVATION_STRATEGIES[0];
    const hint = state.overlay?.querySelector('#gwf-activation-hint');
    if (!hint) return;
    let counts = '';
    if (state.events.length) {
        try {
            const entries = Object.values(compileWorldBook(state.events, '', { activationStrategy: id }).entries);
            const blue = entries.filter(entry => entry.constant).length;
            counts = ` 当前结果：蓝灯 ${blue} 条，绿灯 ${entries.length - blue} 条。`;
        } catch { /* 生成中的不完整事件暂时不显示统计 */ }
    }
    hint.textContent = (strategy?.description || '') + counts;
}

function updateLengthUi() {
    const preset = state.overlay.querySelector('#gwf-length-preset')?.value || 'auto';
    const custom = state.overlay.querySelector('#gwf-custom-length');
    if (custom) custom.hidden = preset !== 'custom';
    const options = collectOptionsWithoutSaving();
    const plan = resolveLengthPlan(options);
    const hint = state.overlay.querySelector('#gwf-length-hint');
    if (hint) hint.textContent = `角色卡约 ${plan.character[0]} 至 ${plan.character[1]} 字，世界书约 ${plan.entries[0]} 至 ${plan.entries[1]} 条。`;
}

function collectOptionsWithoutSaving() {
    const base = settings().options;
    return normalizeOptions({
        ...base,
        lengthPreset: state.overlay.querySelector('#gwf-length-preset')?.value || base.lengthPreset,
        theme: state.overlay.querySelector('#gwf-theme-header')?.value || state.overlay.querySelector('#gwf-theme')?.value || base.theme,
        activationStrategy: state.overlay.querySelector('#gwf-activation-strategy')?.value || base.activationStrategy,
        greetingSlots: collectGreetingSlotsFromForm().length ? collectGreetingSlotsFromForm() : base.greetingSlots,
        modules: Object.fromEntries([...state.overlay.querySelectorAll('[data-module]')].map(input => [input.dataset.module, input.checked])),
        npcCount: numberValue('#gwf-npc-count', base.npcCount),
        relationCount: numberValue('#gwf-relation-count', base.relationCount),
        customLength: {
            characterChars: numberValue('#gwf-custom-character', base.customLength.characterChars),
            entryCount: numberValue('#gwf-custom-entry-count', base.customLength.entryCount),
            entryMinChars: numberValue('#gwf-custom-entry-min', base.customLength.entryMinChars),
            entryMaxChars: numberValue('#gwf-custom-entry-max', base.customLength.entryMaxChars),
            importantEntryMaxChars: numberValue('#gwf-custom-important-max', base.customLength.importantEntryMaxChars),
            npcCount: numberValue('#gwf-custom-npc-count', base.customLength.npcCount),
            relationCount: numberValue('#gwf-custom-relation-count', base.customLength.relationCount),
        },
    });
}

async function buildReferences(options) {
    const ctx = getContext();
    const references = { characterText: '', loreText: '' };
    const characterId = Number(ctx.characterId);
    const character = Number.isInteger(characterId) && characterId >= 0 ? ctx.characters?.[characterId] : null;
    if (options.referenceCurrentCharacter && character) {
        await ctx.unshallowCharacter?.(ctx.characterId);
        const data = character.data || character;
        references.characterText = JSON.stringify({
            name: data.name || character.name,
            description: data.description,
            personality: data.personality,
            scenario: data.scenario,
            first_mes: data.first_mes,
            mes_example: data.mes_example,
            creator_notes: data.creator_notes,
        }, null, 2).slice(0, 30000);
    }
    if (options.referencePrimaryLorebook && character) {
        const data = character.data || character;
        const worldName = data.extensions?.world || character.extensions?.world;
        if (worldName) {
            const book = await ctx.loadWorldInfo?.(worldName);
            if (book) {
                references.loreText = Object.values(book.entries || {})
                    .sort((a, b) => Number(b.order || 0) - Number(a.order || 0))
                    .map(entry => `【${entry.comment || entry.uid}】\n${entry.content || ''}`)
                    .join('\n\n')
                    .slice(0, 50000);
            }
        }
    }
    return references;
}

function resetGeneration() {
    state.greetingAbortController?.abort();
    state.events = [];
    state.raw = '';
    state.selectedId = '';
    state.complete = false;
    state.greetingGenerating = false;
    state.greetingAbortController = null;
    state.greetingParser = null;
    state.greetingEvents = [];
    state.greetingRaw = '';
    setGreetingGenerating(false);
    state.savedWorldName = '';
    state.validation = { valid: false, errors: [], warnings: [] };
    state.styleIssues = [];
    state.lengthIssues = [];
    state.overlay.querySelector('#gwf-raw').value = '';
    setGreetingStatus('等待生成');
    refreshResults();
}

async function repairMalformedJsonl(raw, options) {
    if (!raw.trim() || raw.length > 180000) throw new Error('JSONL 过长，无法自动修复语法');
    setStatus('检测到 JSONL 语法问题，正在修复格式', 'working');
    const ctx = getContext();
    const result = await generateWithFallback(ctx, {
        systemPrompt: '你是 JSONL 语法修复器。保留全部事实和事件顺序，只修复 JSON 语法与输出协议。每行输出一个完整 JSON 对象。禁止 Markdown 与解释。',
        prompt: `请修复以下 JSONL。最后一行必须是 done。\n\n${raw}`,
        preferStream: false,
        signal: state.abortController?.signal,
    });
    const parser = new JsonlStreamParser();
    parser.pushCumulative(result.text);
    const parsed = parser.finish();
    if (parsed.errors.length) throw new Error(`自动语法修复仍有 ${parsed.errors.length} 行无法解析`);
    return { events: parsed.events, raw: result.text };
}

async function repairInvalidBlueprint(events, errors) {
    const raw = serializeJsonl(events);
    if (!raw.trim() || raw.length > 180000) throw new Error('蓝图过长，无法自动修复结构字段');
    setStatus(`检测到 ${errors.length} 个蓝图结构问题，正在修复字段`, 'working');
    const schemas = outputSchemaExamples();
    const result = await generateWithFallback(getContext(), {
        systemPrompt: [
            '你是 JSONL 蓝图结构修复器。',
            '保留全部创作事实、正文、角色关系、事件ID和原有顺序。',
            '只补齐或修正结构字段、事件类型、字段类型、事件顺序与 done 计数。',
            '每行输出一个完整 JSON 对象。只输出 JSONL，禁止 Markdown 与解释。',
        ].join('\n'),
        prompt: [
            '【校验问题】',
            JSON.stringify(errors),
            '',
            '【事件结构示例】',
            JSON.stringify(schemas),
            '',
            '【待修复 JSONL】',
            raw,
        ].join('\n'),
        preferStream: false,
        signal: state.abortController?.signal,
    });
    const parser = new JsonlStreamParser();
    parser.pushCumulative(result.text);
    const parsed = parser.finish();
    if (parsed.errors.length) throw new Error(`结构修复结果仍有 ${parsed.errors.length} 个 JSON 对象无法解析`);
    return { events: parsed.events, raw: result.text };
}

async function repairContentIssues(events, issues) {
    if (!issues.length) return events;
    setStatus(`正在修复 ${issues.length} 个文风或长度问题`, 'working');
    const result = await generateWithFallback(getContext(), {
        systemPrompt: '你是结构化文本的局部修订编辑器。只按用户给出的 patch 协议输出 JSONL。',
        prompt: buildRepairPrompt(issues, events),
        preferStream: false,
        signal: state.abortController?.signal,
    });
    return applyPatches(events, parsePatchJsonl(result.text));
}

function filterUnselectedEvents(events, options) {
    const categoryModules = {
        ROMANCE: 'romance',
        INTIMACY: 'intimacy',
        NSFW_PREFERENCE: 'nsfwPreference',
        NSFW_BEHAVIOR: 'nsfwBehavior',
        NSFW_DYNAMIC: 'nsfwBehavior',
        NSFW_SPEECH: 'nsfwSpeech',
        NSFW_PHYSIOLOGY: 'nsfwPhysiology',
        NSFW_AFTERCARE: 'nsfwAftercare',
        NSFW_SCENARIO: 'nsfwScenarios',
    };
    return events.filter(event => {
        if (event.type === 'character' && event.role === 'user') return Boolean(options.modules.userPersona);
        const requiredModule = categoryModules[event.category];
        return !requiredModule || Boolean(options.modules[requiredModule]);
    });
}

function applyProjectCompileSettings(events, options) {
    const project = events.find(event => event.type === 'project');
    if (!project) return;
    const strategy = options.activationStrategy || 'coreBlue';
    project.recommendedSettings = {
        ...(project.recommendedSettings || {}),
        scanDepth: 4,
        budgetPercent: strategy === 'allBlue' ? 35 : 25,
        recursiveScanning: strategy !== 'allBlue',
        activationStrategy: strategy,
    };
}

async function generateProject() {
    if (state.generating || state.greetingGenerating) return;
    const options = collectOptions();
    if (!options.brief && !options.worldPresets.length) {
        notify('warning', '写一点创作要求，或者至少选择一个世界预设。');
        state.overlay.querySelector('#gwf-brief')?.focus();
        return;
    }
    resetGeneration();
    setGenerating(true);
    state.abortController = new AbortController();
    const plan = resolveLengthPlan(options);
    try {
        setStatus('正在整理参考资料', 'working');
        const references = await buildReferences(options);
        const systemPrompt = buildSystemPrompt();
        const prompt = buildGenerationPrompt(options, references);
        state.parser = new JsonlStreamParser({
            onEvent: event => {
                state.events.push(event);
                state.selectedId ||= event.id;
                refreshResults({ preserveEditor: true });
            },
            onError: detail => console.warn(`[${DISPLAY_NAME}] JSONL 第 ${detail.lineNumber} 行暂时无法解析`, detail.message),
        });
        setStatus('正在连接当前酒馆模型', 'working');
        const result = await generateWithFallback(getContext(), {
            systemPrompt,
            prompt,
            preferStream: options.stream,
            signal: state.abortController.signal,
            onText: (text, meta) => {
                state.raw = text;
                state.parser.pushCumulative(text);
                const rawBox = state.overlay.querySelector('#gwf-raw');
                if (rawBox) {
                    rawBox.value = text;
                    rawBox.scrollTop = rawBox.scrollHeight;
                }
                setStatus(`正在接收：${state.events.length} 个完整事件，${meta.length || text.length} 字符`, 'working');
            },
            onStatus: meta => {
                if (meta.phase === 'fallback') setStatus(`流式连接未完成，已切换普通生成：${meta.reason}`, 'working');
            },
        });
        let parsed = state.parser.finish(result.text);
        state.events = parsed.events;
        state.raw = parsed.raw;
        if (parsed.errors.length) {
            const repaired = await repairMalformedJsonl(state.raw, options);
            state.events = repaired.events;
            state.raw = repaired.raw;
        }
        state.events = filterUnselectedEvents(state.events, options);

        let baseValidation = validateBlueprint(state.events);
        if (!baseValidation.valid) {
            const repaired = await repairInvalidBlueprint(state.events, baseValidation.errors);
            state.events = filterUnselectedEvents(repaired.events, options);
            state.raw = repaired.raw;
            baseValidation = validateBlueprint(state.events);
            if (!baseValidation.valid) throw new Error(baseValidation.errors.join('；'));
        }
        applyProjectCompileSettings(state.events, options);
        let issues = [...findStyleIssues(state.events), ...findLengthIssues(state.events, plan)];
        if (issues.length) {
            state.events = await repairContentIssues(state.events, issues);
            issues = [...findStyleIssues(state.events), ...findLengthIssues(state.events, plan)];
            if (issues.length) throw new Error(`自动修复后仍有 ${issues.length} 个文风或长度问题，请在编辑区手动调整`);
        }

        state.complete = true;
        state.selectedId ||= state.events[0]?.id || '';
        persistDraft();
        refreshResults();
        setStatus(`创作完成：${aggregateBlueprint(state.events).loreEvents.length} 个世界书条目`, 'success');
        notify('success', '世界蓝图、角色卡和世界书已经生成。');
    } catch (error) {
        if (state.abortController?.signal.aborted || error?.name === 'AbortError') {
            setStatus(`已停止。保留 ${state.events.length} 个草稿事件，未写入酒馆。`, 'warning');
        } else {
            console.error(`[${DISPLAY_NAME}] 生成失败`, error);
            setStatus(`生成未完成：${String(error?.message || error)}`, 'error');
            notify('error', String(error?.message || error));
        }
        state.complete = false;
        refreshResults();
    } finally {
        state.abortController = null;
        state.parser = null;
        setGenerating(false);
    }
}

function setGreetingStatus(message, tone = '') {
    const element = state.overlay?.querySelector('#gwf-greeting-status');
    if (!element) return;
    element.textContent = message;
    element.dataset.tone = tone;
}

function setGreetingGenerating(value) {
    state.greetingGenerating = value;
    const generate = state.overlay?.querySelector('#gwf-generate-greetings');
    const stop = state.overlay?.querySelector('#gwf-stop-greetings');
    if (generate) generate.disabled = value || !state.complete;
    if (stop) stop.hidden = !value;
}

function normalizeGreetingEvents(events, slots = []) {
    const expectedSlots = Array.isArray(slots) ? slots : [];
    const slotIndex = new Map(expectedSlots.map((slot, index) => [slot.id, index]));
    const usedSlots = new Set();
    return events
        .filter(event => event?.type === 'greeting' && String(event.text || '').trim())
        .map((event, index) => {
            const requestedIndex = Math.max(0, (Number(event.index) || index + 1) - 1);
            const rawSlotId = String(event.slotId || '').trim();
            const slot = expectedSlots.find(item => item.id === rawSlotId) || expectedSlots[requestedIndex] || null;
            const slotId = slot?.id || rawSlotId || `greeting.slot.${String(index + 1).padStart(2, '0')}`;
            if (usedSlots.has(slotId)) return null;
            usedSlots.add(slotId);
            const outputIndex = slotIndex.has(slotId) ? slotIndex.get(slotId) + 1 : requestedIndex + 1;
            return {
                type: 'greeting',
                id: String(event.id || '').trim() || `greeting.${String(outputIndex).padStart(2, '0')}`,
                slotId,
                index: outputIndex,
                style: String(event.style || '自由风格').trim(),
                literaryStyle: String(event.literaryStyle || '自由文风').trim(),
                userSetting: String(event.userSetting || '自由进入').trim(),
                text: String(event.text).trim(),
            };
        })
        .filter(Boolean)
        .sort((a, b) => {
            const left = slotIndex.has(a.slotId) ? slotIndex.get(a.slotId) : a.index - 1;
            const right = slotIndex.has(b.slotId) ? slotIndex.get(b.slotId) : b.index - 1;
            return left - right;
        });
}

function appendGeneratedGreetings(greetings, options) {
    const main = aggregateBlueprint(state.events).mainCharacter;
    if (!main) throw new Error('没有可添加开场白的主角色卡');
    const slots = new Map((options?.greetingSlots || []).map(slot => [slot.id, slot]));
    const current = Array.isArray(main.alternateGreetings) ? main.alternateGreetings : [];
    const additions = [];
    const defaults = new Set();
    for (const greeting of greetings) {
        if (slots.get(greeting.slotId)?.asDefault) {
            main.firstMessage = greeting.text;
            defaults.add(greeting.text);
        }
        else additions.push(greeting.text);
    }
    main.alternateGreetings = [...new Set([...current.filter(text => !defaults.has(text)), ...additions])].slice(0, 30);
}

async function generateGreetings() {
    if (state.generating || state.greetingGenerating) return;
    const blueprint = aggregateBlueprint(state.events);
    if (!blueprint.mainCharacter) {
        notify('warning', '请先完成一次角色卡创作，再生成开场白。');
        return;
    }
    const options = collectOptions();
    const controller = new AbortController();
    state.greetingGenerating = true;
    state.greetingAbortController = controller;
    state.greetingEvents = [];
    state.greetingRaw = '';
    state.greetingParser = new JsonlStreamParser({
        onEvent: event => {
            state.greetingEvents = normalizeGreetingEvents([...state.greetingEvents, event], options.greetingSlots);
            if (state.greetingEvents.length) {
                setGreetingStatus('已接收 ' + state.greetingEvents.length + ' 条开场白', 'working');
            }
        },
        onError: detail => console.warn('[' + DISPLAY_NAME + '] 开场白 JSONL 第 ' + detail.lineNumber + ' 行暂时无法解析', detail.message),
    });
    setGreetingGenerating(true);
    setGreetingStatus('正在根据角色卡准备多种进入方式', 'working');
    try {
        const result = await generateWithFallback(getContext(), {
            systemPrompt: buildGreetingSystemPrompt(),
            prompt: buildGreetingPrompt(blueprint, options),
            preferStream: options.stream,
            signal: controller.signal,
            onText: (text, meta) => {
                state.greetingRaw = text;
                state.greetingParser.pushCumulative(text);
                setGreetingStatus('正在生成，已接收 ' + state.greetingEvents.length + ' 条 · ' + (meta?.length || text.length) + ' 字符', 'working');
            },
        });
        const parsed = state.greetingParser.finish(result.text);
        const greetings = normalizeGreetingEvents(parsed.events, options.greetingSlots).slice(0, options.greetingSlots.length);
        if (!greetings.length) throw new Error('模型没有返回可用的开场白');
        const returnedSlots = new Set(greetings.map(greeting => greeting.slotId));
        const missing = options.greetingSlots
            .map((slot, index) => returnedSlots.has(slot.id) ? '' : `开场白 ${index + 1}`)
            .filter(Boolean);
        if (missing.length) throw new Error(`模型遗漏了${missing.join('、')}，请再次生成`);
        state.greetingEvents = greetings;
        appendGeneratedGreetings(greetings, options);
        persistDraft();
        refreshResults();
        const defaultCount = options.greetingSlots.some(slot => slot.asDefault) ? 1 : 0;
        const resultText = defaultCount ? `已更新默认开场白，并加入 ${greetings.length - 1} 条备用开场白` : `已加入 ${greetings.length} 条备用开场白`;
        setGreetingStatus(resultText + '，可在主角色卡中逐条编辑', 'success');
        setStatus(resultText, 'success');
        notify('success', '任务卡中的开场白已经生成并加入主角色卡。');
    } catch (error) {
        if (controller.signal.aborted || error?.name === 'AbortError') {
            if (state.greetingEvents.length) {
                appendGeneratedGreetings(state.greetingEvents, options);
                persistDraft();
                refreshResults();
            }
            setGreetingStatus('已停止，已保留已接收的开场白', 'warning');
        } else {
            console.error('[' + DISPLAY_NAME + '] 开场白生成失败', error);
            setGreetingStatus('生成未完成：' + String(error?.message || error), 'error');
            notify('error', String(error?.message || error));
        }
    } finally {
        if (state.greetingAbortController === controller) state.greetingAbortController = null;
        state.greetingParser = null;
        setGreetingGenerating(false);
        refreshResults();
    }
}

function stopGreetingGeneration() {
    state.greetingAbortController?.abort(new DOMException('用户停止开场白生成', 'AbortError'));
}

function stopGeneration() {
    state.abortController?.abort(new DOMException('用户停止生成', 'AbortError'));
    stopGreetingGeneration();
    try { getContext().stopGeneration?.(); } catch { /* host fallback */ }
}

function persistDraft() {
    try {
        const serialized = JSON.stringify(state.events);
        settings().draftEvents = serialized.length <= 600000 ? state.events : [];
        persistSettings();
    } catch {
        settings().draftEvents = [];
    }
}

function eventLabel(event) {
    if (event.type === 'project') return event.name || '项目';
    if (event.type === 'character') return `${event.role === 'user' ? 'User' : '角色'}：${event.name || event.id}`;
    return event.title || event.id;
}

function eventHasIssue(id) {
    return [...state.styleIssues, ...state.lengthIssues].some(issue => issue.id === id);
}

function refreshResults({ preserveEditor = false } = {}) {
    if (!state.overlay) return;
    const hasEvents = state.events.length > 0;
    state.overlay.querySelector('#gwf-empty').hidden = hasEvents;
    state.overlay.querySelector('#gwf-result-actions').hidden = !hasEvents;
    state.overlay.querySelector('#gwf-blueprint-view').hidden = !hasEvents || state.activeTab !== 'blueprint';
    state.overlay.querySelector('#gwf-raw-view').hidden = !hasEvents || state.activeTab !== 'raw';
    state.overlay.querySelector('#gwf-compiled-view').hidden = !hasEvents || state.activeTab !== 'compiled';
    if (!hasEvents) return;

    state.validation = validateBlueprint(state.events, { requireDone: state.complete });
    state.styleIssues = findStyleIssues(state.events);
    state.lengthIssues = findLengthIssues(state.events, resolveLengthPlan(collectOptionsWithoutSaving()));
    const issueCount = state.styleIssues.length + state.lengthIssues.length;
    const validation = state.overlay.querySelector('#gwf-validation');
    const ready = state.complete && state.validation.valid && issueCount === 0;
    validation.className = `gwf-validation ${ready ? 'is-valid' : state.generating ? 'is-working' : 'is-invalid'}`;
    validation.textContent = ready
        ? `可写入酒馆 · ${state.events.length} 个事件`
        : state.generating
            ? `生成中 · ${state.events.length} 个事件`
            : `${state.validation.errors.length + issueCount} 个待处理问题`;

    const list = state.overlay.querySelector('#gwf-event-list');
    list.innerHTML = state.events.map(event => `
        <button type="button" class="gwf-event-item ${event.id === state.selectedId ? 'is-active' : ''} ${eventHasIssue(event.id) ? 'has-issue' : ''}" data-event-id="${escapeHtml(event.id)}">
            <span class="gwf-event-type">${escapeHtml(event.type)}</span>
            <span class="gwf-event-name">${escapeHtml(eventLabel(event))}</span>
        </button>`).join('');
    list.querySelectorAll('[data-event-id]').forEach(button => button.addEventListener('click', () => {
        state.selectedId = button.dataset.eventId;
        refreshResults();
    }));
    if (!preserveEditor || !state.overlay.querySelector('#gwf-event-editor [data-field]:focus')) renderEditor();
    state.overlay.querySelector('#gwf-raw').value = serializeJsonl(state.events);
    updateCompiledPreview();
    updateActivationStrategyUi();
    updateActionState(ready);
}

function field(label, path, value, { area = false, kind = 'string', rows = 3, readonly = false } = {}) {
    const content = area
        ? `<textarea data-field="${path}" data-kind="${kind}" rows="${rows}" ${readonly ? 'readonly' : ''}>${escapeHtml(value ?? '')}</textarea>`
        : `<input data-field="${path}" data-kind="${kind}" type="${kind === 'number' ? 'number' : 'text'}" value="${escapeHtml(value ?? '')}" ${readonly ? 'readonly' : ''}>`;
    return `<label class="gwf-editor-field"><span>${escapeHtml(label)}</span>${content}</label>`;
}

function greetingManager(event) {
    const greetings = Array.isArray(event.alternateGreetings) ? event.alternateGreetings : [];
    const items = greetings.map((text, index) => {
        const profile = state.greetingEvents.find(item => item.text === text);
        const profileText = profile ? ' · ' + escapeHtml(profile.style) + ' · ' + escapeHtml(profile.literaryStyle) + ' · ' + escapeHtml(profile.userSetting) : '';
        return (
            '<article class="gwf-greeting-item">' +
            '<div class="gwf-greeting-item-heading">' +
            '<span>备用开场白 ' + (index + 1) + profileText + '</span>' +
            '<button type="button" class="gwf-greeting-remove" data-remove-greeting="' + index + '" aria-label="删除备用开场白 ' + (index + 1) + '">×</button>' +
            '</div>' +
            '<textarea data-greeting-index="' + index + '" rows="7">' + escapeHtml(text) + '</textarea>' +
            '</article>'
        );
    }).join('');
    return (
        '<section class="gwf-greeting-manager">' +
        '<div class="gwf-greeting-manager-heading"><strong>备用开场白</strong><span>共 ' + greetings.length + ' 条，可逐条修改</span></div>' +
        '<div class="gwf-greeting-list">' + (items || '<p class="gwf-greeting-empty">暂时没有备用开场白，可以新增一条或使用左侧批量生成。</p>') + '</div>' +
        '<button type="button" class="menu_button gwf-greeting-add" data-add-greeting>新增一条开场白</button>' +
        '</section>'
    );
}

function selectField(label, path, value, options) {
    return `<label class="gwf-editor-field"><span>${escapeHtml(label)}</span><select data-field="${path}">${options.map(option => `<option value="${option}" ${option === value ? 'selected' : ''}>${option}</option>`).join('')}</select></label>`;
}

function renderEditor() {
    const editor = state.overlay.querySelector('#gwf-event-editor');
    const event = state.events.find(item => item.id === state.selectedId) || state.events[0];
    if (!event) {
        editor.innerHTML = '';
        return;
    }
    state.selectedId = event.id;
    let html = `<div class="gwf-editor-heading"><div><span>${escapeHtml(event.type)}</span><h3>${escapeHtml(eventLabel(event))}</h3></div><code>${escapeHtml(event.id)}</code></div>`;
    if (event.type === 'project') {
        html += field('项目名', 'name', event.name)
            + field('统一方向', 'summary', event.summary, { area: true, rows: 6 })
            + field('标签，用逗号分隔', 'tags', (event.tags || []).join(', '), { kind: 'array' });
    } else if (event.type === 'character') {
        html += field('角色类型', 'role', event.role, { readonly: true })
            + field('姓名', 'name', event.name)
            + field('别名，用逗号分隔', 'aliases', (event.aliases || []).join(', '), { kind: 'array' })
            + field('角色描述', 'description', event.description, { area: true, rows: 12 })
            + field('性格与行为逻辑', 'personality', event.personality, { area: true, rows: 8 })
            + field('场景', 'scenario', event.scenario, { area: true, rows: 7 })
            + field('开场白', 'firstMessage', event.firstMessage, { area: true, rows: 9 })
            + greetingManager(event)
            + field('示例对话', 'exampleDialogue', event.exampleDialogue, { area: true, rows: 8 })
            + field('系统提示', 'systemPrompt', event.systemPrompt, { area: true, rows: 5 })
            + field('历史后指令', 'postHistoryInstructions', event.postHistoryInstructions, { area: true, rows: 5 })
            + field('作者备注', 'creatorNotes', event.creatorNotes, { area: true, rows: 5 })
            + field('标签，用逗号分隔', 'tags', (event.tags || []).join(', '), { kind: 'array' });
    } else if (event.type === 'done') {
        html += `<pre class="gwf-json-preview">${escapeHtml(JSON.stringify(event, null, 2))}</pre>`;
    } else {
        html += field('标题', 'title', event.title)
            + selectField('类别', 'category', event.category, [event.category, ...LORE_CATEGORIES].filter((value, index, array) => array.indexOf(value) === index))
            + field('正文', 'content', event.content, { area: true, rows: 14 })
            + field('主关键词，用逗号分隔', 'keys', (event.keys || []).join(', '), { kind: 'array' })
            + field('次关键词，用逗号分隔', 'secondaryKeys', (event.secondaryKeys || []).join(', '), { kind: 'array' })
            + field('别名，用逗号分隔', 'aliases', (event.aliases || []).join(', '), { kind: 'array' })
            + selectField('重要程度', 'importance', event.importance, ['critical', 'high', 'medium', 'low'])
            + selectField('激活方式', 'activation.mode', event.activation?.mode, ['constant', 'keyword', 'selective', 'probability', 'state'])
            + field('概率', 'activation.probability', event.activation?.probability ?? 100, { kind: 'number' })
            + field('互斥池 ID', 'activation.pool', event.activation?.pool ?? '')
            + field('同池相对权重', 'activation.weight', event.activation?.weight ?? 100, { kind: 'number' })
            + field('持续消息数', 'persistence.sticky', event.persistence?.sticky ?? 0, { kind: 'number' })
            + field('冷却消息数', 'persistence.cooldown', event.persistence?.cooldown ?? 0, { kind: 'number' })
            + field('聊天长度门槛', 'persistence.delay', event.persistence?.delay ?? 0, { kind: 'number' })
            + field('依赖条目，用逗号分隔', 'dependencies', (event.dependencies || []).join(', '), { kind: 'array' });
    }
    const eventIssues = [...state.styleIssues, ...state.lengthIssues].filter(issue => issue.id === event.id);
    if (eventIssues.length) html += `<div class="gwf-editor-issues">${eventIssues.map(issue => `<p>${escapeHtml(issue.path)}：${escapeHtml(issue.reason)}</p>`).join('')}</div>`;
    editor.innerHTML = html;
    editor.querySelectorAll('[data-field]').forEach(control => control.addEventListener('input', () => {
        updateEventField(event, control.dataset.field, control.value, control.dataset.kind || 'string');
        state.complete = validateBlueprint(state.events).valid;
        persistDraft();
        refreshResults({ preserveEditor: true });
    }));
    editor.querySelectorAll('[data-greeting-index]').forEach(control => control.addEventListener('input', () => {
        const index = Number(control.dataset.greetingIndex);
        event.alternateGreetings ??= [];
        event.alternateGreetings[index] = control.value;
        persistDraft();
        refreshResults({ preserveEditor: true });
    }));
    editor.querySelectorAll('[data-remove-greeting]').forEach(button => button.addEventListener('click', () => {
        const index = Number(button.dataset.removeGreeting);
        event.alternateGreetings?.splice(index, 1);
        persistDraft();
        refreshResults();
    }));
    editor.querySelector('[data-add-greeting]')?.addEventListener('click', () => {
        event.alternateGreetings ??= [];
        event.alternateGreetings.push('');
        persistDraft();
        refreshResults();
    });
}

function updateEventField(event, path, rawValue, kind) {
    let value = rawValue;
    if (kind === 'number') value = Number(rawValue) || 0;
    if (kind === 'array') value = rawValue.split(/[,，]/u).map(item => item.trim()).filter(Boolean);
    if (kind === 'lines') value = rawValue.split(/\r?\n/u).map(item => item.trim()).filter(Boolean);
    const parts = path.split('.');
    let cursor = event;
    for (const part of parts.slice(0, -1)) {
        cursor[part] ??= {};
        cursor = cursor[part];
    }
    cursor[parts.at(-1)] = value;
}

function updateCompiledPreview() {
    const cardPreview = state.overlay.querySelector('#gwf-card-preview');
    const bookPreview = state.overlay.querySelector('#gwf-book-preview');
    if (!cardPreview || !bookPreview) return;
    try {
        const blueprint = aggregateBlueprint(state.events);
        const compileOptions = collectOptionsWithoutSaving();
        const book = compileWorldBook(blueprint, '', compileOptions);
        const card = compileCharacterCard(blueprint, null, compileOptions);
        cardPreview.textContent = JSON.stringify(card, null, 2).slice(0, 18000);
        bookPreview.textContent = JSON.stringify(book, null, 2).slice(0, 18000);
    } catch (error) {
        cardPreview.textContent = String(error?.message || error);
        bookPreview.textContent = String(error?.message || error);
    }
}

async function runTriggerSimulator() {
    const text = state.overlay.querySelector('#gwf-simulator-input')?.value || '';
    const outlet = state.overlay.querySelector('#gwf-simulator-result');
    if (!text.trim()) {
        outlet.textContent = '请先输入一段聊天文本。';
        return;
    }
    try {
        const compileOptions = collectOptionsWithoutSaving();
        const simulation = simulateLoreActivation(state.events, text, compileOptions);
        let tokenText = `约 ${simulation.totalChars} 个字符`;
        try {
            const compiled = compileWorldBook(state.events, '', compileOptions);
            const contents = simulation.results.map(result => compiled.entries[result.uid]?.content || '').join('\n');
            const tokens = await getContext().getTokenCountAsync?.(contents);
            if (Number.isFinite(tokens)) tokenText = `约 ${tokens} tokens`;
        } catch { /* character estimate remains available */ }
        outlet.innerHTML = simulation.results.length
            ? `<strong>触发 ${simulation.results.length} 条，${escapeHtml(tokenText)}</strong>${simulation.results.map(result => `<span><b>${escapeHtml(result.phase)}</b>${escapeHtml(result.title)}${result.probability < 100 ? `，候选概率 ${result.probability}%` : ''}</span>`).join('')}`
            : '<strong>没有条目被触发</strong><span>可以检查关键词是否过窄，或确认条目是否为常驻。</span>';
    } catch (error) {
        outlet.textContent = String(error?.message || error);
    }
}

function updateActionState(ready) {
    for (const id of ['#gwf-export-world', '#gwf-export-card', '#gwf-save-world', '#gwf-bind-world', '#gwf-create-character']) {
        const button = state.overlay.querySelector(id);
        if (button) button.disabled = !ready;
    }
    const generateGreetingsButton = state.overlay.querySelector('#gwf-generate-greetings');
    if (generateGreetingsButton) generateGreetingsButton.disabled = !ready || state.greetingGenerating;
    const persona = aggregateBlueprint(state.events).userPersona;
    const copy = state.overlay.querySelector('#gwf-copy-persona');
    if (copy) {
        copy.hidden = !persona;
        copy.disabled = !persona;
    }
}

function switchTab(tab) {
    state.activeTab = tab;
    state.overlay.querySelectorAll('.gwf-tab').forEach(button => button.classList.toggle('is-active', button.dataset.tab === tab));
    refreshResults();
}

function safeFileName(value) {
    return String(value || 'gaga-world-project').replace(/[\\/:*?"<>|]+/gu, '_').trim().slice(0, 80) || 'gaga-world-project';
}

function downloadText(name, content, type = 'application/json') {
    const blob = new Blob([content], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function currentProjectName() {
    return aggregateBlueprint(state.events).project?.name || '未命名项目';
}

function exportBlueprint() {
    downloadText(`${safeFileName(currentProjectName())}.blueprint.json`, serializeBlueprint(state.events));
}

function exportJsonl() {
    downloadText(`${safeFileName(currentProjectName())}.jsonl`, serializeJsonl(state.events), 'application/x-ndjson');
}

function exportWorldBook() {
    const name = `${currentProjectName()} 世界书`;
    downloadText(`${safeFileName(name)}.json`, JSON.stringify(compileWorldBook(state.events, name, collectOptionsWithoutSaving()), null, 2));
}

function selectedCharacterForAction() {
    const selected = state.events.find(event => event.id === state.selectedId && event.type === 'character' && event.role !== 'user');
    return selected || aggregateBlueprint(state.events).mainCharacter;
}

function exportCharacterCard() {
    const character = selectedCharacterForAction();
    const card = compileCharacterCard(state.events, character, {
        ...collectOptionsWithoutSaving(),
        worldBookName: state.savedWorldName || `${currentProjectName()} 世界书`,
        embedBook: true,
    });
    downloadText(`${safeFileName(character.name)}.json`, JSON.stringify(card, null, 2));
}

async function copyPersona() {
    const text = compilePersonaText(state.events);
    if (!text) return;
    await navigator.clipboard.writeText(text);
    notify('success', 'User 人设已复制。');
}

function uniqueWorldName(baseName, names) {
    if (!names.includes(baseName)) return baseName;
    for (let index = 2; index < 10000; index += 1) {
        const candidate = `${baseName} (${index})`;
        if (!names.includes(candidate)) return candidate;
    }
    return `${baseName} ${Date.now()}`;
}

async function saveWorldBookToST() {
    const ctx = getContext();
    const baseName = `${currentProjectName()} 世界书`;
    const updating = Boolean(state.savedWorldName);
    const name = state.savedWorldName || uniqueWorldName(baseName, ctx.getWorldInfoNames?.() || []);
    const book = compileWorldBook(state.events, name, collectOptionsWithoutSaving());
    await ctx.saveWorldInfo(name, book, true);
    await ctx.updateWorldInfoList?.();
    state.savedWorldName = name;
    notify('success', `世界书“${name}”已${updating ? '更新' : '写入'}酒馆。`);
    setStatus(`世界书已${updating ? '更新' : '写入'}：${name}`, 'success');
    return name;
}

async function bindWorldToCurrentCharacter() {
    const ctx = getContext();
    const characterId = Number(ctx.characterId);
    const character = Number.isInteger(characterId) && characterId >= 0 ? ctx.characters?.[characterId] : null;
    if (!character?.avatar) throw new Error('请先在酒馆中选择需要绑定的角色');
    const worldName = await saveWorldBookToST();
    const response = await fetch('/api/characters/merge-attributes', {
        method: 'POST',
        headers: ctx.getRequestHeaders(),
        body: JSON.stringify({ avatar: character.avatar, data: { extensions: { world: worldName } } }),
    });
    if (!response.ok) throw new Error(`绑定失败：${response.status}`);
    await ctx.getOneCharacter?.(character.avatar);
    notify('success', `已把“${worldName}”设为当前角色的主世界书。`);
}

async function createCharacterInST() {
    const ctx = getContext();
    const character = selectedCharacterForAction();
    if (!character) throw new Error('没有可创建的角色事件');
    const worldName = await saveWorldBookToST();
    const card = compileCharacterCard(state.events, character, {
        ...collectOptionsWithoutSaving(),
        worldBookName: worldName,
        embedBook: true,
    });
    const file = new File([JSON.stringify(card)], `${safeFileName(character.name)}.json`, { type: 'application/json' });
    const formData = new FormData();
    formData.append('avatar', file);
    formData.append('file_type', 'json');
    formData.append('user_name', String(ctx.name1 || 'User'));
    const response = await fetch('/api/characters/import', {
        method: 'POST',
        headers: ctx.getRequestHeaders({ omitContentType: true }),
        body: formData,
        cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`角色创建失败：${response.statusText}`);
    const result = await response.json();
    if (result.error) throw new Error(String(result.error));
    await ctx.getCharacters?.();
    notify('success', `角色“${character.name}”已创建，并绑定主世界书“${worldName}”。`);
}

async function runAction(action) {
    try {
        await action();
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] 操作失败`, error);
        notify('error', String(error?.message || error));
    }
}

function bindUi() {
    const root = state.overlay;
    bindShellDrag(root);
    root.querySelector('#gwf-close').addEventListener('click', closeStudio);
    root.addEventListener('click', event => {
        if (event.target === root) closeStudio();
        else scheduleStudioVisibilityCheck();
    });
    root.addEventListener('change', scheduleStudioVisibilityCheck, true);
    window.addEventListener('resize', scheduleStudioVisibilityCheck, { passive: true });
    root.querySelector('#gwf-generate').addEventListener('click', generateProject);
    root.querySelector('#gwf-stop').addEventListener('click', stopGeneration);
    root.querySelector('#gwf-generate-greetings').addEventListener('click', generateGreetings);
    root.querySelector('#gwf-stop-greetings').addEventListener('click', stopGreetingGeneration);
    root.querySelector('#gwf-add-greeting-slot').addEventListener('click', addGreetingSlot);
    root.querySelector('#gwf-activation-strategy').addEventListener('change', event => {
        updateActivationStrategyUi();
        settings().options.activationStrategy = event.target.value;
        persistSettings();
        applyProjectCompileSettings(state.events, { activationStrategy: event.target.value });
        persistDraft();
        refreshResults({ preserveEditor: true });
    });
    const greetingSlots = root.querySelector('#gwf-greeting-slots');
    greetingSlots.addEventListener('click', event => {
        const button = event.target.closest('[data-remove-greeting-slot]');
        if (!button) return;
        const cards = [...greetingSlots.querySelectorAll('[data-greeting-slot]')];
        if (cards.length <= 1) {
            notify('warning', '至少保留一张开场白任务卡。');
            return;
        }
        button.closest('[data-greeting-slot]')?.remove();
        persistGreetingSlots();
        renderGreetingSlots(settings().options.greetingSlots);
    });
    greetingSlots.addEventListener('change', event => {
        const control = event.target.closest('[data-greeting-slot-field]');
        if (!control) return;
        const card = control.closest('[data-greeting-slot]');
        if (control.dataset.greetingSlotField === 'asDefault' && control.checked) {
            greetingSlots.querySelectorAll('[data-greeting-slot-field="asDefault"]').forEach(item => {
                if (item !== control) item.checked = false;
            });
        }
        if (control.dataset.greetingSlotField === 'literaryStyle') {
            const preview = card?.querySelector('.gwf-style-preview-text');
            if (preview) preview.textContent = literaryStylePrompt(control.value);
        }
        persistGreetingSlots();
    });
    greetingSlots.addEventListener('input', event => {
        if (event.target.matches('textarea[data-greeting-slot-field]')) persistGreetingSlots();
    });
    root.querySelector('#gwf-length-preset').addEventListener('change', updateLengthUi);
    root.querySelectorAll('#gwf-theme, #gwf-theme-header').forEach(control => control.addEventListener('change', event => {
        const theme = normalizeOptions({ theme: event.target.value }).theme;
        applyTheme(theme);
        settings().options.theme = theme;
        persistSettings();
    }));
    root.querySelectorAll('[data-section-length]').forEach(select => select.addEventListener('change', updateSectionLengthUi));
    root.querySelectorAll('[data-module], #gwf-npc-count, #gwf-relation-count, #gwf-custom-character, #gwf-custom-entry-count, #gwf-custom-entry-min, #gwf-custom-entry-max')
        .forEach(control => control.addEventListener('change', updateLengthUi));
    root.querySelectorAll('.gwf-tab').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
    root.querySelector('#gwf-export-blueprint').addEventListener('click', exportBlueprint);
    root.querySelector('#gwf-export-jsonl').addEventListener('click', exportJsonl);
    root.querySelector('#gwf-export-world').addEventListener('click', exportWorldBook);
    root.querySelector('#gwf-export-card').addEventListener('click', exportCharacterCard);
    root.querySelector('#gwf-copy-persona').addEventListener('click', () => runAction(copyPersona));
    root.querySelector('#gwf-save-world').addEventListener('click', () => runAction(saveWorldBookToST));
    root.querySelector('#gwf-bind-world').addEventListener('click', () => runAction(bindWorldToCurrentCharacter));
    root.querySelector('#gwf-create-character').addEventListener('click', () => runAction(createCharacterInST));
    root.querySelector('#gwf-run-simulator').addEventListener('click', runTriggerSimulator);
    root.querySelector('#gwf-simulator-input').addEventListener('keydown', event => {
        if (event.key === 'Enter') runTriggerSimulator();
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && root.classList.contains('is-open')) closeStudio();
    });
}

export async function init() {
    try {
        settings();
        createEntryPoints();
        console.info(`[${DISPLAY_NAME}] v${VERSION} loaded as ${EXTENSION_NAME}.`);
    } catch (error) {
        console.error(`[${DISPLAY_NAME}] 初始化失败`, error);
    }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
