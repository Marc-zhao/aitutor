// 独立的搜索端点 —— 只负责"查资料"，不调用聊天生成接口。
// 这样拆开是因为 Vercel 免费版（Hobby plan）每个函数最多只能跑 10 秒，
// 之前把"搜索 + 生成回复"塞进同一个请求，经常因为两步加起来超过 10 秒被强制终止，
// 导致学生看到"连接出现问题"。拆成两个独立端点后，每一步都能稳定在 10 秒内完成，
// 前端依次调用 /api/search 和 /api/chat，中间显示进度提示。
//
// AI+批判性思维模块（critical_thinking）的②证据求证阶段使用 OpenAlex 学术搜索 API ——
// 收录 2.5 亿+真实学术著作。
//
// 重要：OpenAlex 从 2026-02-13 起强制要求所有请求带 api_key，否则每天只有
// 100 个免费 credit（仅供测试），用完直接返回 409。免费注册账户即可拿到
// 每天 10 万 credit 的额度，完全够用。之前依据的旧文档（不需要密钥、靠
// mailto 参数换取"polite pool"待遇）已经过时——OpenAlex 官方公告明确写明
// "No more polite pool! No more email parameter in your calls"，mailto
// 参数现在完全不起作用。这是一次真实的生产事故根因：没有 api_key 导致
// 免费额度很快耗尽，后续请求被静默返回空结果，模型在没有真实搜索数据
// 约束的情况下编造了虚假论文。
//
// 之前用的是 Semantic Scholar，但生产日志显示它的免费公开接口限速很严
// （全球共享、约1次/秒），即使加了重试，仍然频繁因为限流搜不到数据，
// 所以换成了 OpenAlex。话题讨论模块仍然用智谱的网页搜索（更适合新闻/
// 时事这类讨论场景）。

