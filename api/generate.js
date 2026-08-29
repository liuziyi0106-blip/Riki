// Vercel Serverless Function
// 负责在服务器端调用 Google Gemini API（免费额度），API Key 只存在于服务器环境变量中，
// 浏览器前端永远不会接触到真实的 Key。

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: '服务器未配置 GEMINI_API_KEY，请在 Vercel 项目环境变量中设置' });
    return;
  }

  const { brief, platform, market, marketLang, contentType } = req.body || {};
  if (!brief || !platform || !market || !contentType) {
    res.status(400).json({ error: '缺少必要参数（brief / platform / market / contentType）' });
    return;
  }

  const systemPrompt = `你是一名资深的跨境出海营销文案专家，擅长为中国品牌撰写精准适配目标市场文化语境与平台调性的营销内容。
只返回合法的 JSON，不要使用 markdown 代码块，不要任何前后说明文字。
JSON 结构如下：
{
  "content": "用目标市场本地语言撰写的完整营销内容正文",
  "content_zh": "对应的准确中文翻译，供内部审阅",
  "hashtags": ["与平台相关的标签，如不适用则为空数组"],
  "notes_zh": "1-2句中文说明，解释本次内容在文化/平台层面做了哪些本地化处理",
  "language": "目标市场使用的语言名称"
}`;

  const userPrompt = `Campaign Brief:
${brief}

平台 (Platform): ${platform}
目标市场 (Target Market): ${market} — 目标语言: ${marketLang || ''}
内容类型 (Content Type): ${contentType}

请基于以上信息生成内容。`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: systemPrompt }]
          },
          contents: [
            { role: 'user', parts: [{ text: userPrompt }] }
          ],
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 1000,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      res.status(response.status).json({ error: data?.error?.message || '调用 Gemini API 失败' });
      return;
    }

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    let cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      res.status(502).json({ error: 'AI 返回内容解析失败，请重试' });
      return;
    }

    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: err.message || '服务器内部错误' });
  }
}
