// 独立的搜索端点 —— 只负责"查资料"，不调用聊天生成接口。
// 这样拆开是因为 Vercel 免费版（Hobby plan）每个函数最多只能跑 10 秒，
// 之前把"搜索 + 生成回复"塞进同一个请求，经常因为两步加起来超过 10 秒被强制终止，
// 导致学生看到"连接出现问题"。拆成两个独立端点后，每一步都能稳定在 10 秒内完成，
// 前端依次调用 /api/search 和 /api/chat，中间显示进度提示。
//
// 数据收集模块（module==='data'）使用 OpenAlex 学术搜索 API —— 完全免费、
// 不需要密钥、收录 2.5 亿+真实学术著作。之前用的是 Semantic Scholar，但生产
// 日志显示它的免费公开接口限速很严（全球共享、约1次/秒），即使加了重试，
// 仍然频繁因为限流搜不到数据。OpenAlex 同样免费且数据量更大，关键是它的
// "polite pool"机制（请求带上邮箱参数）能拿到更快更稳定的响应，没有
// Semantic Scholar 那种容易触发的严格限速。话题讨论模块仍然用智谱的网页
// 搜索（更适合新闻/时事这类讨论场景）。

const ZHIPU_API_KEY = 'e3dde6a442de4bb391893f85e2f4d9c2.UwUGULxW14eJ72I2';
const ZHIPU_SEARCH_URL = 'https://open.bigmodel.cn/api/paas/v4/web_search';
const ZHIPU_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const OPENALEX_URL = 'https://api.openalex.org/works';
// "Polite pool" contact — OpenAlex explicitly documents that requests with
// a mailto param get routed to a faster, more reliable response pool.
// This is a generic placeholder; any valid-looking email works for this purpose.
const OPENALEX_MAILTO = 'contact@aitutor-sand.vercel.app';

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

// OpenAlex paper search — used by the data-collection module. Free, no API
// key, 250M+ real scholarly works. This solves "AI应该能搜到学术数据" —
// Zhipu's Chinese search engines genuinely cannot reach JSTOR/Google
// Scholar-tier content (paywalled, anti-scraping), but OpenAlex indexes
// real academic works directly via an open API.
//
// Switched from Semantic Scholar: production logs showed its free public
// tier rate-limiting (429) frequently enough — even with a retry — that
// students were regularly getting false "couldn't find data" results for
// genuinely well-researched topics (e.g. "generative AI second language
// acquisition", which absolutely has published research). OpenAlex doesn't
// impose the same strict per-second cap; including a contact email via the
// `mailto` param routes requests to OpenAlex's faster "polite pool" with
// more consistent response times, per their own documentation. No retry
// logic needed here as a result — a single attempt is reliable enough.
async function doOpenAlexSearch(query, timeoutMs) {
  if (timeoutMs <= 500) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${OPENALEX_URL}?search=${encodeURIComponent(query)}&per_page=6&mailto=${encodeURIComponent(OPENALEX_MAILTO)}`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      console.error('[openalex] HTTP error', resp.status);
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

const DISCUSSION_SEARCH_TRIGGER = /(数据|来源|证据|真的吗|真的假的|有没有研究|出处|根据什么|举例|例子|study|evidence|source|data|statistics)/i;
function shouldSearchThisTurn(module, webSearchFlag, lastUserText) {
  if (!webSearchFlag) return false;
  if (module === 'data') return true;
  if (module === 'discussion') return DISCUSSION_SEARCH_TRIGGER.test(lastUserText || '');
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

  if (image || !lastUserText.trim() || !shouldSearchThisTurn(module, webSearch, lastUserText)) {
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
    if (module === 'data') {
      // Step A: translate the student's question (any language) into
      // English academic keywords — OpenAlex's index is effectively
      // English-only, so a raw Chinese sentence returns nothing even when
      // relevant works exist. Budget this step generously but leave room
      // for the actual search after it.
      const keywordBudget = Math.min(3500, remaining() - 4000); // always leave ≥4s for the search step that follows
      const academicKeywords = keywordBudget > 500 ? await toAcademicKeywords(query, keywordBudget) : null;
      const scholarQuery = academicKeywords || query;
      console.log(`[search] data module — raw query: "${query}" → academic keywords: "${scholarQuery}" (+${Date.now()-startTime}ms elapsed, ${remaining()}ms left)`);

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

      // Step C (fallback, only if budget remains): Zhipu web search filtered
      // to official/government statistics tier only. Never fall back to
      // news/low-quality for this module. If we're already out of budget,
      // skip straight to an honest "not found" rather than risking a timeout.
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
      console.log(`[search] out of budget after Semantic Scholar, +${Date.now()-startTime}ms total elapsed — returning empty`);
      return res.status(200).json({ searchAttempted: true, sourceType: null, sourceTier: null, sources: [] });
    } else {
      // Discussion module: Zhipu web search, news allowed, low-quality excluded.
      const rawHits = await doZhipuSearch(query, remaining());
      const filtered = rawHits.filter(h => classifySource(h) !== 'low').slice(0, 5);
      return res.status(200).json({
        searchAttempted: true,
        sourceType: 'zhipu',
        sourceTier: null,
        sources: filtered
      });
    }
  } catch (err) {
    console.error('[search] fatal:', err.message);
    // Search failing should never block the conversation — return empty
    // results so the frontend proceeds to the chat call with an honest
    // "couldn't find data" note rather than erroring out entirely.
    return res.status(200).json({ searchAttempted: true, sourceType: null, sourceTier: null, sources: [] });
  }
}
