import { EVENT_ORDER, LORE_CATEGORIES, LORE_EVENT_TYPES } from './studio-data.js';

const EVENT_INDEX = new Map(EVENT_ORDER.map((type, index) => [type, index]));
const CATEGORY_SET = new Set(LORE_CATEGORIES);
const IMPORTANCE = new Set(['critical', 'high', 'medium', 'low']);
const ACTIVATION_MODES = new Set(['constant', 'keyword', 'selective', 'probability', 'state']);
const SELECTIVE_LOGIC = new Set(['AND_ANY', 'AND_ALL', 'NOT_ANY', 'NOT_ALL']);
const CHARACTER_ROLES = new Set(['main', 'playable', 'user']);
const DASH_RE = /[—–―⸺]/u;
const CONTRAST_PATTERNS = [
    /不是[^。！？\n]{0,80}而是/u,
    /并不是[^。！？\n]{0,80}而是/u,
    /并非[^。！？\n]{0,80}而是/u,
    /没有[^。！？\n]{0,80}而是/u,
    /不只是[^。！？\n]{0,80}更是/u,
    /不单是[^。！？\n]{0,80}还是/u,
    /与其说[^。！？\n]{0,80}不如说/u,
    /看似[^。！？\n]{0,80}实则/u,
    /表面上[^。！？\n]{0,80}实际上/u,
];

function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function hasString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function validateStringArray(value, label, errors, { allowEmpty = true } = {}) {
    if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        errors.push(`${label} 必须是字符串数组`);
        return;
    }
    if (!allowEmpty && value.length === 0) errors.push(`${label} 不能为空`);
}

function validateLoreEvent(event, errors) {
    if (!CATEGORY_SET.has(event.category)) errors.push(`${event.id}.category 不在允许列表中`);
    if (!hasString(event.title)) errors.push(`${event.id}.title 不能为空`);
    if (!hasString(event.content)) errors.push(`${event.id}.content 不能为空`);
    validateStringArray(event.aliases, `${event.id}.aliases`, errors);
    validateStringArray(event.keys, `${event.id}.keys`, errors, { allowEmpty: event.activation?.mode === 'constant' });
    validateStringArray(event.secondaryKeys, `${event.id}.secondaryKeys`, errors);
    validateStringArray(event.dependencies, `${event.id}.dependencies`, errors);
    if (!IMPORTANCE.has(event.importance)) errors.push(`${event.id}.importance 无效`);
    if (!isObject(event.activation) || !ACTIVATION_MODES.has(event.activation.mode)) {
        errors.push(`${event.id}.activation.mode 无效`);
    }
    if (event.activation?.selectiveLogic && !SELECTIVE_LOGIC.has(event.activation.selectiveLogic)) {
        errors.push(`${event.id}.activation.selectiveLogic 无效`);
    }
    const probability = Number(event.activation?.probability ?? 100);
    if (!Number.isFinite(probability) || probability < 0 || probability > 100) {
        errors.push(`${event.id}.activation.probability 必须在 0 至 100 之间`);
    }
    if (event.activation?.pool !== undefined && typeof event.activation.pool !== 'string') {
        errors.push(`${event.id}.activation.pool 必须是字符串`);
    }
    if (typeof event.activation?.pool === 'string' && event.activation.pool && !/^[a-z0-9._-]+$/u.test(event.activation.pool)) {
        errors.push(`${event.id}.activation.pool 含有不稳定字符`);
    }
    const weight = Number(event.activation?.weight ?? 100);
    if (!Number.isFinite(weight) || weight < 1 || weight > 10000) {
        errors.push(`${event.id}.activation.weight 必须在 1 至 10000 之间`);
    }
    if (!isObject(event.persistence)) errors.push(`${event.id}.persistence 必须是对象`);
    for (const key of ['sticky', 'cooldown', 'delay']) {
        const number = Number(event.persistence?.[key] ?? 0);
        if (!Number.isFinite(number) || number < 0) errors.push(`${event.id}.persistence.${key} 必须是非负数`);
    }
    if (event.type === 'npc') {
        if (!hasString(event.entityId)) errors.push(`${event.id}.entityId 不能为空`);
        if (!['passerby', 'minor', 'important'].includes(event.tier)) errors.push(`${event.id}.tier 无效`);
        if (!['base', 'logic', 'secret', 'reaction'].includes(event.aspect)) errors.push(`${event.id}.aspect 无效`);
    }
    if (event.type === 'relation') validateStringArray(event.participants, `${event.id}.participants`, errors, { allowEmpty: false });
}

