import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildGenerationPrompt,
    buildContinuationPrompt,
    buildGreetingPrompt,
    buildGreetingSystemPrompt,
    buildSystemPrompt,
    normalizeOptions,
    resolveLengthPlan,
} from '../studio-data.js';
import {
    JsonlStreamParser,
    aggregateBlueprint,
    applyPatches,
    findStyleIssues,
    mergeContinuationEvents,
    findLengthIssues,
    parsePatchJsonl,
    validateBlueprint,
} from '../jsonl.js';
import { compileCharacterCard, compileWorldBook, simulateLoreActivation } from '../compiler.js';
import { generateWithFallback } from '../streaming.js';

function sampleEvents() {
    return [
        {
            type: 'project',
            id: 'project.main',
            name: '槐青中学',
            summary: '奖学金制度与校董资源共同影响学生生活，旧教学楼改造引出持续矛盾。',
            tags: ['校园', '日常'],
            recommendedSettings: { scanDepth: 2, budgetPercent: 25, recursiveScanning: true },
        },
        {
            type: 'world',
            id: 'world.scholarship',
            category: 'RULE',
            title: '[RULE] 奖学金考核',
            content: '槐青中学每月审核奖学金生的成绩、出勤与纪律记录，任何一次处分都会影响下月生活补助。',
            aliases: ['助学金考核'],
            keys: ['奖学金', '生活补助'],
            secondaryKeys: [],
            activation: { mode: 'keyword', selectiveLogic: 'AND_ANY', probability: 100 },
            importance: 'high',
            persistence: { sticky: 0, cooldown: 0, delay: 0 },
            dependencies: [],
            preventRecursion: false,
            entityId: '',
            aspect: '',
        },
        {
            type: 'character',
            id: 'character.main',
            role: 'main',
            name: '林知遥',
            aliases: ['知遥'],
            description: '林知遥靠奖学金住校，习惯先核对价格再做决定。她把每天的餐费写在练习册最后一页。',
            personality: '遇到质疑时，她先问清具体标准，再逐条回应。',
            scenario: '旧教学楼改造方案进入学生听证阶段。',
            firstMessage: '林知遥把表格推过来，指尖压住空着的预算栏。你这里准备填多少？',
            exampleDialogue: '<START>\n{{user}}: 你很在意这笔钱？\n{{char}}: 先把数算清楚，后面才有选择。',
            systemPrompt: '',
            postHistoryInstructions: '',
            creatorNotes: '校园长期互动角色。',
            alternateGreetings: [],
            tags: ['校园'],
        },
        {
            type: 'npc',
            id: 'npc.chen.base',
            category: 'NPC',
            title: '[NPC] 陈砚舟基础印象',
            content: '陈砚舟负责学生会预算，开会前会把各部门数字抄进同一张表，遇到含糊申请就当场追问用途。',
            aliases: ['陈砚舟', '陈会长'],
            keys: ['陈砚舟', '陈会长'],
            secondaryKeys: [],
            activation: { mode: 'keyword', selectiveLogic: 'AND_ANY', probability: 100 },
            importance: 'medium',
            persistence: { sticky: 0, cooldown: 0, delay: 0 },
            dependencies: [],
            preventRecursion: true,
            entityId: 'npc.chen',
            aspect: 'base',
            tier: 'minor',
        },
        {
            type: 'relation',
            id: 'relation.lin_chen',
            category: 'REL',
            title: '[REL] 林知遥与陈砚舟',
            content: '两人常用预算表交流，林知遥负责核对实际支出，陈砚舟负责争取审批。拖延报账会触发双方争执。',
            aliases: [],
            keys: ['林知遥', '陈砚舟', '报账'],
            secondaryKeys: [],
            activation: { mode: 'selective', selectiveLogic: 'AND_ANY', probability: 100 },
            importance: 'medium',
            persistence: { sticky: 0, cooldown: 0, delay: 0 },
            dependencies: [],
            preventRecursion: true,
            entityId: '',
            aspect: '',
            participants: ['林知遥', '陈砚舟'],
        },
        {
            type: 'lore',
            id: 'lore.hearing',
            category: 'HOOK',
            title: '[HOOK] 学生听证会',
            content: '旧教学楼听证会将在周五举行，材料室缺少三年前的维修报价，任何找到原件的人都能改变讨论方向。',
            aliases: ['周五听证会'],
            keys: ['听证会', '维修报价'],
            secondaryKeys: [],
            activation: { mode: 'keyword', selectiveLogic: 'AND_ANY', probability: 100 },
            importance: 'high',
            persistence: { sticky: 2, cooldown: 3, delay: 0 },
            dependencies: ['world.scholarship'],
            preventRecursion: true,
            entityId: '',
            aspect: '',
        },
        {
            type: 'done',
            id: 'done',
            counts: { project: 1, world: 1, character: 1, npc: 1, relation: 1, lore: 1 },
        },
    ];
}

