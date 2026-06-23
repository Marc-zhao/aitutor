// 智谱清言 (Zhipu AI) — GLM-4V-Flash 图片理解 + GLM-4-Flash 文字对话
//
// NOTE: This runs on the Node.js serverless runtime (NOT Edge).
// IMPORTANT — Vercel Hobby (free) plan caps every serverless function at
// 10 SECONDS, not 30/60 as earlier comments assumed. That 10s ceiling is
// the actual root cause of the "连接出现问题" / timeout failures students
// hit when web search was on — search (≤6-8s) + chat generation (≤16-20s)
// together routinely exceeded even a generous 30s budget, let alone 10s.
//
// FIX: this endpoint no longer does its own search. Search now lives in
// /api/search.js as a separate call. The frontend calls /api/search first
// (fast, ≤8s), then calls THIS endpoint with the search results already
// attached in `searchResults` — so this function only ever does ONE network
// call (the Zhipu chat completion) and comfortably fits in 10s.

const ZHIPU_API_KEY = 'e3dde6a442de4bb391893f85e2f4d9c2.UwUGULxW14eJ72I2';
const ZHIPU_CHAT_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Builds the [SEARCH RESULTS] text block injected before the student's
// latest message. Handles three distinct source shapes:
// - OpenAlex works (sourceType==='openalex'): real journal papers with
//   authors/year/venue/abstract — the actual target tier for the data
//   module. Switched from Semantic Scholar due to its frequent rate-limiting.
// - Zhipu web hits tagged 'official' tier (government/international-body
//   statistics — NOT a journal, must be disclosed as a lower tier).
// - Zhipu web hits for the discussion module (journal/official/news mix,
//   already pre-filtered to exclude low-quality sources).
function buildSearchBlock(searchResults) {
  const { searchAttempted, sourceType, sourceTier, sources: allSources } = searchResults || {};
  if (!searchAttempted) return ''; // this turn didn't search at all — inject nothing, that's the normal fast path
  // Cap to 3 sources max — the model only ever cites 1-2 in a short reply,
  // and a smaller prompt measurably speeds up generation start time, which
  // was a contributing factor in the 9s chat-generation timeouts.
  const sources = (allSources || []).slice(0, 3);
  if (!sources || sources.length === 0) {
    return '[SEARCH RESULTS]\n(No sufficiently reliable results found for this query — you must tell the student honestly that you could not verify current data from a reliable source, do NOT invent any, and do NOT present low-quality sources as if they were reliable.)\n[END SEARCH RESULTS]\n\n';
  }

  if (sourceType === 'openalex') {
    const items = sources.map((p, i) => {
      const authorStr = (p.authors || []).join(', ') || 'Unknown author';
      const year = p.year || 'n.d.';
      // Trim the abstract further (600→280 chars) — long abstracts inflate
      // the prompt enough to measurably slow down generation start time,
      // and this was a contributing factor in the 9s chat-generation timeouts.
      const shortAbstract = (p.abstract || '').slice(0, 280);
      return `${i + 1}. [JOURNAL/ACADEMIC DATABASE — OpenAlex] "${p.title}" by ${authorStr} (${year})${p.venue ? ', published in ' + p.venue : ''}.\nURL: ${p.url || 'not available'}${p.doi ? ' | DOI: ' + p.doi : ''}\nAbstract: ${shortAbstract}`;
    }).join('\n\n');
    return `[SEARCH RESULTS]\n${items}\n[END SEARCH RESULTS]\n\n`;
  }

  // Zhipu web hits (official-tier for data module, or mixed tier for discussion)
  const tagSource = (cls) => {
    if (cls === 'journal') return '[JOURNAL/ACADEMIC DATABASE]';
    if (cls === 'official') return '[OFFICIAL STATISTICS/GOVERNMENT BODY — NOT a peer-reviewed journal]';
    if (cls === 'news') return '[NEWS MEDIA]';
    return '[WEB SOURCE]';
  };
  const tierNote = sourceTier === 'official'
    ? 'NOTE: No peer-reviewed journal source was found for this query — these are official statistics/government sources instead, which is a DIFFERENT and lower tier than a journal article. You MUST tell the student explicitly that no journal-level source was found and these are official statistics instead, not academic papers. Do NOT call these "学术来源" or imply they are journal articles.\n\n'
    : '';
  // Same trim for Zhipu hits' content field (500→280 chars).
  const items = sources.map((s, i) =>
    `${i + 1}. ${tagSource(s._cls || (sourceTier === 'official' ? 'official' : null))} ${s.title} — ${s.media || ''} (${s.publish_date || 'date unknown'})\n${(s.content || '').slice(0, 280)}`
  ).join('\n\n');
  return `[SEARCH RESULTS]\n${tierNote}${items}\n[END SEARCH RESULTS]\n\n`;
}