export function validateEventShape(event) {
    const errors = [];
    if (!isObject(event)) return ['事件必须是 JSON 对象'];
    if (!EVENT_INDEX.has(event.type)) errors.push(`未知事件类型 ${String(event.type)}`);
    if (!hasString(event.id)) errors.push('事件 id 不能为空');
    if (hasString(event.id) && !/^[a-z0-9._-]+$/.test(event.id)) errors.push(`${event.id} 含有不稳定字符`);

    if (event.type === 'project') {
        if (!hasString(event.name)) errors.push('project.name 不能为空');
        if (!hasString(event.summary)) errors.push('project.summary 不能为空');
        validateStringArray(event.tags, 'project.tags', errors);
    } else if (event.type === 'character') {
        if (!CHARACTER_ROLES.has(event.role)) errors.push(`${event.id}.role 无效`);
        if (!hasString(event.name)) errors.push(`${event.id}.name 不能为空`);
        if (!hasString(event.description)) errors.push(`${event.id}.description 不能为空`);
        validateStringArray(event.aliases, `${event.id}.aliases`, errors);
        validateStringArray(event.alternateGreetings, `${event.id}.alternateGreetings`, errors);
        validateStringArray(event.tags, `${event.id}.tags`, errors);
    } else if (LORE_EVENT_TYPES.has(event.type)) {
        validateLoreEvent(event, errors);
    } else if (event.type === 'done') {
        if (event.id !== 'done') errors.push('done 事件 id 必须为 done');
        if (!isObject(event.counts)) errors.push('done.counts 必须是对象');
    }
    return errors;
}

function cleanLine(line) {
    const trimmed = line.trim().replace(/^\uFEFF/, '');
    if (/^```(?:jsonl?|JSONL?)?$/u.test(trimmed) || trimmed === '```') return '';
    return trimmed;
}

function extractJsonObjects(raw) {
    const source = String(raw ?? '').replace(/^\uFEFF/u, '');
    const events = [];
    const errors = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let startLine = 1;
    let lineNumber = 1;

    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (char === '\n') lineNumber += 1;
        if (start < 0) {
            if (char === '{') {
                start = index;
                startLine = lineNumber;
                depth = 1;
                inString = false;
                escaped = false;
            }
            continue;
        }
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
        if (depth !== 0) continue;

        const text = source.slice(start, index + 1);
        try {
            const event = JSON.parse(text);
            if (!isObject(event)) throw new Error('事件必须是 JSON 对象');
            events.push(event);
        } catch (error) {
            errors.push({ lineNumber: startLine, line: text, message: String(error?.message || error) });
        }
        start = -1;
        depth = 0;
        inString = false;
        escaped = false;
    }

    if (start >= 0) {
        errors.push({
            lineNumber: startLine,
            line: source.slice(start),
            message: '最后一个 JSON 对象未完整结束，可能触及模型输出上限',
        });
    }
    return { events, errors };
}

export class JsonlStreamParser {
    constructor({ onEvent, onError } = {}) {
        this.onEvent = onEvent;
        this.onError = onError;
        this.raw = '';
        this.buffer = '';
        this.lineNumber = 0;
        this.events = [];
        this.errors = [];
    }

    pushCumulative(nextRaw) {
        const value = String(nextRaw ?? '');
        if (value === this.raw || this.raw.startsWith(value)) return;
        const delta = value.startsWith(this.raw) ? value.slice(this.raw.length) : value;
        this.raw = value.startsWith(this.raw) ? value : this.raw + value;
        this.buffer += delta;
        this.#drain(false);
    }

    finish(finalRaw = null) {
        if (finalRaw !== null) this.pushCumulative(finalRaw);
        this.#drain(true);
        if (this.errors.length) {
            const recovered = extractJsonObjects(this.raw);
            if (recovered.events.length) {
                this.events = recovered.events;
                this.errors = recovered.errors;
            }
        }
        return { events: [...this.events], errors: [...this.errors], raw: this.raw };
    }