test('JSONL parser accepts cumulative chunks split inside an object', () => {
    const source = sampleEvents().map(event => JSON.stringify(event)).join('\n');
    const parser = new JsonlStreamParser();
    parser.pushCumulative(source.slice(0, 170));
    parser.pushCumulative(source.slice(0, 700));
    parser.pushCumulative(source);
    const result = parser.finish();
    assert.equal(result.errors.length, 0);
    assert.equal(result.events.length, sampleEvents().length);
    assert.equal(result.events.at(-1).type, 'done');
});

test('JSONL parser locally recovers pretty printed objects and markdown fences', () => {
    const source = [
        '下面是结果：',
        '```json',
        ...sampleEvents().map(event => JSON.stringify(event, null, 2)),
        '```',
        '生成完成。',
    ].join('\n');
    const parser = new JsonlStreamParser();
    parser.pushCumulative(source.slice(0, 500));
    parser.pushCumulative(source.slice(0, 2200));
    parser.pushCumulative(source);
    const result = parser.finish();
    assert.equal(result.errors.length, 0);
    assert.equal(result.events.length, sampleEvents().length);
    assert.equal(result.events.at(-1).type, 'done');
});

test('JSONL parser reports a truncated final object after local recovery', () => {
    const complete = JSON.stringify(sampleEvents()[0]);
    const truncated = JSON.stringify(sampleEvents()[1]).slice(0, -20);
    const parser = new JsonlStreamParser();
    parser.pushCumulative(`${complete}\n${truncated}`);
    const result = parser.finish();
    assert.equal(result.events.length, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].message, /输出上限/);
});

test('buffered generation respects a stop signal before applying returned text', async () => {
    const controller = new AbortController();
    const context = {
        generateRaw: async () => {
            controller.abort(new DOMException('用户停止生成', 'AbortError'));
            return '{"type":"project"}';
        },
    };
    await assert.rejects(
        generateWithFallback(context, {
            systemPrompt: '',
            prompt: 'test',
            preferStream: false,
            signal: controller.signal,
        }),
        error => error?.name === 'AbortError',
    );
});

test('complete blueprint validates and aggregates', () => {
    const events = sampleEvents();
    const result = validateBlueprint(events);
    assert.equal(result.valid, true);
    const blueprint = aggregateBlueprint(events);
    assert.equal(blueprint.mainCharacter.name, '林知遥');
    assert.equal(blueprint.loreEvents.length, 4);
});

test('theme options normalize to a supported palette', () => {
    assert.equal(normalizeOptions({ theme: 'forest' }).theme, 'forest');
    assert.equal(normalizeOptions({ theme: 'blossom' }).theme, 'blossom');
    assert.equal(normalizeOptions({ theme: 'cloud' }).theme, 'cloud');
    assert.equal(normalizeOptions({ theme: 'mint' }).theme, 'mint');
    assert.equal(normalizeOptions({ theme: 'vanilla' }).theme, 'vanilla');
    assert.equal(normalizeOptions({ theme: 'unknown-theme' }).theme, 'twilight');
});

test('greeting prompt includes the requested count, styles, and user settings', () => {
    const options = normalizeOptions({
        brief: '雨夜校园中的秘密会面',
        greetingCount: 3,
        greetingStyles: ['quiet'],
        greetingUserPresets: ['rival'],
        greetingUserSettings: '带着旧照片来访的人',
    });
    const prompt = buildGreetingPrompt({
        project: { name: '槐青中学', summary: '旧教学楼即将拆除' },
        mainCharacter: {
            name: '林知遥',
            description: '靠奖学金住校的学生',
            personality: '遇到质疑时先核对标准',
            scenario: '正在整理听证材料',
            firstMessage: '她把文件推到桌边。',
            exampleDialogue: '你来得很晚。',
        },
        loreEvents: [],
    }, options);
    assert.match(prompt, /3 张/);
    assert.match(prompt, /克制留白/);
    assert.match(prompt, /竞争对手/);
    assert.match(prompt, /带着旧照片来访的人/);
    assert.match(prompt, /生活流写实/);
    assert.match(prompt, /雷蒙德・卡佛/);
    assert.equal((prompt.match(/雷蒙德・卡佛/gu) || []).length, 1);
});

