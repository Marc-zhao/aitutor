// 智谱清言 (Zhipu AI) — GLM-4V-Flash 图片理解 + GLM-4-Flash 文字对话
// 速度快，国内直连，免费额度大
//
// NOTE: This runs on the Node.js serverless runtime (NOT Edge).
// Vercel's Edge runtime has a HARD 25-second timeout that `vercel.json`'s
// `maxDuration` setting CANNOT override — that setting only works for
// Node serverless functions. On Edge, a slow GLM-4V-Flash call gets
// silently killed with no error and no response, which is exactly what
// was causing "AI can't read images" with no visible error in console.
// Node serverless functions respect maxDuration (set to 30s in vercel.json).

const ZHIPU_API_KEY = 'e3dde6a442de4bb391893f85e2f4d9c2.UwUGULxW14eJ72I2';
const ZHIPU_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const ZHIPU_SEARCH_URL = 'https://open.bigmodel.cn/api/paas/v4/web_search';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Source-quality classifier. Used to (a) filter what we even show the model
// for the data-collection module — self-media/blogs/forums are DROPPED
// entirely there, not just labeled — and (b) label remaining sources for
// discussion. "academic" = official/gov/edu/statistics-agency/journal level;
// "news" = mainstream news outlets; "low" = self-media, blogs, forums, Q&A
// sites, SEO content farms — never presented as data in the data module.
function classifySource(s) {
  const m = (s.media || '').toLowerCase();
  const l = (s.link || '').toLowerCase();
  const t = (s.title || '').toLowerCase();
  if (/\.gov|\.edu|政府|教育部|统计局|国家统计|世界银行|worldbank|unesco|oecd|联合国|university|学报|期刊|journal/.test(m + l + t)) return 'academic';
  if (/新华|人民网|央视|reuters|bbc|路透|新闻|日报|nytimes|guardian|associated press/.test(m)) return 'news';
  return 'low'; // self-media, blogs, forums, "经验"/"文库"/SEO content, unknown sites
}

