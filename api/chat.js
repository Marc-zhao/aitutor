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
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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
    return { role, content: text || '...' };
  });

  // Real web search via Zhipu's native web_search tool (NOT supported on
  // glm-4v-flash — only plain text models). Returns actual current search
  // results fused into the model's answer with sources, instead of the
  // model guessing from training data.
  const tools = (webSearch && !image) ? [{
    type: 'web_search',
    web_search: {
      enable: 'True',
      search_engine: 'search_pro',
      search_result: 'True',
      count: '6',
      search_recency_filter: 'noLimit',
      content_size: 'high'
    }
  }] : undefined;

  console.log(`[chat] model:${model} msgs:${flatMsgs.length} image:${!!image} webSearch:${!!tools}`);

  try {
    const resp = await fetch(ZHIPU_URL, {
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
        ...(tools ? { tools } : {})
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

    return res.status(200).json({ content, webSearchUsed: !!tools });

  } catch (err) {
    console.error('[chat] fatal:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