test('project prompt and automatic length plan prioritize the main character', () => {
    const systemPrompt = buildSystemPrompt();
    const generationPrompt = buildGenerationPrompt({
        brief: '创作一名在校园里隐瞒家庭压力的主角色。',
    });
    const plan = resolveLengthPlan({ lengthPreset: 'auto' });
    assert.match(systemPrompt, /主角色是项目的叙事核心/u);
    assert.match(systemPrompt, /description 是完整人物剖析/u);
    assert.match(systemPrompt, /exampleDialogue 至少覆盖日常交流/u);
    assert.match(generationPrompt, /主角色卡达到目标密度后再扩展NPC与世界书条目/u);
    assert.ok(plan.character[0] >= 2000);
    assert.ok(plan.entries[1] <= 35);
});

test('continuation prompt locks completed events and requests only new JSONL', () => {
    const completed = sampleEvents().slice(0, 3);
    const prompt = buildContinuationPrompt({ brief: '继续校园人物项目。' }, {}, completed);
    assert.match(prompt, /已经完成的事件数量/u);
    assert.match(prompt, /character\.main/u);
    assert.match(prompt, /只输出本次新增的 JSONL 事件/u);
    assert.doesNotMatch(prompt, /"type":"done"/u);
});

test('greeting task cards keep independent requirements and output slots', () => {
    const options = normalizeOptions({
        greetingSlots: [
            {
                id: 'greeting.slot.01',
                customRequirement: '停电后的旧教学楼走廊',
                userPreset: 'rival',
                userSetting: '手里拿着三年前的维修照片',
                openingStyle: 'mystery',
                literaryStyle: 'psychologicalSuspense',
                intensity: 'rich',
                length: 'brief',
                asDefault: true,
            },
            {
                id: 'greeting.slot.02',
                customRequirement: '周末清晨一起核对生活费',
                openingStyle: 'daily',
                literaryStyle: 'sliceRealism',
                intensity: 'light',
                length: 'standard',
                asDefault: false,
            },
        ],
    });
    const prompt = buildGreetingPrompt({ mainCharacter: { name: '林知遥' }, loreEvents: [] }, options);
    assert.match(prompt, /slotId：greeting\.slot\.01/);
    assert.match(prompt, /停电后的旧教学楼走廊/);
    assert.match(prompt, /保存位置：默认开场白 first_mes/);
    assert.match(prompt, /悬疑心理流/);
    assert.match(prompt, /周末清晨一起核对生活费/);
    assert.match(buildGreetingSystemPrompt(), /每张任务卡输出一次/);
});

test('style scanner catches contrast sentences and dash characters', () => {
    const events = sampleEvents();
    events[0].summary = '这不是普通考核，而是一场资源竞赛。';
    events[2].description = '她翻开账本—逐项核对。';
    const issues = findStyleIssues(events);
    assert.equal(issues.some(issue => issue.reason.includes('对照句式')), true);
    assert.equal(issues.some(issue => issue.reason.includes('破折号')), true);
});

test('patch events update only requested paths', () => {
    const events = sampleEvents();
    const patches = parsePatchJsonl('{"type":"patch","id":"character.main","changes":{"description":"新的完整描述"}}');
    const updated = applyPatches(events, patches);
    assert.equal(updated[2].description, '新的完整描述');
    assert.equal(updated[2].name, '林知遥');
    assert.notEqual(updated, events);
});

test('continuation merge ignores duplicates and repairs final combined counts', () => {
    const source = sampleEvents();
    const existing = source.slice(0, 4);
    const incoming = [
        { ...source[1] },
        { ...source[0], id: 'project.duplicate' },
        { ...source[3], id: 'npc.second', title: '第二名同学' },
        source[4],
        source[5],
        { type: 'done', id: 'done', counts: { project: 99 } },
    ];
    const merged = mergeContinuationEvents(existing, incoming);
    assert.deepEqual(merged.map(event => event.id), [
        'project.main',
        'world.scholarship',
        'character.main',
        'npc.chen.base',
        'npc.second',
        'relation.lin_chen',
        'lore.hearing',
        'done',
    ]);
    assert.deepEqual(merged.at(-1).counts, {
        project: 1,
        world: 1,
        character: 1,
        npc: 2,
        relation: 1,
        lore: 1,
    });
});