// Standalone Web Search API call — returns real, structured search hits
// (title/link/media/publish_date/content) directly, with no LLM involved.
// This is the ONLY source of truth for "real data with sources" — the chat
// model is never allowed to invent a citation; it can only reference what's
// actually in these results, because we hand it the results as explicit text.
// `timeoutMs` bounds the call so a slow/hanging search can't drag the whole
// request past the function's execution limit — on timeout we just return []
// and the chat call proceeds without search results (with an honest note).
// Tightened from 8s→6s so search+chat together stay well under Vercel's
// 30s function ceiling even with network variance (see handler below).
async function doWebSearch(query, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(ZHIPU_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + ZHIPU_API_KEY,
      },
      body: JSON.stringify({
        search_engine: 'search_pro',
        search_query: query,
        search_intent: true, // let Zhipu's own intent recognition refine vague queries instead of literal keyword matching
        count: 8, // ask for more than we need since low-quality hits get filtered out downstream
        search_recency_filter: 'noLimit',
        content_size: 'high'
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.error('[websearch] HTTP error', resp.status, await resp.text().then(t => t.slice(0,200)));
      return [];
    }
    const data = await resp.json();
    const hits = data.search_result || [];
    return hits.map(h => ({
      title: h.title || h.media || '',
      link: h.link || '',
      media: h.media || '',
      publish_date: h.publish_date || '',
      content: (h.content || '').slice(0, 500)
    }));
  } catch (e) {
    console.error('[websearch] fatal:', e.name === 'AbortError' ? 'timed out' : e.message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Build a real search query from conversation CONTEXT, not just the
// student's latest fragment. A student reply like "他更快速。更精准" carries
// no topic on its own — searching that literally returns unrelated garbage
// (this was the actual root cause of irrelevant/non-academic-looking results).
// We anchor on the first user message (the original topic) and combine it
// with the latest message, so short follow-ups still resolve to the real topic.
function buildSearchQuery(messages, lastUserIdx, module) {
  const clean = (s) => (typeof s === 'string' ? s : '').replace(/\[Image attached:[^\]]*\]\n?/g, '').replace(/\[SEARCH RESULTS\][\s\S]*?\[END SEARCH RESULTS\]\n?/g, '').trim();
  const firstUserMsg = messages.find(m => m.role === 'user');
  const topic = clean(firstUserMsg?.content).slice(0, 80);
  const latest = clean(messages[lastUserIdx]?.content).slice(0, 80);
  // Use topic alone once the conversation has moved past the opening message —
  // appending every short follow-up to the original topic was diluting the
  // query and was the main cause of irrelevant/SEO-farm results.
  let query = topic || latest;
  // Data-collection module needs rigorous/citable sources — nudge toward
  // official statistics and academic research specifically.
  if (module === 'data') query += ' 官方数据 统计 研究报告';
  return query.trim().slice(0, 150);
}

// Decide whether THIS turn should trigger a real search, per module:
// - data: search whenever webSearch is on — this module's whole purpose is
//   sourcing real data, so every turn benefits from fresh results.
// - discussion: search ON DEMAND only — when the student's own message
//   signals they want evidence/data ("数据","来源","证据","真的吗" etc.) or
//   when the AI's prior turn already promised to bring something in. This
//   keeps discussion fast or focused on the student's own reasoning by
//   default, only paying the search-latency cost when it adds real value.
// - tutoring/essay: never search (these never had it auto-on).
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

  // GLM-4V-Flash for images, GLM-4-Flash for text (both fast + free tier)
  const model = image ? 'glm-4v-flash' : 'glm-4-flash';
  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
  const lastUserText = (typeof messages[lastUserIdx]?.content === 'string' ? messages[lastUserIdx].content : '') || '';

  // ── Step 1: real search (only when this turn actually warrants it) ──
  // Search BEFORE building the prompt, so we know for certain whether real
  // results exist, and can tell the model honestly either way — instead of
  // offering a "tool" and hoping the model uses it correctly.
  let sources = [];
  let searchAttempted = false;
  if (!image && lastUserText.trim() && shouldSearchThisTurn(module, webSearch, lastUserText)) {
    searchAttempted = true;
    const query = buildSearchQuery(messages, lastUserIdx, module);
    const rawHits = await doWebSearch(query);
    // STRICT FILTERING for the data module — academic-grade only, low-quality
    // sources (self-media/blogs/forums/SEO farms) are dropped entirely, not
    // just labeled. The student should never see them as "data" at all.
    // Discussion module is more permissive (news allowed) since it's about
    // discussing perspectives, not citing rigorous data.
    sources = module === 'data'
      ? rawHits.filter(h => classifySource(h) === 'academic').slice(0, 5)
      : rawHits.filter(h => classifySource(h) !== 'low').slice(0, 5);
  }
  const realSearchHappened = sources.length > 0;

  const flatMsgs = messages.map((m, idx) => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = (typeof m.content === 'string' ? m.content : '')
      .replace(/\[Image attached:[^\]]*\]\n?/g, '').trim();

    if (idx === lastUserIdx && image) {
      // GLM-4V format: image_url with base64 data URL
      return {
        role,
        content: [
          { type: 'image_url', image_url: { url: image } },
          { type: 'text', text: text || '请仔细分析这张图片，读取并转录所有文字内容，包括手写文字。' }
        ]
      };
    }
    // Inject real (already-filtered) search results as an explicit, labeled
    // block right before the student's latest message — this is what the
    // system prompt's "[SEARCH RESULTS]" rule refers to. If we attempted a
    // search and found nothing usable, say so explicitly. If we didn't even
    // attempt a search this turn (discussion module, no trigger detected),
    // don't inject any search-related text at all — that's the normal,
    // fast path and shouldn't look like a failure.
    if (idx === lastUserIdx && searchAttempted) {
      const tagSource = (s) => {
        const cls = classifySource(s);
        if (cls === 'academic') return '[官方/学术来源]';
        if (cls === 'news') return '[新闻媒体]';
        return '[网络来源]';
      };
      const searchBlock = realSearchHappened
        ? '[SEARCH RESULTS]\n' + sources.map((s,i) =>
            `${i+1}. ${tagSource(s)} ${s.title} — ${s.media || ''} (${s.publish_date || 'date unknown'})\n${s.content}`
          ).join('\n\n') + '\n[END SEARCH RESULTS]\n\n'
        : '[SEARCH RESULTS]\n(No sufficiently reliable results found for this query — you must tell the student honestly that you could not verify current data from a reliable source, do NOT invent any, and do NOT present low-quality sources as if they were reliable.)\n[END SEARCH RESULTS]\n\n';
      return { role, content: searchBlock + (text || '...') };
    }
    return { role, content: text || '...' };
  });

  console.log(`[chat] model:${model} module:${module||'?'} msgs:${flatMsgs.length} image:${!!image} webSearchFlag:${!!webSearch} searchAttempted:${searchAttempted} realSearchHappened:${realSearchHappened} hits:${sources.length}`);

  // Timeout guard on the chat call too — if Zhipu hangs, fail fast with a
  // clear error instead of letting the whole serverless function time out
  // silently. Tightened from 20s→16s: search (≤6s) + chat (≤16s) = ≤22s,
  // leaving comfortable headroom under Vercel's 30s function ceiling even
  // with added network latency — the previous 8s+20s=28s budget left almost
  // no margin, which is what caused the generic "连接出现问题" failures.
  const chatController = new AbortController();
  const chatTimer = setTimeout(() => chatController.abort(), 16000);

  try {
    const resp = await fetch(ZHIPU_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + ZHIPU_API_KEY,
      },
      body: JSON.stringify({
        model,
        messages: flatMsgs,
        max_tokens: 700, // shorter cap nudges the model toward the "max 3-4 sentences" rule and speeds up responses
        temperature: 0.7,
        stream: false,
      }),
      signal: chatController.signal,
    });

    const respText = await resp.text();

    if (!resp.ok) {
      console.error(`[chat] Zhipu error ${resp.status}:`, respText.slice(0, 300));
      return res.status(resp.status).json({ error: respText.slice(0, 200) });
    }

    let data;
    try { data = JSON.parse(respText); }
    catch(e) { return res.status(500).json({ error: 'Invalid JSON from Zhipu' }); }

    const content = data.choices?.[0]?.message?.content || '';
    console.log(`[chat] reply:${content.length}chars`);

    return res.status(200).json({
      content,
      webSearchUsed: realSearchHappened,
      searchAttempted,
      sources: realSearchHappened ? sources.map(s => ({ title: s.title, link: s.link, media: s.media, publish_date: s.publish_date })) : []
    });

  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    console.error('[chat] fatal:', isTimeout ? 'timed out after 16s' : err.message);
    return res.status(isTimeout ? 504 : 500).json({ error: isTimeout ? 'Request timed out' : err.message });
  } finally {
    clearTimeout(chatTimer);
  }
}