    #drain(flush) {
        const lines = this.buffer.split(/\r?\n/u);
        this.buffer = flush ? '' : lines.pop() ?? '';
        if (flush && lines.length === 1 && !lines[0] && this.buffer) lines[0] = this.buffer;
        for (const sourceLine of lines) {
            this.lineNumber += 1;
            const line = cleanLine(sourceLine);
            if (!line) continue;
            try {
                const event = JSON.parse(line);
                if (!isObject(event)) throw new Error('事件必须是 JSON 对象');
                this.events.push(event);
                this.onEvent?.(event, this.lineNumber);
            } catch (error) {
                const detail = { lineNumber: this.lineNumber, line, message: String(error?.message || error) };
                this.errors.push(detail);
                this.onError?.(detail);
            }
        }
        if (flush && this.buffer.trim()) {
            const line = cleanLine(this.buffer);
            this.buffer = '';
            if (line) {
                this.lineNumber += 1;
                try {
                    const event = JSON.parse(line);
                    if (!isObject(event)) throw new Error('事件必须是 JSON 对象');
                    this.events.push(event);
                    this.onEvent?.(event, this.lineNumber);
                } catch (error) {
                    const detail = { lineNumber: this.lineNumber, line, message: String(error?.message || error) };
                    this.errors.push(detail);
                    this.onError?.(detail);
                }
            }
        }
    }
}

function walkStrings(value, path, visit) {
    if (typeof value === 'string') {
        visit(value, path);
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => walkStrings(item, `${path}.${index}`, visit));
        return;
    }
    if (isObject(value)) {
        for (const [key, item] of Object.entries(value)) walkStrings(item, path ? `${path}.${key}` : key, visit);
    }
}

function isNaturalLanguagePath(path) {
    return !/(^|\.)(id|type|role|category|importance|mode|selectiveLogic|entityId|dependencies|counts)(\.|$)/u.test(path);
}

export function findStyleIssues(events) {
    const issues = [];
    for (const event of events) {
        walkStrings(event, '', (text, path) => {
            if (!isNaturalLanguagePath(path)) return;
            if (DASH_RE.test(text)) issues.push({ id: event.id, path, reason: '含有禁用的破折号字符' });
            for (const pattern of CONTRAST_PATTERNS) {
                if (pattern.test(text)) {
                    issues.push({ id: event.id, path, reason: '含有先否定后肯定的对照句式' });
                    break;
                }
            }
        });
    }
    return issues;
}

export function findLengthIssues(events, plan) {
    if (!plan) return [];
    const issues = [];
    const characterFields = ['description', 'personality', 'scenario', 'firstMessage', 'exampleDialogue', 'systemPrompt', 'postHistoryInstructions', 'creatorNotes'];
    for (const event of events.filter(item => item.type === 'character' && item.role !== 'user')) {
        const total = characterFields.reduce((sum, key) => sum + String(event[key] || '').length, 0);
        const min = plan.character[0];
        const max = plan.character[1];
        if (total < Math.round(min * 0.78)) {
            const expansionTargets = {
                description: Math.round(min * 0.42),
                personality: Math.round(min * 0.19),
                scenario: Math.round(min * 0.12),
                exampleDialogue: Math.round(min * 0.12),
            };
            for (const [key, target] of Object.entries(expansionTargets)) {
                const length = String(event[key] || '').length;
                if (length >= Math.round(target * 0.8)) continue;
                const focus = key === 'description'
                    ? '补足生存逻辑、生活切面、社会面具、内在矛盾、情感表达、关系方式、习惯与边界'
                    : key === 'personality'
                        ? '补足日常决策、压力反应、语言变化与行为边界'
                        : key === 'scenario'
                            ? '补足日程、持续压力、关系入口与可循环事件'
                            : '补足日常、受质疑和冲突情境中的语言指纹与动作反应';
                issues.push({
                    id: event.id,
                    path: key,
                    reason: `角色卡正文合计约 ${total} 字，明显低于 ${min} 字目标。请将本字段扩写至约 ${target} 字，${focus}`,
                });
            }
        }
        if (total > Math.max(max + 300, Math.round(max * 1.3))) {
            const ratio = max / total;
            for (const key of characterFields) {
                const length = String(event[key] || '').length;
                if (length < 120) continue;
                issues.push({
                    id: event.id,
                    path: key,
                    reason: `角色卡正文合计约 ${total} 字。请将本字段压缩至约 ${Math.max(80, Math.round(length * ratio))} 字，并保留关键行为与事实`,
                });
            }
        }
    }
    for (const event of events) {
        if (!LORE_EVENT_TYPES.has(event.type) || typeof event.content !== 'string') continue;
        const max = ['critical', 'high'].includes(event.importance) ? plan.importantEntryMaxChars : plan.entryChars[1];
        if (event.content.length > Math.max(max + 60, Math.round(max * 1.35))) {
            issues.push({
                id: event.id,
                path: 'content',
                reason: `正文约 ${event.content.length} 字，需压缩至 ${max} 字以内并保留全部关键事实`,
            });
        }
    }
    return issues;
}