test('continuation merge can pause repeatedly and keeps singleton project and main character', () => {
    const source = sampleEvents();
    const firstResume = mergeContinuationEvents([source[0]], [
        { ...source[0], id: 'project.second' },
        source[1],
        source[2],
    ]);
    assert.equal(firstResume.some(event => event.type === 'done'), false);
    assert.equal(firstResume.filter(event => event.type === 'project').length, 1);

    const secondResume = mergeContinuationEvents(firstResume, [
        { ...source[2], id: 'character.second' },
        source[3],
        source[4],
        source[5],
        source[6],
    ]);
    assert.equal(secondResume.filter(event => event.type === 'character' && event.role === 'main').length, 1);
    assert.equal(secondResume.at(-1).type, 'done');
    assert.equal(validateBlueprint(secondResume).valid, true);
});

test('worldbook compiler creates deterministic native entries', () => {
    const first = compileWorldBook(sampleEvents(), '测试世界书');
    const second = compileWorldBook(sampleEvents(), '测试世界书');
    assert.deepEqual(Object.keys(first.entries), Object.keys(second.entries));
    assert.equal(Object.keys(first.entries).length, 4);
    const hook = Object.values(first.entries).find(entry => entry.comment.includes('学生听证会'));
    assert.equal(hook.sticky, 2);
    assert.equal(hook.cooldown, 3);
    assert.equal(hook.matchWholeWords, false);
    assert.equal(hook.selective, true);
    assert.equal(hook.keysecondary.includes('奖学金'), true);
});

test('worldbook compiler preserves SillyTavern order and selective fields', () => {
    const events = sampleEvents();
    events[1].importance = 'critical';
    events[1].secondaryKeys = ['听证会'];
    const book = compileWorldBook(events, '槐青中学 世界书');
    const entries = Object.values(book.entries);
    const scholarship = entries.find(entry => entry.comment.includes('奖学金考核'));
    const relation = entries.find(entry => entry.comment.includes('林知遥与陈砚舟'));
    assert.equal(scholarship.selective, true);
    assert.equal(scholarship.position, 0);
    assert.equal(scholarship.groupWeight, 100);
    assert.equal(scholarship.order > relation.order, true);
});

test('worldbook activation strategies produce deliberate blue and green entries', () => {
    const events = sampleEvents();
    const allBlueBook = compileWorldBook(events, '', { activationStrategy: 'allBlue' });
    const allBlue = Object.values(allBlueBook.entries);
    assert.equal(allBlue.every(entry => entry.constant), true);
    assert.equal(allBlueBook.extensions.gagaWorldForge.recommendedSettings.budgetPercent, 35);

    const coreBlue = Object.values(compileWorldBook(events, '', { activationStrategy: 'coreBlue' }).entries);
    assert.equal(coreBlue.find(entry => entry.comment.includes('陈砚舟基础印象')).constant, true);
    assert.equal(coreBlue.find(entry => entry.comment.includes('奖学金考核')).constant, true);

    const tokenSaver = Object.values(compileWorldBook(events, '', { activationStrategy: 'tokenSaver' }).entries);
    assert.equal(tokenSaver.find(entry => entry.comment.includes('陈砚舟基础印象')).constant, false);
    assert.equal(tokenSaver.find(entry => entry.comment.includes('学生听证会')).constant, false);
});

