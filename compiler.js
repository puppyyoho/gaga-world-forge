import { aggregateBlueprint, normalizeBlueprintEvents, validateBlueprint } from './jsonl.js';

const IMPORTANCE_ORDER = {
    critical: 9000,
    high: 7000,
    medium: 4000,
    low: 1000,
};

const CATEGORY_ORDER_OFFSET = {
    STATE: 950,
    MOOD: 930,
    EMOTION: 920,
    REL_STAGE: 910,
    TRUST: 900,
    JEALOUSY: 890,
    ATTACHMENT: 880,
    BEHAVIOR: 860,
    REACTION: 850,
    COPING: 840,
    SOCIAL_MASK: 830,
    REL: 810,
    WORLD: 780,
    RULE: 760,
    SYSTEM: 750,
    SOCIETY: 740,
    NPC: 700,
    EVENT: 650,
    HOOK: 630,
    QUEST: 620,
    FACTION: 580,
    REGION: 560,
    LOCATION: 540,
    ITEM: 520,
    CULTURE: 480,
    SPECIES: 460,
    TERMINOLOGY: 440,
    MEMORY: 400,
    MYSTERY: 360,
    FORESHADOW: 340,
    RANDOM: 200,
};

const DYNAMIC_CATEGORIES = new Set(['EMOTION', 'MOOD', 'STATE', 'TRIGGER', 'ATTACHMENT', 'REL_STAGE', 'TRUST', 'JEALOUSY']);
const SECRET_CATEGORIES = new Set(['MYSTERY', 'FORESHADOW']);
const BEHAVIOR_CATEGORIES = new Set(['BEHAVIOR', 'HABIT', 'ROUTINE', 'MANNERISM', 'REACTION', 'COPING', 'CONFLICT', 'CARE', 'SOCIAL_MASK']);
const AFTER_CHARACTER_CATEGORIES = new Set([
    ...BEHAVIOR_CATEGORIES,
    'REL', 'ROMANCE', 'INTIMACY', 'NSFW_PREFERENCE', 'NSFW_BEHAVIOR', 'NSFW_SPEECH', 'NSFW_DYNAMIC', 'NSFW_PHYSIOLOGY', 'NSFW_AFTERCARE', 'NSFW_SCENARIO',
]);
const ACTIVATION_STRATEGIES = new Set(['allBlue', 'coreBlue', 'tokenSaver']);

const LOGIC_MAP = {
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
};

function uniqueStrings(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(value => String(value).trim()).filter(Boolean))];
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function hashId(value) {
    let hash = 2166136261;
    for (const char of String(value)) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash >>> 0) % 900000;
}

function stableUid(id, used) {
    let uid = hashId(id);
    while (used.has(uid)) uid = (uid + 1) % 1000000;
    used.add(uid);
    return uid;
}

function normalizeActivationStrategy(value) {
    return ACTIVATION_STRATEGIES.has(value) ? value : 'coreBlue';
}

function isDynamicEntry(event) {
    return event.activation?.mode === 'state' || DYNAMIC_CATEGORIES.has(event.category);
}

function isCoreBlueEntry(event) {
    const category = String(event.category || '');
    const importance = String(event.importance || 'medium');
    if (event.aspect === 'secret' || SECRET_CATEGORIES.has(category) || isDynamicEntry(event)) return false;
    if (category === 'NPC') return event.aspect === 'base' && ['important', 'minor'].includes(event.tier);
    if (category === 'REL') return importance !== 'low';
    if (['WORLD', 'RULE', 'SYSTEM', 'SOCIETY'].includes(category)) return ['critical', 'high'].includes(importance);
    if (['REGION', 'FACTION', 'EVENT', 'HOOK', 'QUEST', 'ITEM'].includes(category)) return ['critical', 'high'].includes(importance);
    if (BEHAVIOR_CATEGORIES.has(category)) return ['critical', 'high'].includes(importance);
    return importance === 'critical';
}

function isTokenSaverCore(event) {
    const category = String(event.category || '');
    const importance = String(event.importance || 'medium');
    if (event.aspect === 'secret' || SECRET_CATEGORIES.has(category) || isDynamicEntry(event)) return false;
    if (category === 'WORLD') return ['critical', 'high'].includes(importance);
    if (category === 'RULE') return importance === 'critical';
    if (category === 'NPC') return event.aspect === 'base' && event.tier === 'important';
    return ['REL', 'EVENT', 'HOOK'].includes(category) && importance === 'critical';
}

