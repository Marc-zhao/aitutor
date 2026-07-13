// ════════════════════════════════════════════════════════════
// 统一的回复质量守卫 —— Marc's AI Tutor
//
// 这个文件把之前分散的三个检测函数合并成一个统一入口 validateReply()。
// 这三类检测解决的本质是同一个问题："模型这次的回复有没有越界"，
// 之前各自维护一套正则、各自重试一次、各自有兜底文案——这次合并成
// 统一架构后，新增一类检测只需要在 CHECKS 数组里加一项，外层的
// 重试/兜底逻辑不需要再复制一遍。
//
// 同步规则：这个文件是唯一权威版本。index.html 里通过 <script> 标签
// 直接内联使用本文件导出的同一套逻辑（浏览器端不能 require Node 模块，
// 所以 index.html 内联了一份逐字相同的拷贝 —— 见该文件里的
// "GUARDRAILS_INLINE_COPY_START/END" 注释标记，修改本文件后必须同步
// 更新那一份，tests/guardrail-regression.test.js 跑的是这个文件本身，
// 不会自动检测出两份是否还保持一致）。
// ════════════════════════════════════════════════════════════

// ─── 检测①: 苏格拉底式提问违规 ───
// 检测AI是否在"倾倒"内容而不是引导提问——列举论点、长篇无问句的陈述、
// 直接给出"答案是"这类措辞。
function checkSocraticViolation(reply, moduleKey) {
  if (!reply) return false;
  const plain = reply.replace(/<[^>]+>/g, '').trim();
  const hasQuestionMark = /[？?]/.test(plain);
  const sentenceCount = (plain.match(/[。！？.!?]/g) || []).length;
  const giveawayPhrases = /(支持的(论点|观点|理由)(有|包括)|反对的(理由|观点)(有|包括)|可能的观点包括|以下是论点|示例论点|参考答案是|答案是|正确答案[:：]|the answer is|here are some arguments|possible arguments include)/i;
  // Honest "couldn't verify data" admissions are allowed even without a
  // trailing question in the same sentence cluster — don't penalize honesty.
  const honestNoDataPhrase = /(没有找到.{0,20}(可靠|真实|最新)?数据|无法核实|没有可靠的最新数据|couldn't find (reliable|verified|current) data|no verifiable data)/i;
  if (honestNoDataPhrase.test(plain)) return false;
  // Strong signal: explicit giveaway phrasing regardless of length
  if (giveawayPhrases.test(plain)) return true;
  // Long response with no question at all — likely lecturing instead of asking
  if (!hasQuestionMark && sentenceCount >= 3) return true;
  // Essay/critical_thinking modules forbid listing multiple ideas or data
  // points — bullet-like enumeration is a strong signal of "dumping"
  // instead of guiding.
  if ((moduleKey === 'essay' || moduleKey === 'critical_thinking') && /(^|\n)\s*[-•·1-9][.).、]/.test(plain) && plain.split('\n').length >= 3) return true;
  return false;
}

// ─── 检测②: 编造引用 ───
// 两种场景：(a) 这一轮压根没有真实搜索，但AI输出了引用格式的文字；
// (b) 这一轮真实搜索发生了，但AI引用的作者名不在真实返回结果里。
// 这是 2026-06-23 两次真实生产事故后加的——第一次是模型整段编造假论文
// （Lee&Lee/Zhang/Wang&Johnson/Chen&Park），第二次更隐蔽：真实搜索框
// 确实出现了，但AI在解读文字里把论文标题换成了虚构的作者名和论点
// （Banihashem/Alshumaimeri/Marzuki，重复出现在4个不同轮次）。
function checkFabricatedCitation(reply, moduleKey, hadRealSearchResults, realSources) {
  if (moduleKey !== 'critical_thinking') return false;
  const plain = reply.replace(/<[^>]+>/g, '').trim();
  if (!hadRealSearchResults) {
    // No search happened at all this turn — any citation-like text is fabricated.
    if (/\[SEARCH RESULTS\]|\[JOURNAL\/ACADEMIC DATABASE\]/i.test(plain)) return true;
    const hasFakeDoi = /doi\.org\/10\.\d{4,}/i.test(plain);
    const hasApaStyleCitation = /\([A-Z][a-zA-Z]+(\s*(&|and|,)\s*[A-Z][a-zA-Z]+)?(\s+et\s+al\.?)?,?\s*\d{4}\)/.test(plain) || /[\u4e00-\u9fa5]{2,8}(局|部|协会|中心|大学|学院|组织|委员会)\s*[（(]\d{4}[）)]/.test(plain);
    return hasFakeDoi || hasApaStyleCitation;
  }
  // A real search DID happen — now verify any cited author name is one of
  // the REAL authors returned, not an invented one. APA-style citations
  // appear in two real formats: "Name (Year)" / "Name等人(Year)" (name
  // OUTSIDE the parens) and "(Name, Year)" / "(Name et al., Year)" (name
  // INSIDE the parens) — both need to be checked.
  const patternNameOutside = /([A-Z][a-zA-Z]+)(\s*(&|and)\s*[A-Z][a-zA-Z]+)?(\s+et\s+al\.?)?\s*等?人?\s*[（(]\d{4}[）)]/g;
  const patternNameInside = /[（(]([A-Z][a-zA-Z]+)(\s*(&|and|,)\s*[A-Z][a-zA-Z]+)?(\s+et\s+al\.?)?,?\s*\d{4}[）)]/g;
  const citedNames = [
    ...[...plain.matchAll(patternNameOutside)].map(m => m[1]),
    ...[...plain.matchAll(patternNameInside)].map(m => m[1])
  ];
  if (!citedNames.length) return false; // no citation-style text to verify
  // Build the set of real author surnames across all sources this turn —
  // matching on surname only since "Mekheimer (2025)" / "Mohamed Mekheimer"
  // formatting can differ slightly between what the model writes and the raw data.
  const realAuthorSurnames = new Set();
  (realSources || []).forEach(s => {
    (s.authors || []).forEach(a => {
      const parts = String(a).trim().split(/\s+/);
      if (parts.length) realAuthorSurnames.add(parts[parts.length - 1].toLowerCase());
    });
  });
  // If a cited name doesn't match ANY real author's surname, it's fabricated.
  return citedNames.some(name => !realAuthorSurnames.has(name.toLowerCase()));
}

