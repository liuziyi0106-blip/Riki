// Netlify Function
// 负责在服务器端调用 Google Gemini API（免费额度），API Key 只存在于服务器环境变量中，
// 浏览器前端永远不会接触到真实的 Key。

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('缺少 GEMINI_API_KEY 环境变量');
    return { statusCode: 500, body: JSON.stringify({ error: '服务器未配置 GEMINI_API_KEY，请在 Netlify 项目环境变量中设置' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    console.error('请求体解析失败:', event.body);
    return { statusCode: 400, body: JSON.stringify({ error: '请求格式错误' }) };
  }

  const { brief, platform, market, marketLang, contentType } = payload;
  if (!brief || !platform || !market || !contentType) {
    console.error('缺少参数:', payload);
    return { statusCode: 400, body: JSON.stringify({ error: '缺少必要参数（brief / platform / market / contentType）' }) };
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
    console.log('调用 Gemini API，apiKey 前6位:', apiKey.slice(0, 6));

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 1000,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    const data = await response.json();
    console.log('Gemini 响应状态:', response.status);
    console.log('Gemini 响应内容(前500字):', JSON.stringify(data).slice(0, 500));

    if (!response.ok) {
      console.error('Gemini API 报错:', JSON.stringify(data));
      return { statusCode: response.status, body: JSON.stringify({ error: data?.error?.message || '调用 Gemini API 失败' }) };
    }

    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log('提取的原始文本(前300字):', raw.slice(0, 300));

    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error('JSON 解析失败，原始内容:', cleaned);
      return { statusCode: 502, body: JSON.stringify({ error: 'AI 返回内容解析失败，请重试' }) };
    }

    return { statusCode: 200, body: JSON.stringify(parsed) };
  } catch (err) {
    console.error('函数执行异常:', err.message, err.stack);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || '服务器内部错误' }) };
  }
};