function shouldBeConstant(event, mode, strategy) {
    if (strategy === 'allBlue') return true;
    if (mode === 'probability') return true;
    if (!Array.isArray(event.keys) || event.keys.length === 0) return true;
    if (strategy === 'tokenSaver') return isTokenSaverCore(event);
    return mode === 'constant' || isCoreBlueEntry(event);
}

function semanticOrder(event) {
    const importance = IMPORTANCE_ORDER[event.importance] || IMPORTANCE_ORDER.medium;
    const category = CATEGORY_ORDER_OFFSET[event.category] ?? 300;
    const aspect = event.aspect === 'base' ? 80 : event.aspect === 'logic' ? 60 : event.aspect === 'reaction' ? 40 : 0;
    return importance + category + aspect + (hashId(event.id) % 20);
}

function semanticPosition(event) {
    if (isDynamicEntry(event)) return 4;
    if (AFTER_CHARACTER_CATEGORIES.has(event.category) || (event.category === 'NPC' && ['logic', 'reaction'].includes(event.aspect))) return 1;
    return 0;
}

function semanticScanDepth(event, constant) {
    if (constant) return null;
    if (isDynamicEntry(event)) return 2;
    if (['MEMORY', 'MYSTERY', 'FORESHADOW'].includes(event.category) || event.aspect === 'secret') return 6;
    return 4;
}

function semanticSticky(event, constant, persistence) {
    const configured = clampNumber(persistence.sticky, 0, 1000, 0);
    if (configured > 0) return configured;
    if (constant) return null;
    if (['NPC', 'REL', 'LOCATION', 'EVENT', 'HOOK', 'MYSTERY'].includes(event.category)) return 2;
    return null;
}

function activationSettings(event, randomGroup, dependencyKeys, strategy) {
    const activation = event.activation || {};
    const mode = activation.mode || 'keyword';
    const probability = Math.round(clampNumber(activation.probability, 0, 100, 100));
    const hasSecondaryKeys = Array.isArray(event.secondaryKeys) && event.secondaryKeys.length > 0;
    const constant = shouldBeConstant(event, mode, strategy);
    const pool = String(activation.pool || '').trim();
    const group = pool ? `${randomGroup}.${pool}` : mode === 'probability' || event.category === 'RANDOM' ? randomGroup : '';
    return {
        constant,
        selective: mode === 'selective' || hasSecondaryKeys || dependencyKeys.length > 0,
        selectiveLogic: LOGIC_MAP[activation.selectiveLogic] ?? 0,
        useProbability: mode === 'probability' || probability < 100,
        probability,
        group,
        groupWeight: Math.round(clampNumber(activation.weight, 1, 10000, 100)),
        useGroupScoring: Boolean(group && mode !== 'probability' && event.category !== 'RANDOM'),
    };
}

export function compileWorldBook(eventsOrBlueprint, bookName = '', compileOptions = {}) {
    const sourceEvents = Array.isArray(eventsOrBlueprint) ? eventsOrBlueprint : eventsOrBlueprint?.events || [];
    const blueprint = aggregateBlueprint(normalizeBlueprintEvents(sourceEvents));
    const validation = validateBlueprint(blueprint.events, { requireDone: false });
    if (!validation.valid) throw new Error(`蓝图无法编译：${validation.errors.join('；')}`);

    const entries = {};
    const usedUids = new Set();
    const loreEvents = blueprint.loreEvents || [];
    const loreById = new Map(loreEvents.map(event => [event.id, event]));
    const randomGroup = `${blueprint.project?.id || 'project.main'}.random`;
    const strategy = normalizeActivationStrategy(compileOptions.activationStrategy || blueprint.project?.recommendedSettings?.activationStrategy);
    loreEvents.forEach((event, index) => {
        const uid = stableUid(event.id, usedUids);
        const dependencyKeys = uniqueStrings((event.dependencies || []).flatMap(id => {
            const dependency = loreById.get(id);
            return dependency ? [...(dependency.keys || []), ...(dependency.aliases || [])] : [];
        }));
        const activation = activationSettings(event, randomGroup, dependencyKeys, strategy);
        const persistence = event.persistence || {};
        const position = semanticPosition(event);
        entries[uid] = {
            uid,
            key: uniqueStrings([...(event.keys || []), ...(event.aliases || [])]),
            keysecondary: uniqueStrings([...(event.secondaryKeys || []), ...dependencyKeys]),
            comment: String(event.title || `[${event.category}] ${event.id}`).slice(0, 100),
            content: String(event.content || '').trim(),
            constant: activation.constant,
            vectorized: false,
            selective: activation.selective,
            selectiveLogic: activation.selectiveLogic,
            addMemo: true,
            order: semanticOrder(event),
            position,
            disable: false,
            ignoreBudget: false,
            excludeRecursion: false,
            preventRecursion: Boolean(event.preventRecursion),
            matchPersonaDescription: false,
            matchCharacterDescription: false,
            matchCharacterPersonality: false,
            matchCharacterDepthPrompt: false,
            matchScenario: false,
            matchCreatorNotes: false,
            delayUntilRecursion: 0,
            probability: activation.probability,
            useProbability: activation.useProbability,
            depth: position === 4 ? 2 : 4,
            outletName: '',
            group: activation.group,
            groupOverride: false,
            groupWeight: activation.groupWeight,
            scanDepth: semanticScanDepth(event, activation.constant),
            caseSensitive: false,
            matchWholeWords: false,
            useGroupScoring: activation.useGroupScoring,
            automationId: '',
            role: 0,
            sticky: semanticSticky(event, activation.constant, persistence),
            cooldown: clampNumber(persistence.cooldown, 0, 1000, 0) || null,
            delay: clampNumber(persistence.delay, 0, 1000, 0) || null,
            triggers: [],
            displayIndex: index,
            extensions: {
                gagaWorldForge: {
                    sourceId: event.id,
                    sourceType: event.type,
                    category: event.category,
                    dependencies: uniqueStrings(event.dependencies),
                    entityId: event.entityId || '',
                    aspect: event.aspect || '',
                    activationStrategy: strategy,
                },
            },
        };
    });

    return {
        name: bookName || `${blueprint.project?.name || '未命名项目'} 世界书`,
        entries,
        extensions: {
            gagaWorldForge: {
                version: 2,
                projectId: blueprint.project?.id || 'project.main',
                activationStrategy: strategy,
                recommendedSettings: {
                    ...(blueprint.project?.recommendedSettings || {}),
                    scanDepth: 4,
                    budgetPercent: strategy === 'allBlue' ? 35 : 25,
                    recursiveScanning: strategy !== 'allBlue',
                    activationStrategy: strategy,
                },
            },
        },
    };
}

