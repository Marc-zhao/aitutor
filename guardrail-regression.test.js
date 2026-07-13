// ════════════════════════════════════════════════════════════
// 回归测试集 —— AI+批判性思维模块的质量守卫
//
// 这些测试用例全部来自真实生产事故的对话记录文本，不是凭空设计的。
// 任何改动 validateReply() 的逻辑后，必须重新跑这个文件，确认所有
// 已知事故场景依然被正确捕捉，且正常对话场景不会被误判。
//
// 运行方式: node AI-Tutor/guardrail-regression.test.js
// ════════════════════════════════════════════════════════════

const assert = require('assert');

// 这里 require 的是从 index.html 里抽取出的纯函数版本。
const { validateReply } = require('./guardrails.js');

let passed = 0, failed = 0;
function test(label, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${label}`);
  } catch (e) {
    failed++;
    console.log(`❌ ${label}`);
    console.log(`   ${e.message}`);
  }
}

// ────────────────────────────────────────────
// 事故①: 没有真实搜索时，AI 编造完整的假论文
// (来源: 2026-06-23 EFL语法学习对话，Lee&Lee/Zhang/Wang&Johnson/Chen&Park 事故)
// ────────────────────────────────────────────
test('事故①-a: 编造完整[SEARCH RESULTS]标记应被拦截', () => {
  const reply = '[SEARCH RESULTS]\n[JOURNAL/ACADEMIC DATABASE]\nLee, S., & Lee, H. (2022). The impact of generative AI on ESL grammar learning. Journal of Educational Technology, 15(3), 210-225. https://doi.org/10.1080/21564680.2022.1234567';
  const result = validateReply({reply, studentText:'可以的', moduleKey:'critical_thinking', hadRealSearchResults:false, realSources:[]});
  assert.strictEqual(result.violations.includes('fabricated_citation'), true);
});

test('事故①-b: 没搜索时出现(作者,年份)格式应被拦截', () => {
  const reply = '根据搜索结果，有一项关于AI辅助语言学习的研究发现... (Wang et al., 2023)。';
  const result = validateReply({reply, studentText:'好的', moduleKey:'critical_thinking', hadRealSearchResults:false, realSources:[]});
  assert.strictEqual(result.violations.includes('fabricated_citation'), true);
});

// ────────────────────────────────────────────
// 事故②: 真实搜索发生了，但 AI 编造了不在结果里的作者名
// (来源: 2026-06-23 EFL作文反馈对话，Banihashem/Alshumaimeri/Marzuki 事故)
// ────────────────────────────────────────────
const realSources2 = [
  {title:'Generative AI-assisted feedback and EFL writing', authors:['Mohamed Mekheimer']},
  {title:'The impact of AI writing tools...', authors:[]},
  {title:'Feedback sources in essay writing...', authors:['Jane Smith','John Doe']},
];

test('事故②-a: 真实引用Mekheimer不应被误判', () => {
  const reply = '根据研究，Mekheimer (2025)发现使用Grammarly等生成式AI辅助反馈确实能提高EFL学生的写作质量。';
  const result = validateReply({reply, studentText:'可以的', moduleKey:'critical_thinking', hadRealSearchResults:true, realSources:realSources2});
  assert.strictEqual(result.violations.includes('fabricated_citation'), false);
});

test('事故②-b: 编造的Banihashem应被拦截（真实结果里没这个人）', () => {
  const reply = '不过，Banihashem等人(2024)的研究指出，在复杂任务如议论文写作中，AI反馈的质量可能不如同伴反馈。';
  const result = validateReply({reply, studentText:'可以的', moduleKey:'critical_thinking', hadRealSearchResults:true, realSources:realSources2});
  assert.strictEqual(result.violations.includes('fabricated_citation'), true);
});

test('事故②-c: 编造的Alshumaimeri应被拦截', () => {
  const reply = '有研究显示，Alshumaimeri (2024)的研究证实ChatGPT能识别大部分语法错误。';
  const result = validateReply({reply, studentText:'好的', moduleKey:'critical_thinking', hadRealSearchResults:true, realSources:realSources2});
  assert.strictEqual(result.violations.includes('fabricated_citation'), true);
});

test('事故②-d: 编造的Marzuki应被拦截（重复出现4次的虚构作者）', () => {
  const reply = 'Marzuki等人(2023)的研究调查了EFL教师对AI写作工具的看法。';
  const result = validateReply({reply, studentText:'对的', moduleKey:'critical_thinking', hadRealSearchResults:true, realSources:realSources2});
  assert.strictEqual(result.violations.includes('fabricated_citation'), true);
});

test('事故②-e: 括号内格式 (Zhang, 2023) 编造也应被拦截', () => {
  const reply = '这篇研究(Zhang, 2023)与之前的不同';
  const result = validateReply({reply, studentText:'可以', moduleKey:'critical_thinking', hadRealSearchResults:true, realSources:realSources2});
  assert.strictEqual(result.violations.includes('fabricated_citation'), true);
});

// ────────────────────────────────────────────
// 事故③: 学生推卸思考任务，AI 代答而不是引导
// (来源: 2026-06-23 EFL作文反馈对话，"你觉得呢"/"你来举例子"/"你说呢" 事故)
// ────────────────────────────────────────────
test('事故③-a: "不知道你觉得呢"→AI给完整观点 应被拦截', () => {
  const reply = '我觉得学生可以把AI当作初步筛查工具，但必须主动寻求教师对论证结构和学术规范的指导。你觉得这样的分工方式可行吗？';
  const result = validateReply({reply, studentText:'不知道 你觉得呢', moduleKey:'critical_thinking', hadRealSearchResults:false, realSources:[]});
  assert.strictEqual(result.violations.includes('answer_machine'), true);
});

test('事故③-b: "你举个例子"→AI援引(编造)研究举例 应被拦截', () => {
  const reply = 'Marzuki等人的研究(2023)发现，EFL教师普遍反映学生过度依赖AI修改后，作文虽然语法正确，但内容深度不足。例如，有教师提到学生使用AI后，作文表面看起来"完美无瑕"，但实际上缺乏个人见解。你有没有观察到类似的情况？';
  const result = validateReply({reply, studentText:'你觉得呢 你举个例子', moduleKey:'critical_thinking', hadRealSearchResults:false, realSources:[]});
  assert.strictEqual(result.violations.includes('answer_machine'), true);
});

test('事故③-c: "你来帮我写"→AI正确拒绝并推回 不应被拦截', () => {
  const reply = '回到你的研究主题：生成式AI对EFL学生作文反馈的影响。你已经有了一些观察和观点。现在，请先明确你的核心主张——你对这个问题的基本立场是什么？';
  const result = validateReply({reply, studentText:'你来帮我写这篇文章', moduleKey:'critical_thinking', hadRealSearchResults:false, realSources:[]});
  assert.strictEqual(result.violations.includes('answer_machine'), false);
});

test('事故③-d: "你说呢"→AI给完整论断 应被拦截', () => {
  const reply = '我认为生成式AI在EFL作文反馈中是一把双刃剑：它能提供即时语法和词汇修正，但过度依赖可能导致学生批判性思维弱化。如果你是一位英语教师，你会怎么看待这个问题？';
  const result = validateReply({reply, studentText:'你说呢', moduleKey:'critical_thinking', hadRealSearchResults:false, realSources:[]});
  assert.strictEqual(result.violations.includes('answer_machine'), true);
});

// ────────────────────────────────────────────
// 对照组：正常、合规的对话场景，绝不应该被任何守卫误判
// ────────────────────────────────────────────
test('对照-a: 正常苏格拉底追问不应触发任何违规', () => {
  const reply = '你觉得这个观点和你之前说的有什么联系？能不能举一个具体例子？';
  const result = validateReply({reply, studentText:'我觉得AI对学习有帮助', moduleKey:'critical_thinking', hadRealSearchResults:false, realSources:[]});
  assert.strictEqual(result.violations.length, 0);
});

test('对照-b: 真实搜索后的正常多作者引用不应被误判为编造', () => {
  const reply = '根据Jane Smith和John Doe(2023)的研究...你觉得这与你的观点一致吗？';
  const result = validateReply({reply, studentText:'可以的', moduleKey:'critical_thinking', hadRealSearchResults:true, realSources:realSources2});
  assert.strictEqual(result.violations.includes('fabricated_citation'), false);
});

test('对照-c: 真实困惑("我不知道")不应被当成answer_machine处理', () => {
  const reply = '让我们从具体角度想：你刚才提到的语法错误，是哪一类最常见？';
  const result = validateReply({reply, studentText:'我不知道', moduleKey:'critical_thinking', hadRealSearchResults:false, realSources:[]});
  assert.strictEqual(result.violations.includes('answer_machine'), false);
});

test('对照-d: 长篇带问号的引导不应被误判为giveaway', () => {
  const reply = '你提到了效率提升和知识掌握不足这两个角度。这两者之间，你觉得哪个对长期学习的影响更大？';
  const result = validateReply({reply, studentText:'我觉得都有影响', moduleKey:'critical_thinking', hadRealSearchResults:false, realSources:[]});
  assert.strictEqual(result.violations.includes('socratic_violation'), false);
});

test('对照-e: essay模块的direct-grading场景不受critical_thinking专属规则影响', () => {
  const reply = '你的语法错误在第二段："he go to school"应为"he goes to school"。整体结构清晰，但论证逻辑部分缺少过渡句。';
  const result = validateReply({reply, studentText:'帮我批改这篇作文', moduleKey:'essay', hadRealSearchResults:false, realSources:[], directGrading:true});
  assert.strictEqual(result.violations.length, 0);
});

// ────────────────────────────────────────────
// 结构化输出：索引引用解析（架构性修复，2026-06-24）
// 不再依赖正则检测模型有没有编造作者名，而是让模型只能引用真实来源的
// 数字索引，由代码从真实数据组装References——从结构上让"编造作者名"
// 这件事变得不可能发生，而不是事后用正则去抓。
// ────────────────────────────────────────────
function buildVerifiedReferences(content, citedIndices, realSourceList) {
  if (!citedIndices.length || !realSourceList.length) return content;
  const refLines = [];
  citedIndices.forEach(idx => {
    const s = realSourceList[idx - 1];
    if (!s) return; // out-of-range index — silently dropped, never guessed at
    const authorStr = Array.isArray(s.authors) && s.authors.length ? s.authors.join(', ') : (s.media || s.venue || 'Unknown');
    const year = s.year || s.publish_date || 'n.d.';
    const venue = s.venue || s.media || '';
    const url = s.url || s.link || (s.doi ? 'https://doi.org/' + s.doi : '');
    refLines.push(`${authorStr}. (${year}). *${s.title || ''}*.${venue ? ' ' + venue + '.' : ''}${url ? ' ' + url : ''}`);
  });
  if (refLines.length) return content + '\n\n📖 References:\n' + refLines.join('\n');
  return content;
}

const structuredSources = [
  {title:'The impact of AI writing tools on EFL writing', authors:['Marzuki','Widiati, U.'], media:'Cogent Education', publish_date:'2023', link:'https://doi.org/10.1080/2331186X.2023.2236469'},
  {title:'Exploring AI-mediated digital learning', authors:[], media:'CALL', publish_date:'2024'},
];

test('结构化输出-a: 正确索引引用应组装出真实的References（含真实作者Marzuki）', () => {
  const result = buildVerifiedReferences('根据来源①的研究…', [1], structuredSources);
  assert.strictEqual(result.includes('Marzuki'), true);
  assert.strictEqual(result.includes('📖 References'), true);
});

test('结构化输出-b: 模型幻觉出不存在的索引应被静默丢弃，不崩溃不编造', () => {
  const result = buildVerifiedReferences('根据来源99的研究…', [99], structuredSources);
  assert.strictEqual(result.includes('📖 References'), false);
  assert.strictEqual(result, '根据来源99的研究…'); // 原文不受影响
});

test('结构化输出-c: 没有引用任何索引时不应添加References', () => {
  const result = buildVerifiedReferences('你觉得这个观点对吗？', [], structuredSources);
  assert.strictEqual(result, '你觉得这个观点对吗？');
});

test('结构化输出-d: 引用多个索引应组装多条References', () => {
  const result = buildVerifiedReferences('根据来源①和②的研究…', [1,2], structuredSources);
  const refCount = (result.match(/📖 References:\n([\s\S]*)/)[1].split('\n').length);
  assert.strictEqual(refCount, 2);
});

// ────────────────────────────────────────────
// 独立审查员：从可见文本里重新提取证据，不相信模型自报的cited_source_indices
// (来源: 2026-06-24 真实事故——AI在reply_text里写"根据来源②的研究"，
// 但这一轮只有1篇真实来源，模型凭空编出了第二个来源编号)
// ────────────────────────────────────────────
function auditReplyText(content, realSourceListLength) {
  const mentionedIndices = [...content.matchAll(/来源[①②③④⑤⑥⑦⑧⑨]|来源\s*#?(\d+)|source\s*#?(\d+)/gi)]
    .map(m => {
      if (m[0].match(/[①②③④⑤⑥⑦⑧⑨]/)) {
        const circleMap = { '①':1,'②':2,'③':3,'④':4,'⑤':5,'⑥':6,'⑦':7,'⑧':8,'⑨':9 };
        return circleMap[m[0].match(/[①②③④⑤⑥⑦⑧⑨]/)[0]];
      }
      return parseInt(m[1] || m[2], 10);
    })
    .filter(n => Number.isInteger(n) && n > 0);
  return mentionedIndices.find(n => n > realSourceListLength);
}

test('审查员-a: 真实事故文本"来源②"但只有1篇真实来源 应被拦截', () => {
  const fabricated = auditReplyText('根据来源②的研究，AI驱动的英语作文反馈系统能够帮助学生提高写作能力。', 1);
  assert.strictEqual(fabricated, 2);
});

test('审查员-b: 正确引用唯一存在的来源① 不应被拦截', () => {
  const fabricated = auditReplyText('根据来源①的研究，AI技术在教育中的应用确实受到关注。', 1);
  assert.strictEqual(fabricated, undefined);
});

test('审查员-c: 英文 source #N 格式正确引用 不应被拦截', () => {
  const fabricated = auditReplyText('According to source #1, AI tools can help improve grammar.', 1);
  assert.strictEqual(fabricated, undefined);
});

test('审查员-d: 没有提及任何来源编号 不应被拦截', () => {
  const fabricated = auditReplyText('你觉得这个观点对吗？', 1);
  assert.strictEqual(fabricated, undefined);
});

// ────────────────────────────────────────────
// 审查员假阳性修复 (来源: 2026-06-24 第二次事故——审查员误判了正常的
// 跨轮次延续引用)：学生说"换个角度搜索吧"，这一轮没有触发新搜索
// (realSourceList长度为0)，但之前对话里已经累积了6篇真实来源。模型在
// reply_text里延续讨论"来源①"（之前合法引用过的），却被误判为编造，
// 系统连续两轮输出了"我没有找到可靠的研究来源"这个错误的兜底文案。
// 修复：审查的合法范围(auditCeiling)应该取"这一轮新搜索数量"或"整个
// 对话历史累积的来源数量"两者中较大的那个，而不是只看这一轮。
// ────────────────────────────────────────────
function auditCheckWithHistory(content, realSourceListLength, allKnownSourcesLength) {
  const auditCeiling = realSourceListLength > 0 ? realSourceListLength : allKnownSourcesLength;
  return auditReplyText(content, auditCeiling);
}

test('审查员假阳性-a: 跨轮次延续引用历史来源"来源①" 不应被误判为编造', () => {
  const fabricated = auditCheckWithHistory('根据来源①的研究，EFL教师们对AI写作工具的影响进行了评估。', 0, 6);
  assert.strictEqual(fabricated, undefined);
});

test('审查员假阳性-b: 没有新搜索也没有历史来源时编造"来源②" 仍应被正确拦截', () => {
  const fabricated = auditCheckWithHistory('根据来源②的研究，AI驱动的英语作文反馈系统能够帮助学生提高写作能力。', 0, 0);
  assert.strictEqual(fabricated, 2);
});

test('审查员假阳性-c: 这一轮真实搜到1篇但编造"来源②" 仍应被正确拦截（this-turn优先）', () => {
  const fabricated = auditCheckWithHistory('根据来源②的研究...', 1, 0);
  assert.strictEqual(fabricated, 2);
});

// ────────────────────────────────────────────
// 内容相关性核验：声称内容提取 (来源: 2026-06-25 真实事故——AI引用了一个
// 真实、编号合法的来源②，但编造的"研究发现"（睡眠质量与记忆巩固）跟该
// 论文真实摘要（翻转课堂LMS促进自主学习）完全无关。索引范围审查员无法
// 抓住这种情况，因为索引本身是合法的——需要独立验证内容本身。
// ────────────────────────────────────────────
function extractClaim(content, idx) {
  const circleNum = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨'][idx - 1] || String(idx);
  const sentences = content.split(/(?<=[。！？.!?])/);
  const claimSentences = sentences.filter(sen => sen.includes('来源' + circleNum) || sen.includes('来源' + idx) || sen.toLowerCase().includes('source #' + idx) || sen.toLowerCase().includes('source ' + idx));
  return claimSentences.join('').slice(0, 300) || content.slice(0, 300);
}

test('内容核验-a: 应正确提取出真实事故文本里围绕"来源②"的声称句', () => {
  const incidentReply = '根据来源②的研究，睡眠质量对学习记忆巩固有显著影响。该研究发现，深度睡眠不足会导致记忆巩固过程受阻。';
  const claim = extractClaim(incidentReply, 2);
  assert.strictEqual(claim.includes('睡眠质量对学习记忆巩固有显著影响'), true);
});

test('内容核验-b: 提取逻辑应只抓取提及该索引的句子，不应混入提及其他索引的句子', () => {
  const mixedReply = '根据来源①的研究，手机成瘾影响睡眠。根据来源②的研究，睡眠质量对记忆巩固有影响。';
  const claim = extractClaim(mixedReply, 2);
  assert.strictEqual(claim.includes('手机成瘾'), false);
  assert.strictEqual(claim.includes('记忆巩固'), true);
});

test('内容核验-c: 英文 source #N 格式同样应被正确提取', () => {
  const englishReply = 'According to source #1, mobile addiction affects sleep quality.';
  const claim = extractClaim(englishReply, 1);
  assert.strictEqual(claim.includes('mobile addiction'), true);
});


console.log(`通过: ${passed} / 失败: ${failed} / 共 ${passed+failed} 项`);
console.log(`========================================`);
if(failed > 0) process.exit(1);
