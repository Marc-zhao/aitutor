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

// Standalone Web Search API call — returns real, structured search hits
// (title/link/media/publish_date/content) directly, with no LLM involved.
// This is the ONLY source of truth for "real data with sources" — the chat
// model is never allowed to invent a citation; it can only reference what's
// actually in these results, because we hand it the results as explicit text.
async function doWebSearch(query) {
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
        count: 6,
        search_recency_filter: 'noLimit',
        content_size: 'high'
      }),
    });
    if (!resp.ok) {
      console.error('[websearch] HTTP error', resp.status, await resp.text().then(t => t.slice(0,200)));
      return [];
    }
    const data = await resp.json();
    const hits = data.search_result || [];
    return hits.slice(0, 6).map(h => ({
      title: h.title || h.media || '',
      link: h.link || '',
      media: h.media || '',
      publish_date: h.publish_date || '',
      content: (h.content || '').slice(0, 500)
    }));
  } catch (e) {
    console.error('[websearch] fatal:', e.message);
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body;
  const { messages, webSearch, image } = body || {};
  if (!messages) return res.status(400).json({ error: 'Missing messages' });

  // GLM-4V-Flash for images, GLM-4-Flash for text (both fast + free tier)
  const model = image ? 'glm-4v-flash' : 'glm-4-flash';
  const lastUserIdx = messages.map(m => m.role).lastIndexOf('user');
  const lastUserText = (typeof messages[lastUserIdx]?.content === 'string' ? messages[lastUserIdx].content : '') || '';

  // ── Step 1: real search (only for text-based, non-image turns) ──
  // Search BEFORE building the prompt, so we know for certain whether real
  // results exist, and can tell the model honestly either way — instead of
  // offering a "tool" and hoping the model uses it correctly.
  let sources = [];
  if (webSearch && !image && lastUserText.trim()) {
    sources = await doWebSearch(lastUserText.replace(/\[Image attached:[^\]]*\]\n?/g, '').trim().slice(0, 200));
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
    // Inject real search results as an explicit, labeled block right before
    // the student's latest message — this is what the system prompt's
    // "[SEARCH RESULTS]" rule refers to. If search ran but found nothing,
    // we say so explicitly too, so the model can't pretend it doesn't know.
    if (idx === lastUserIdx && webSearch && !image) {
      const searchBlock = realSearchHappened
        ? '[SEARCH RESULTS]\n' + sources.map((s,i) =>
            `${i+1}. ${s.title} — ${s.media || ''} (${s.publish_date || 'date unknown'})\n${s.content}`
          ).join('\n\n') + '\n[END SEARCH RESULTS]\n\n'
        : '[SEARCH RESULTS]\n(No results found for this query — you must tell the student honestly that you could not verify current data, do NOT invent any.)\n[END SEARCH RESULTS]\n\n';
      return { role, content: searchBlock + (text || '...') };
    }
    return { role, content: text || '...' };
  });

  console.log(`[chat] model:${model} msgs:${flatMsgs.length} image:${!!image} webSearchRequested:${!!webSearch} realSearchHappened:${realSearchHappened} hits:${sources.length}`);

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
        max_tokens: 1024,
        temperature: 0.7,
        stream: false,
      }),
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
      sources: realSearchHappened ? sources.map(s => ({ title: s.title, link: s.link, media: s.media, publish_date: s.publish_date })) : []
    });

  } catch (err) {
    console.error('[chat] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
