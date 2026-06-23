// 独立的搜索端点 —— 只负责"查资料"，不调用聊天生成接口。
// 这样拆开是因为 Vercel 免费版（Hobby plan）每个函数最多只能跑 10 秒，
// 之前把"搜索 + 生成回复"塞进同一个请求，经常因为两步加起来超过 10 秒被强制终止，
// 导致学生看到"连接出现问题"。拆成两个独立端点后，每一步都能稳定在 10 秒内完成，
// 前端依次调用 /api/search 和 /api/chat，中间显示进度提示。
//
// 数据收集模块（module==='data'）现在改用 Semantic Scholar 学术搜索 API ——
// 这是一个完全免费、不需要密钥、收录 2 亿+真实学术论文的数据库，专门解决
// "智谱的中文搜索引擎搜不到真正的期刊论文"这个问题。话题讨论模块仍然用
// 智谱的网页搜索（更适合新闻/时事这类讨论场景）。

const ZHIPU_API_KEY = 'e3dde6a442de4bb391893f85e2f4d9c2.UwUGULxW14eJ72I2';
const ZHIPU_SEARCH_URL = 'https://open.bigmodel.cn/api/paas/v4/web_search';
const SEMANTIC_SCHOLAR_URL = 'https://api.semanticscholar.org/graph/v1/paper/search';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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

// Zhipu web search — used by the discussion module. Tight 7s timeout so this
// endpoint alone (search only, no chat call) finishes well within Vercel's
// 10s Hobby-plan ceiling.
async function doZhipuSearch(query, timeoutMs = 7000) {
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

// Semantic Scholar paper search — used by the data-collection module. Free,
// no API key, ~200M real papers. This is what actually solves "AI应该能搜到
// 学术数据" — Zhipu's Chinese search engines genuinely cannot reach JSTOR/
// Google Scholar-tier content (paywalled, anti-scraping), but Semantic
// Scholar indexes real papers directly and exposes them via an open API.
async function doSemanticScholarSearch(query, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${SEMANTIC_SCHOLAR_URL}?query=${encodeURIComponent(query)}&limit=6&fields=title,authors,year,venue,abstract,url,externalIds`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      console.error('[semantic-scholar] HTTP error', resp.status);
      return [];
    }
    const data = await resp.json();
    const papers = data.data || [];
    return papers
      .filter(p => p.title && p.abstract) // skip papers with no usable content
      .map(p => ({
        title: p.title || '',
        authors: (p.authors || []).map(a => a.name).slice(0, 3),
        year: p.year || null,
        venue: p.venue || '',
        abstract: (p.abstract || '').slice(0, 600),
        url: p.url || (p.externalIds?.DOI ? `https://doi.org/${p.externalIds.DOI}` : ''),
        doi: p.externalIds?.DOI || ''
      }));
  } catch (e) {
    console.error('[semantic-scholar] fatal:', e.name === 'AbortError' ? 'timed out' : e.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
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

  try {
    if (module === 'data') {
      // Try Semantic Scholar first (real journal papers). If nothing comes
      // back (topic too niche, API hiccup, etc.), fall back to Zhipu web
      // search filtered to official/government-statistics tier only — never
      // fall back to news/low-quality for this module.
      const papers = await doSemanticScholarSearch(query);
      if (papers.length > 0) {
        return res.status(200).json({
          searchAttempted: true,
          sourceType: 'semantic_scholar',
          sourceTier: 'journal',
          sources: papers
        });
      }
      const rawHits = await doZhipuSearch(query + ' 官方数据 统计');
      const officialHits = rawHits.filter(h => classifySource(h) === 'official').slice(0, 5);
      return res.status(200).json({
        searchAttempted: true,
        sourceType: 'zhipu',
        sourceTier: officialHits.length > 0 ? 'official' : null,
        sources: officialHits
      });
    } else {
      // Discussion module: Zhipu web search, news allowed, low-quality excluded.
      const rawHits = await doZhipuSearch(query);
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