function countTypes(events) {
    return events.reduce((counts, event) => {
        counts[event.type] = (counts[event.type] || 0) + 1;
        return counts;
    }, {});
}

export function validateBlueprint(events, { requireDone = true } = {}) {
    const errors = [];
    const warnings = [];
    const ids = new Set();
    let lastOrder = -1;
    let doneIndex = -1;
    let mainCharacters = 0;

    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        const order = EVENT_INDEX.get(event.type);
        if (order < lastOrder) errors.push(`${event.id} 的事件顺序错误`);
        lastOrder = Math.max(lastOrder, order);
        if (ids.has(event.id)) errors.push(`事件 id 重复：${event.id}`);
        ids.add(event.id);
        if (event.type === 'done') doneIndex = index;
        if (event.type === 'character' && event.role === 'main') mainCharacters += 1;
        errors.push(...validateEventShape(event));
    }

    if (!events.some(event => event.type === 'project')) errors.push('缺少 project 事件');
    if (mainCharacters === 0) errors.push('缺少主角色卡');
    if (mainCharacters > 1) warnings.push('包含多个 main 角色，创建角色时默认使用第一个');
    if (requireDone && doneIndex < 0) errors.push('缺少 done 事件');
    if (doneIndex >= 0 && doneIndex !== events.length - 1) errors.push('done 必须是最后一个事件');

    const done = events[doneIndex];
    if (done?.counts) {
        const actual = countTypes(events.filter(event => event.type !== 'done'));
        for (const type of EVENT_ORDER.filter(type => type !== 'done')) {
            if (done.counts[type] !== undefined && Number(done.counts[type]) !== Number(actual[type] || 0)) {
                warnings.push(`done.counts.${type} 与实际数量不一致`);
            }
        }
    }

    for (const event of events.filter(item => LORE_EVENT_TYPES.has(item.type))) {
        for (const dependency of asArray(event.dependencies)) {
            if (!ids.has(dependency)) warnings.push(`${event.id} 依赖不存在的条目 ${dependency}`);
        }
    }
    return { valid: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function aggregateBlueprint(events) {
    return {
        events,
        project: events.find(event => event.type === 'project') || null,
        characters: events.filter(event => event.type === 'character'),
        mainCharacter: events.find(event => event.type === 'character' && event.role === 'main') || null,
        playableCharacters: events.filter(event => event.type === 'character' && event.role === 'playable'),
        userPersona: events.find(event => event.type === 'character' && event.role === 'user') || null,
        loreEvents: events.filter(event => LORE_EVENT_TYPES.has(event.type)),
        done: events.find(event => event.type === 'done') || null,
    };
}

function setByPath(target, path, value) {
    const parts = String(path).split('.').filter(Boolean);
    let cursor = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index];
        const nextPart = parts[index + 1];
        if (cursor[part] === undefined) cursor[part] = /^\d+$/u.test(nextPart) ? [] : {};
        cursor = cursor[part];
    }
    if (parts.length) cursor[parts.at(-1)] = value;
}

export function parsePatchJsonl(raw) {
    const patches = [];
    for (const line of String(raw || '').split(/\r?\n/u)) {
        const cleaned = cleanLine(line);
        if (!cleaned) continue;
        const patch = JSON.parse(cleaned);
        if (patch.type !== 'patch' || !hasString(patch.id) || !isObject(patch.changes)) {
            throw new Error('修复结果含有无效 patch 事件');
        }
        patches.push(patch);
    }
    return patches;
}

export function applyPatches(events, patches) {
    const cloned = typeof structuredClone === 'function'
        ? structuredClone(events)
        : JSON.parse(JSON.stringify(events));
    const byId = new Map(cloned.map(event => [event.id, event]));
    for (const patch of patches) {
        const target = byId.get(patch.id);
        if (!target) throw new Error(`修复目标不存在：${patch.id}`);
        for (const [path, value] of Object.entries(patch.changes)) setByPath(target, path, value);
    }
    return cloned;
}
