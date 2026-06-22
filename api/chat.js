// 智谱清言 (Zhipu AI) — GLM-4V-Flash 图片理解 + GLM-4-Flash 文字对话
// 速度快，国内直连，免费额度大

export const config = { runtime: 'edge' };

const ZHIPU_API_KEY = 'e3dde6a442de4bb391893f85e2f4d9c2.UwUGULxW14eJ72I2';
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let body;
  try { body = await req.json(); }
  catch(e) { return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: CORS }); }

  const { messages, webSearch, image } = body;
  if (!messages) return new Response(JSON.stringify({ error: 'Missing messages' }), { status: 400, headers: CORS });

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

  if (webSearch) {
    const si = flatMsgs.findIndex(m => m.role === 'system');
    if (si >= 0) flatMsgs[si].content += '\n\n[WEB SEARCH MODE: Provide real statistics with source names and years.]';
  }

  console.log(`[chat] model:${model} msgs:${flatMsgs.length} image:${!!image}`);

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
        max_tokens: 1200,
        temperature: 0.7,
        stream: false,
      }),
    });

    const respText = await resp.text();

    if (!resp.ok) {
      console.error(`[chat] Zhipu error ${resp.status}:`, respText.slice(0, 300));
      return new Response(JSON.stringify({ error: respText.slice(0, 200) }), {
        status: resp.status, headers: { ...CORS, 'Content-Type': 'application/json' }
      });
    }

    let data;
    try { data = JSON.parse(respText); }
    catch(e) { return new Response(JSON.stringify({ error: 'Invalid JSON from Zhipu' }), { status: 500, headers: CORS }); }

    const content = data.choices?.[0]?.message?.content || '';
    console.log(`[chat] reply:${content.length}chars`);

    return new Response(JSON.stringify({ content, webSearchUsed: !!webSearch }), {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('[chat] fatal:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: CORS });
  }
}