// Builds the [EVIDENCE LOG] block for Stage③ (framework building) — lists
// every real source the student has gathered so far in Stage② (evidence
// verification) across this conversation, so the model can help organize
// an argument from them WITHOUT re-searching. Capped at 5 entries and a
// short excerpt each — this is a reference list for organizing, not a
// place to re-paste full abstracts (keeps the prompt size controlled,
// same reasoning as the SEARCH RESULTS trimming above).
function buildEvidenceLogBlock(evidenceLog) {
  if (!Array.isArray(evidenceLog) || evidenceLog.length === 0) return '';
  const entries = evidenceLog.slice(0, 5).map((s, i) => {
    const authorStr = Array.isArray(s.authors) ? s.authors.join(', ') : (s.media || s.venue || 'Unknown');
    const year = s.year || s.publish_date || 'n.d.';
    const title = s.title || '';
    const excerpt = (s.abstract || s.content || '').slice(0, 150);
    return `${i + 1}. ${title} — ${authorStr} (${year})${excerpt ? '\n   ' + excerpt : ''}`;
  }).join('\n\n');
  return `[EVIDENCE LOG — sources the student has already gathered, use ONLY these, do not invent new ones or re-search]\n${entries}\n[END EVIDENCE LOG]\n\n`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;
  const { messages, image, searchResults, evidenceLog } = body || {};
  if (!messages) return res.status(400).json({ error: 'Missing messages' });

  // Switched from glm-4-flash (free tier, 5 QPS cap) to glm-4-air (paid,
  // pay-per-token, 10-50 QPS depending on tier). Production logs showed
  // glm-4-flash timing out even on small ~2000-char prompts during busy
  // periods — the free tier's lower concurrency ceiling makes it more
  // prone to queuing delays under any real-world load. glm-4-air costs a
  // few yuan per million tokens, which is negligible at this app's volume.
  // Image understanding (glm-4v-flash) is untouched — no evidence it has
  // the same timeout issue, and it's a different model/use case.
  const model = image ? 'glm-4v-flash' : 'glm-4-air';
  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');

  const flatMsgs = messages.map((m, idx) => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = (typeof m.content === 'string' ? m.content : '')
      .replace(/\[Image attached:[^\]]*\]\n?/g, '').trim();

    if (idx === lastUserIdx && image) {
      return {
        role,
        content: [
          { type: 'image_url', image_url: { url: image } },
          { type: 'text', text: text || '请仔细分析这张图片，读取并转录所有文字内容，包括手写文字。' }
        ]
      };
    }
    if (idx === lastUserIdx && searchResults) {
      const searchBlock = buildSearchBlock(searchResults);
      return { role, content: searchBlock + (text || '...') };
    }
    if (idx === lastUserIdx && evidenceLog) {
      const evidenceBlock = buildEvidenceLogBlock(evidenceLog);
      return { role, content: evidenceBlock + (text || '...') };
    }
    return { role, content: text || '...' };
  });

  const realSearchHappened = !!(searchResults?.searchAttempted && searchResults?.sources?.length > 0);
  const handlerStart = Date.now();
  console.log(`[chat] model:${model} msgs:${flatMsgs.length} image:${!!image} searchAttempted:${!!searchResults?.searchAttempted} realSearchHappened:${realSearchHappened} promptChars:${flatMsgs.reduce((a,m)=>a+(typeof m.content==='string'?m.content.length:0),0)}`);

  // 9s timeout — this endpoint now does exactly ONE network call (Zhipu chat
  // completion), so 9s leaves a safe margin under Vercel Hobby's 10s ceiling
  // while still giving the model enough time to generate a full response.
  const chatController = new AbortController();
  const chatTimer = setTimeout(() => chatController.abort(), 9000);

  try {
    console.log(`[chat] about to call Zhipu, +${Date.now()-handlerStart}ms since handler start`);
    const resp = await fetch(ZHIPU_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + ZHIPU_API_KEY,
      },
      body: JSON.stringify({
        model,
        messages: flatMsgs,
        max_tokens: 500, // reduced from 600 — paired with the smaller search-result block, this keeps generation comfortably inside the 9s budget while still allowing a complete APA7 citation
        temperature: 0.7,
        stream: false,
      }),
      signal: chatController.signal,
    });
    console.log(`[chat] Zhipu fetch() resolved, +${Date.now()-handlerStart}ms since handler start, status:${resp.status}`);

    const respText = await resp.text();
    console.log(`[chat] response body read, +${Date.now()-handlerStart}ms since handler start`);

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
      searchAttempted: !!searchResults?.searchAttempted,
      sources: realSearchHappened ? (searchResults.sources || []).map(s => ({
        title: s.title, link: s.link || s.url, media: s.media || s.venue, publish_date: s.publish_date || s.year
      })) : []
    });

  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    console.error(`[chat] fatal: ${isTimeout ? 'timed out after 9s' : err.message}, +${Date.now()-handlerStart}ms since handler start`);
    return res.status(isTimeout ? 504 : 500).json({ error: isTimeout ? 'Request timed out' : err.message });
  } finally {
    clearTimeout(chatTimer);
  }
}