function toEmbeddedBook(nativeBook) {
    const recommended = nativeBook.extensions?.gagaWorldForge?.recommendedSettings || {};
    return {
        name: nativeBook.name,
        description: '由嘎嘎世界与角色工坊生成',
        scan_depth: recommended.scanDepth ?? 4,
        token_budget: recommended.tokenBudget ?? 2048,
        recursive_scanning: recommended.recursiveScanning !== false,
        extensions: nativeBook.extensions || {},
        entries: Object.values(nativeBook.entries).map(entry => ({
            id: entry.uid,
            keys: entry.key,
            secondary_keys: entry.keysecondary,
            comment: entry.comment,
            content: entry.content,
            constant: entry.constant,
            selective: entry.selective,
            insertion_order: entry.order,
            enabled: !entry.disable,
            position: entry.position === 1 ? 'after_char' : 'before_char',
            use_regex: true,
            extensions: {
                position: entry.position,
                display_index: entry.displayIndex,
                exclude_recursion: entry.excludeRecursion,
                prevent_recursion: entry.preventRecursion,
                delay_until_recursion: entry.delayUntilRecursion,
                probability: entry.probability,
                useProbability: entry.useProbability,
                depth: entry.depth,
                role: entry.role,
                selectiveLogic: entry.selectiveLogic,
                group: entry.group,
                group_override: entry.groupOverride,
                group_weight: entry.groupWeight,
                use_group_scoring: entry.useGroupScoring,
                scan_depth: entry.scanDepth,
                case_sensitive: entry.caseSensitive,
                sticky: entry.sticky,
                cooldown: entry.cooldown,
                delay: entry.delay,
                triggers: entry.triggers,
                ignore_budget: entry.ignoreBudget,
                match_whole_words: entry.matchWholeWords,
                gagaWorldForge: entry.extensions?.gagaWorldForge || {},
            },
        })),
    };
}

function safeCharacter(character) {
    return {
        name: String(character?.name || '未命名角色').trim(),
        description: String(character?.description || '').trim(),
        personality: String(character?.personality || '').trim(),
        scenario: String(character?.scenario || '').trim(),
        firstMessage: String(character?.firstMessage || '').trim(),
        exampleDialogue: String(character?.exampleDialogue || '').trim(),
        systemPrompt: String(character?.systemPrompt || '').trim(),
        postHistoryInstructions: String(character?.postHistoryInstructions || '').trim(),
        creatorNotes: String(character?.creatorNotes || '').trim(),
        alternateGreetings: uniqueStrings(character?.alternateGreetings),
        tags: uniqueStrings(character?.tags),
    };
}