test('worldbook compiler maps dynamic state and inclusion pool fields to native SillyTavern fields', () => {
    const events = sampleEvents();
    events.splice(-1, 0, {
        type: 'lore',
        id: 'state.chen.pressure',
        category: 'STATE',
        title: '[STATE] 陈砚舟正在承受预算压力',
        content: '陈砚舟连续两次压低申请金额，说话速度变快，会优先追问票据来源。',
        aliases: [],
        keys: ['预算压力', '压低申请金额'],
        secondaryKeys: [],
        activation: { mode: 'state', selectiveLogic: 'AND_ANY', probability: 100, pool: 'chen-pressure', weight: 240 },
        importance: 'medium',
        persistence: { sticky: 3, cooldown: 2, delay: 0 },
        dependencies: [],
        preventRecursion: true,
        entityId: 'npc.chen',
        aspect: 'state',
    });
    const book = compileWorldBook(events, '', { activationStrategy: 'coreBlue' });
    const stateEntry = Object.values(book.entries).find(entry => entry.comment.includes('预算压力'));
    assert.equal(stateEntry.constant, false);
    assert.equal(stateEntry.position, 4);
    assert.equal(stateEntry.depth, 2);
    assert.equal(stateEntry.scanDepth, 2);
    assert.equal(stateEntry.group.endsWith('.chen-pressure'), true);
    assert.equal(stateEntry.groupWeight, 240);
    assert.equal(stateEntry.useGroupScoring, true);

    const card = compileCharacterCard(events, null, { activationStrategy: 'coreBlue' });
    const embedded = card.data.character_book.entries.find(entry => entry.comment.includes('预算压力'));
    assert.equal(embedded.extensions.position, 4);
    assert.equal(embedded.extensions.scan_depth, 2);
    assert.equal(embedded.extensions.group_weight, 240);
});

test('character card compiler embeds the same lorebook', () => {
    const events = sampleEvents();
    events[2].alternateGreetings = ['雨夜里，她把伞向你这边倾了倾。'];
    const card = compileCharacterCard(events, null, { worldBookName: '槐青中学 世界书', embedBook: true });
    assert.equal(card.spec, 'chara_card_v2');
    assert.equal(card.data.name, '林知遥');
    assert.equal(card.data.extensions.world, '槐青中学 世界书');
    assert.equal(card.data.character_book.entries.length, 4);
    assert.deepEqual(card.data.alternate_greetings, events[2].alternateGreetings);
});

test('trigger simulator distinguishes direct and recursive activation', () => {
    const simulation = simulateLoreActivation(sampleEvents(), '奖学金材料提到听证会的维修报价。', { activationStrategy: 'tokenSaver' });
    assert.equal(simulation.results.some(result => result.title.includes('学生听证会') && result.phase === 'direct'), true);
    assert.equal(simulation.totalChars > 0, true);

    const recursiveEvents = sampleEvents();
    recursiveEvents[1].activation.mode = 'constant';
    recursiveEvents[1].category = 'WORLD';
    recursiveEvents[1].importance = 'critical';
    recursiveEvents[1].content += ' 陈砚舟负责整理本月资料。';
    const recursive = simulateLoreActivation(recursiveEvents, '今天照常上课。', { activationStrategy: 'tokenSaver' });
    assert.equal(recursive.results.some(result => result.title.includes('陈砚舟') && result.phase === 'recursive'), true);
});

test('custom length values remain writing constraints', () => {
    const plan = resolveLengthPlan({
        lengthPreset: 'custom',
        customLength: {
            characterChars: 2400,
            entryCount: 31,
            entryMinChars: 140,
            entryMaxChars: 260,
            importantEntryMaxChars: 480,
            npcCount: 6,
            relationCount: 8,
        },
    });
    assert.deepEqual(plan.entries, [31, 31]);
    assert.deepEqual(plan.npcs, [6, 6]);
    assert.equal(plan.importantEntryMaxChars, 480);
});

test('length scanner catches oversized character cards', () => {
    const events = sampleEvents();
    events[2].description = '很长的角色描述。'.repeat(500);
    const issues = findLengthIssues(events, {
        character: [600, 1000],
        entryChars: [80, 160],
        importantEntryMaxChars: 300,
    });
    assert.equal(issues.some(issue => issue.id === 'character.main' && issue.path === 'description'), true);
});

test('length scanner requests deeper character fields when the card is too thin', () => {
    const events = sampleEvents();
    const issues = findLengthIssues(events, {
        character: [2400, 3600],
        entryChars: [80, 260],
        importantEntryMaxChars: 420,
    });
    assert.equal(issues.some(issue => issue.id === 'character.main' && issue.path === 'description' && /明显低于/u.test(issue.reason)), true);
    assert.equal(issues.some(issue => issue.id === 'character.main' && issue.path === 'personality'), true);
    assert.equal(issues.some(issue => issue.id === 'character.main' && issue.path === 'scenario'), true);
    assert.equal(issues.some(issue => issue.id === 'character.main' && issue.path === 'exampleDialogue'), true);
});
