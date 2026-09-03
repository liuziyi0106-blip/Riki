// Netlify Function
// 负责在服务器端调用 Google Gemini API（免费额度），API Key 只存在于服务器环境变量中，
// 浏览器前端永远不会接触到真实的 Key。
// 加了自动重试 + 备用模型，遇到临时繁忙(503)会自动切换，提高面试/演示时的稳定性。

const PRIMARY_MODEL = 'gemini-2.5-flash-lite';
const FALLBACK_MODEL = 'gemini-3.5-flash-lite';

async function callGemini(apiKey, model, systemPrompt, userPrompt) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
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
          maxOutputTokens: 3000,
          responseMimeType: 'application/json'
        }
      })
    }
  );
  const data = await response.json();
  return { ok: response.ok, status: response.status, data };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
    return { statusCode: 400, body: JSON.stringify({ error: '请求格式错误' }) };
  }

  const { brief, platform, market, marketLang, contentType } = payload;
  if (!brief || !platform || !market || !contentType) {
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

  // 尝试顺序：主模型 -> 主模型重试一次(等2秒) -> 备用模型 -> 备用模型重试一次(等2秒)
  const attempts = [
    { model: PRIMARY_MODEL, delay: 0 },
    { model: PRIMARY_MODEL, delay: 2000 },
    { model: FALLBACK_MODEL, delay: 0 },
    { model: FALLBACK_MODEL, delay: 2000 },
  ];

  let lastError = null;

  for (const attempt of attempts) {
    if (attempt.delay) await sleep(attempt.delay);
    try {
      console.log(`尝试调用模型: ${attempt.model}`);
      const result = await callGemini(apiKey, attempt.model, systemPrompt, userPrompt);

      if (!result.ok) {
        console.error(`模型 ${attempt.model} 报错:`, JSON.stringify(result.data).slice(0, 300));
        lastError = result.data?.error?.message || `模型 ${attempt.model} 调用失败`;
        // 503/429 这类临时性错误才继续重试，其他错误(比如key无效)直接停止
        const code = result.data?.error?.code;
        if (code !== 503 && code !== 429) break;
        continue;
      }

      const raw = result.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/```\s*$/, '').trim();

      let parsed;
      try {
        parsed = JSON.parse(cleaned);
      } catch (e) {
        console.error('JSON 解析失败，原始内容:', cleaned.slice(0, 300));
        lastError = 'AI 返回内容解析失败';
        continue;
      }

      console.log(`成功，使用模型: ${attempt.model}`);
      return { statusCode: 200, body: JSON.stringify(parsed) };
    } catch (err) {
      console.error('调用异常:', err.message);
      lastError = err.message;
    }
  }

  return { statusCode: 502, body: JSON.stringify({ error: lastError || '多次重试后仍然失败，请稍后再试' }) };
};