export function compileCharacterCard(eventsOrBlueprint, character = null, options = {}) {
    const blueprint = Array.isArray(eventsOrBlueprint) ? aggregateBlueprint(eventsOrBlueprint) : eventsOrBlueprint;
    const selected = safeCharacter(character || blueprint.mainCharacter);
    if (!selected.name || !selected.description) throw new Error('缺少可编译的主角色卡');

    const worldBookName = options.worldBookName || `${blueprint.project?.name || selected.name} 世界书`;
    const nativeBook = compileWorldBook(blueprint, worldBookName, options);
    const embedBook = options.embedBook !== false;
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: selected.name,
            description: selected.description,
            personality: selected.personality,
            scenario: selected.scenario,
            first_mes: selected.firstMessage,
            mes_example: selected.exampleDialogue,
            creator_notes: selected.creatorNotes,
            system_prompt: selected.systemPrompt,
            post_history_instructions: selected.postHistoryInstructions,
            alternate_greetings: selected.alternateGreetings,
            tags: selected.tags,
            creator: '嘎嘎世界与角色工坊',
            character_version: '1.0',
            extensions: {
                world: worldBookName,
                talkativeness: '0.5',
                fav: false,
                gagaWorldForge: {
                    projectId: blueprint.project?.id || 'project.main',
                    projectName: blueprint.project?.name || '',
                },
            },
            ...(embedBook ? { character_book: toEmbeddedBook(nativeBook) } : {}),
        },
    };
}

export function compilePersonaText(eventsOrBlueprint) {
    const blueprint = Array.isArray(eventsOrBlueprint) ? aggregateBlueprint(eventsOrBlueprint) : eventsOrBlueprint;
    const persona = blueprint.userPersona;
    if (!persona) return '';
    const blocks = [];
    if (persona.name) blocks.push(`【姓名】\n${persona.name}`);
    if (persona.description) blocks.push(`【人物设定】\n${persona.description}`);
    if (persona.personality) blocks.push(`【行为与性格】\n${persona.personality}`);
    if (persona.scenario) blocks.push(`【当前处境】\n${persona.scenario}`);
    return blocks.join('\n\n').trim();
}

export function serializeBlueprint(eventsOrBlueprint) {
    const blueprint = Array.isArray(eventsOrBlueprint) ? aggregateBlueprint(eventsOrBlueprint) : eventsOrBlueprint;
    return JSON.stringify({
        format: 'gaga-world-forge-blueprint',
        version: 1,
        createdAt: new Date().toISOString(),
        events: blueprint.events || [],
    }, null, 2);
}

export function serializeJsonl(eventsOrBlueprint) {
    const events = Array.isArray(eventsOrBlueprint) ? eventsOrBlueprint : eventsOrBlueprint.events || [];
    return events.map(event => JSON.stringify(event)).join('\n');
}

function includesKey(text, key) {
    return String(text).toLocaleLowerCase().includes(String(key).toLocaleLowerCase());
}

function entryMatches(entry, text) {
    if (entry.constant) return true;
    const primary = entry.key || [];
    if (!primary.some(key => includesKey(text, key))) return false;
    if (!entry.selective || !(entry.keysecondary || []).length) return true;
    const matches = entry.keysecondary.map(key => includesKey(text, key));
    if (entry.selectiveLogic === 3) return matches.every(Boolean);
    if (entry.selectiveLogic === 2) return matches.every(value => !value);
    if (entry.selectiveLogic === 1) return !matches.every(Boolean);
    return matches.some(Boolean);
}

export function simulateLoreActivation(eventsOrBlueprint, text, compileOptions = {}) {
    const book = compileWorldBook(eventsOrBlueprint, '', compileOptions);
    const entries = Object.values(book.entries).sort((a, b) => b.order - a.order);
    const direct = entries.filter(entry => entryMatches(entry, text));
    const directIds = new Set(direct.map(entry => entry.uid));
    const recursiveBuffer = direct.filter(entry => !entry.preventRecursion).map(entry => entry.content).join('\n');
    const recursive = recursiveBuffer
        ? entries.filter(entry => !directIds.has(entry.uid) && entryMatches(entry, recursiveBuffer))
        : [];
    const describe = (entry, phase) => ({
        uid: entry.uid,
        title: entry.comment,
        phase,
        probability: entry.useProbability ? entry.probability : 100,
        chars: entry.content.length,
        group: entry.group || '',
    });
    const results = [
        ...direct.map(entry => describe(entry, entry.constant ? 'constant' : 'direct')),
        ...recursive.map(entry => describe(entry, 'recursive')),
    ];
    return {
        results,
        totalChars: results.reduce((sum, result) => sum + result.chars, 0),
    };
}