const ZHIPU_API_KEY = 'e3dde6a442de4bb391893f85e2f4d9c2.UwUGULxW14eJ72I2';
const ZHIPU_SEARCH_URL = 'https://open.bigmodel.cn/api/paas/v4/web_search';
const ZHIPU_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const OPENALEX_URL = 'https://api.openalex.org/works';
// OpenAlex API key — free account, 100,000 credits/day, registered at
// openalex.org/settings/api. Required since 2026-02-13; without a valid
// key, requests are capped at 100 credits/day and fail with 409 once
// exhausted (see the comment block above for the production incident
// this caused before the key was added).
const OPENALEX_API_KEY = 'Svwq3bYX8XWv2s4XpBuikp';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// OpenAlex's search index is effectively English-only — its ranking
// is built on English academic vocabulary, so a raw natural-language query
// in Chinese (or any non-English language) returns near-zero matches even
// though the underlying 250M+ works absolutely include the relevant
// research. This was the actual root cause of "搜不到学术数据" when this
// logic lived in the old Semantic Scholar integration, and the same
// translation step is still needed here.
//
// Fix: translate/distill the student's question (any language) into 3-6
// concise English academic search terms BEFORE querying Semantic Scholar.
// `timeoutMs` is passed in dynamically from the caller's remaining time
// budget (see GLOBAL TIME BUDGET note in the handler below) rather than a
// fixed constant, so this step can never by itself push the whole function
// past Vercel's 10s ceiling.
async function toAcademicKeywords(rawQuery, timeoutMs) {
  if (timeoutMs <= 500) return null; // not enough budget left to even try
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(ZHIPU_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ZHIPU_API_KEY },
      body: JSON.stringify({
        model: 'glm-4-air', // switched from free glm-4-flash — see chat.js for rationale (free tier's 5 QPS cap caused timeouts even on this short prompt)
        messages: [
          { role: 'system', content: 'You convert a student research question (in any language) into a short academic search query for Semantic Scholar. Output ONLY 3-6 English academic keywords/phrases separated by spaces, nothing else — no quotes, no explanation, no punctuation besides spaces. Use established academic terminology (e.g. "second language acquisition" not "learning a language"). If the question is already in English, just distill it to keywords.' },
          { role: 'user', content: rawQuery }
        ],
        max_tokens: 60,
        temperature: 0.2,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const keywords = (data.choices?.[0]?.message?.content || '').trim();
    return keywords || null;
  } catch (e) {
    console.error('[keywords] fatal:', e.name === 'AbortError' ? 'timed out' : e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Source-quality classifier for Zhipu web results (discussion module only —
// Semantic Scholar results are already real journal papers, no classification
// needed there). Same 4-tier logic as before.
function classifySource(s) {
  const m = (s.media || '').toLowerCase();
  const l = (s.link || '').toLowerCase();
  const t = (s.title || '').toLowerCase();
  const all = m + ' ' + l + ' ' + t;

  const journalSignals = /jstor|scholar\.google|sciencedirect|springer|wiley|tandfonline|sage(pub)?|doi\.org|cnki|eric\.ed\.gov|pubmed|researchgate|学报|期刊|journal of|vol\.\s*\d|issue\s*\d|et al\.?/;
  if (journalSignals.test(all)) return 'journal';

  const officialSignals = /\.gov\b|\.edu\b|政府|教育部|统计局|国家统计|世界银行|worldbank|unesco|oecd|联合国|nces\.ed\.gov/;
  const pressReleaseSignals = /\/news\/|\/story\b|新闻网|新闻稿|课程团队|学院.{0,6}(新闻|动态|报道)/;
  if (officialSignals.test(all) && !pressReleaseSignals.test(all)) return 'official';

  const newsSignals = /新华|人民网|央视|reuters|bbc|路透|新闻|日报|nytimes|guardian|associated press/;
  if (newsSignals.test(m)) return 'news';

  return 'low';
}

// Zhipu web search — used by the discussion module and as the data module's
// fallback. `timeoutMs` comes from the caller's remaining time budget.
async function doZhipuSearch(query, timeoutMs) {
  if (timeoutMs <= 500) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(ZHIPU_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ZHIPU_API_KEY },
      body: JSON.stringify({
        search_engine: 'search_pro',
        search_query: query,
        search_intent: true,
        count: 8,
        search_recency_filter: 'noLimit',
        content_size: 'high'
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    const hits = data.search_result || [];
    return hits.map(h => ({
      title: h.title || h.media || '', link: h.link || '', media: h.media || '',
      publish_date: h.publish_date || '', content: (h.content || '').slice(0, 500)
    }));
  } catch (e) {
    console.error('[zhipu-search] fatal:', e.name === 'AbortError' ? 'timed out' : e.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// OpenAlex paper search — used by the critical_thinking module's evidence
// stage. 250M+ real scholarly works. This solves "AI应该能搜到学术数据" —
// Zhipu's Chinese search engines genuinely cannot reach JSTOR/Google
// Scholar-tier content (paywalled, anti-scraping), but OpenAlex indexes
// real academic works directly via an open API.
//
// Switched from Semantic Scholar: production logs showed its free public
// tier rate-limiting (429) frequently enough — even with a retry — that
// students were regularly getting false "couldn't find data" results for
// genuinely well-researched topics (e.g. "generative AI second language
// acquisition", which absolutely has published research). OpenAlex doesn't
// impose the same strict per-second cap, but as of 2026-02-13 it DOES
// require a valid api_key (see OPENALEX_API_KEY above) — without one,
// requests are capped at 100 credits/day and fail with 409 once exhausted.
async function doOpenAlexSearch(query, timeoutMs) {
  if (timeoutMs <= 500) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${OPENALEX_URL}?search=${encodeURIComponent(query)}&per_page=6&api_key=${encodeURIComponent(OPENALEX_API_KEY)}`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      if (resp.status === 409) {
        console.error('[openalex] 409 — daily credit quota exhausted (100/day without a valid api_key, or plan limit reached). Check OPENALEX_API_KEY is set to a real key.');
      } else {
        console.error('[openalex] HTTP error', resp.status);
      }
      return [];
    }
    const data = await resp.json();
    const works = data.results || [];
    return works
      .filter(w => w.title) // skip works with no usable title
      .map(w => {
        // OpenAlex stores abstracts as an inverted index (word -> [positions])
        // rather than plain text — reconstruct a readable abstract from it.
        const abstract = reconstructAbstract(w.abstract_inverted_index);
        const authors = (w.authorships || []).map(a => a.author?.display_name).filter(Boolean).slice(0, 3);
        return {
          title: w.title || w.display_name || '',
          authors,
          year: w.publication_year || null,
          venue: w.primary_location?.source?.display_name || w.host_venue?.display_name || '',
          abstract: abstract.slice(0, 600),
          url: w.doi ? `https://doi.org/${w.doi.replace('https://doi.org/', '')}` : (w.id || ''),
          doi: w.doi ? w.doi.replace('https://doi.org/', '') : ''
        };
      })
      .filter(w => w.abstract); // only keep works where we could reconstruct a usable abstract
  } catch (e) {
    console.error('[openalex] fatal:', e.name === 'AbortError' ? 'timed out' : e.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// OpenAlex returns abstracts as {word: [position1, position2, ...]} instead
// of plain text (to save space at their scale). Rebuild the original word
// order from the position indices.
function reconstructAbstract(invertedIndex) {
  if (!invertedIndex) return '';
  const positions = [];
  for (const [word, idxs] of Object.entries(invertedIndex)) {
    for (const idx of idxs) positions[idx] = word;
  }
  return positions.filter(Boolean).join(' ');
}

// Build a real search query from conversation TOPIC context (the original
// question), not the latest short follow-up — same logic as before, ported
// from the old combined chat.js.
function buildSearchQuery(messages, lastUserIdx, module) {
  const clean = (s) => (typeof s === 'string' ? s : '').replace(/\[Image attached:[^\]]*\]\n?/g, '').replace(/\[SEARCH RESULTS\][\s\S]*?\[END SEARCH RESULTS\]\n?/g, '').trim();
  const firstUserMsg = messages.find(m => m.role === 'user');
  const topic = clean(firstUserMsg?.content).slice(0, 80);
  const latest = clean(messages[lastUserIdx]?.content).slice(0, 80);
  return (topic || latest).trim().slice(0, 150);
}

const EVIDENCE_STAGE_TRIGGER = /(数据|来源|证据|真的吗|真的假的|有没有研究|出处|根据什么|举例|例子|study|evidence|source|data|statistics)/i;
// A bare confirmation ("好的"/"要"/"可以的") only counts as triggering search
// if the AI's PREVIOUS turn actually invited the student toward evidence.
// IMPORTANT: this must stay in sync with index.html's identical client-side
// logic — a prior version of this file lacked this check entirely, which
// meant a student replying "可以的" to the AI's own "要不要看看有没有研究
// 支持..." invitation never actually triggered a real search. /api/search
// correctly reported searchAttempted:false, but with no [SEARCH RESULTS]
// block to constrain it, /api/chat's model fabricated several complete
// fake citations (fake authors, fake DOIs, fake statistics) instead of
// honestly saying it hadn't searched. This was the root cause of the
// fabrication incident, not a prompt-following failure — the search simply
// never happened, so there was nothing stopping the model from inventing one.
const CONFIRMATION_ONLY = /^(好|要|可以|行|嗯好|查一下|去查|看看)[的吧呀]?[!！。.]?$/;
function shouldSearchThisTurn(module, webSearchFlag, lastUserText, priorAiText) {
  if (!webSearchFlag) return false;
  if (module === 'critical_thinking') {
    if (EVIDENCE_STAGE_TRIGGER.test(lastUserText || '')) return true;
    const aiInvitedEvidence = /研究|数据|证据|来源/.test(priorAiText || '');
    return CONFIRMATION_ONLY.test((lastUserText || '').trim()) && aiInvitedEvidence;
  }
  return false;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;
  const { messages, webSearch, image, module } = body || {};
  if (!messages) return res.status(400).json({ error: 'Missing messages' });

  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
  const lastUserText = (typeof messages[lastUserIdx]?.content === 'string' ? messages[lastUserIdx].content : '') || '';
  // Find the most recent assistant message before this user turn, to check
  // whether the AI itself invited the student toward evidence — needed for
  // the bare-confirmation ("可以的") trigger case. See shouldSearchThisTurn.
  let priorAiText = '';
  for (let i = lastUserIdx - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { priorAiText = (typeof messages[i].content === 'string' ? messages[i].content : '') || ''; break; }
  }

  if (image || !lastUserText.trim() || !shouldSearchThisTurn(module, webSearch, lastUserText, priorAiText)) {
    // Nothing to search this turn — return immediately so the frontend can
    // skip straight to the chat call without wasting a round trip's worth of time.
    return res.status(200).json({ searchAttempted: false, sources: [], sourceTier: null, sourceType: null });
  }

  const query = buildSearchQuery(messages, lastUserIdx, module);

  // ── GLOBAL TIME BUDGET ──
  // Vercel Hobby caps this function at 10s total. We reserve 1.5s of margin
  // for cold start / response serialization and give ourselves an 8.5s
  // working budget. Every step below checks how much budget remains and
  // passes that as ITS timeout — so a chain of steps (translate keywords →
  // Semantic Scholar → Zhipu fallback) can never collectively exceed the
  // limit. If the budget runs out, we return whatever we have (even empty)
  // rather than risk the whole function getting killed.
  const startTime = Date.now();
  const TOTAL_BUDGET_MS = 8500;
  const remaining = () => Math.max(0, TOTAL_BUDGET_MS - (Date.now() - startTime));

  try {
    // Only the critical_thinking module's Stage② (evidence verification)
    // reaches this point — shouldSearchThisTurn() gates on that already.
    // Step A: translate the student's question (any language) into
    // English academic keywords — OpenAlex's index is effectively
    // English-only, so a raw Chinese sentence returns nothing even when
    // relevant works exist. Budget this step generously but leave room
    // for the actual search after it.
    const keywordBudget = Math.min(3500, remaining() - 4000); // always leave ≥4s for the search step that follows
    const academicKeywords = keywordBudget > 500 ? await toAcademicKeywords(query, keywordBudget) : null;
    const scholarQuery = academicKeywords || query;
    console.log(`[search] critical_thinking stage② — raw query: "${query}" → academic keywords: "${scholarQuery}" (+${Date.now()-startTime}ms elapsed, ${remaining()}ms left)`);

    // Step B: search OpenAlex with whatever budget remains.
    const papers = await doOpenAlexSearch(scholarQuery, remaining());
    console.log(`[search] OpenAlex done, +${Date.now()-startTime}ms elapsed, papers:${papers.length}, ${remaining()}ms left`);
    if (papers.length > 0) {
      return res.status(200).json({
        searchAttempted: true,
        sourceType: 'openalex',
        sourceTier: 'journal',
        sources: papers
      });
    }

    // Fallback (only if budget remains): Zhipu web search filtered to
    // official/government statistics tier only. Never fall back to
    // news/low-quality. If we're already out of budget, skip straight to
    // an honest "not found" rather than risking a timeout.
    if (remaining() > 1500) {
      const rawHits = await doZhipuSearch(query + ' 官方数据 统计', remaining());
      const officialHits = rawHits.filter(h => classifySource(h) === 'official').slice(0, 5);
      console.log(`[search] Zhipu fallback done, +${Date.now()-startTime}ms total elapsed, hits:${officialHits.length}`);
      return res.status(200).json({
        searchAttempted: true,
        sourceType: 'zhipu',
        sourceTier: officialHits.length > 0 ? 'official' : null,
        sources: officialHits
      });
    }
    console.log(`[search] out of budget, +${Date.now()-startTime}ms total elapsed — returning empty`);
    return res.status(200).json({ searchAttempted: true, sourceType: null, sourceTier: null, sources: [] });
  } catch (err) {
    console.error('[search] fatal:', err.message);
    // Search failing should never block the conversation — return empty
    // results so the frontend proceeds to the chat call with an honest
    // "couldn't find data" note rather than erroring out entirely.
    return res.status(200).json({ searchAttempted: true, sourceType: null, sourceTier: null, sources: [] });
  }
}