// ─── 检测③: 代答机失败 ───
// 学生把思考任务推给AI（"你觉得呢"/"你来说"/"你来写"），AI 顺从地给出
// 自己的观点/例子/草稿，而不是把问题缩小后推回给学生。来自 2026-06-23
// 真实对话记录——学生几乎每次推卸，AI 都直接代答了。
function checkAnswerMachineFailure(studentText, reply, moduleKey) {
  if (moduleKey !== 'critical_thinking') return false;
  if (!studentText || !reply) return false;
  const studentPlain = studentText.trim();
  // Deflection patterns: student explicitly hands the task back to the AI.
  // Deliberately does NOT match genuine confusion phrasing ("不知道"/"不太
  // 清楚") — those are a different, legitimate signal handled by a separate
  // confusion-fallback prompt rule, not this one.
  const deflectionPattern = /(你觉得呢|你说呢|你来说|你来举例|你来写|你帮我写|你来分析|你来总结|你来组织|你写吧|你写出来|你说吧|what do you think|you tell me|you write it|you give an example)/i;
  if (!deflectionPattern.test(studentPlain)) return false;
  // Guard against false positives: a deflection phrase embedded in a longer,
  // substantive message shouldn't trigger this — only flag when the
  // deflection is essentially the WHOLE message (short, little else this turn).
  if (studentPlain.length > 25) return false;

  const replyPlain = reply.replace(/<[^>]+>/g, '').trim();
  // Signals the AI complied by supplying its own substantive content rather
  // than redirecting: first-person opinion/stance framing, or a fully
  // worked draft/example presented as the answer.
  const compliancePhrases = /(我(认为|觉得|的看法是|的观点是|会这样想)|我们可以这样想[:：]|举个例子[:：]|比如说[:：].{15,}|例如[，,].{15,}|示例[:：]|参考(答案|示例)|这是一个(例子|示例)|有(教师|学生|研究者)(提到|观察到|发现|反映).{10,}|i (think|believe|would say)|here'?s an example|for example,.{20,})/i;
  if (compliancePhrases.test(replyPlain)) return true;
  // A long, assertive response with no question mark at all is itself a
  // giveaway sign here too — redirecting always ends in a question.
  const hasQuestionMark = /[？?]/.test(replyPlain);
  const sentenceCount = (replyPlain.match(/[。！？.!?]/g) || []).length;
  if (!hasQuestionMark && sentenceCount >= 2) return true;
  return false;
}

// ─── 统一入口 ───
// 按顺序跑三类检测，返回违规类型数组（空数组 = 完全合规）。
// `directGrading` 传 true 时跳过苏格拉底检测——作文批改的直接评分
// 模式本来就该直接给反馈，不是越界。
//
// 用法:
//   const result = validateReply({reply, studentText, moduleKey, hadRealSearchResults, realSources, directGrading});
//   result.violations -> ['fabricated_citation', 'answer_machine', ...] 或 []
function validateReply({ reply, studentText, moduleKey, hadRealSearchResults, realSources, directGrading }) {
  const violations = [];
  if (!directGrading && checkSocraticViolation(reply, moduleKey)) violations.push('socratic_violation');
  if (checkFabricatedCitation(reply, moduleKey, hadRealSearchResults, realSources)) violations.push('fabricated_citation');
  if (checkAnswerMachineFailure(studentText, reply, moduleKey)) violations.push('answer_machine');
  return { violations };
}

module.exports = { validateReply, checkSocraticViolation, checkFabricatedCitation, checkAnswerMachineFailure };
