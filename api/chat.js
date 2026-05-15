const ENDPOINTS = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
  sambanova: 'https://api.sambanova.ai/v1/chat/completions',
  cohere: 'https://api.cohere.com/compatibility/v1/chat/completions',
  cerebras: 'https://api.cerebras.ai/v1/chat/completions',
};

const API_KEYS = {
  groq: process.env.GROQ_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
  google: process.env.GOOGLE_API_KEY,
  mistral: process.env.MISTRAL_API_KEY,
  sambanova: process.env.SAMBANOVA_API_KEY,
  cohere: process.env.COHERE_API_KEY,
  cerebras: process.env.CEREBRAS_API_KEY,
};

const IMAGE_PARSER_PROVIDER = 'groq';
const IMAGE_PARSER_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const MAX_IMAGES = 5;

export default async function handler(req, res) {
  const { provider, model, messages, images = [] } = req.body;
  const limitedImages = images.slice(0, MAX_IMAGES);
  const cleanMessages = messages.map(({ role, content }) => ({ role, content }));
  const imageContext = limitedImages.length ? await parseImages(cleanMessages, limitedImages, req.headers.origin || '') : '';
  const finalMessages = imageContext
    ? [
        ...cleanMessages.slice(0, -1),
        {
          role: 'user',
          content: `${cleanMessages.at(-1)?.content || ''}\n\nContexto visual extraído previamente por ${IMAGE_PARSER_MODEL}:\n${imageContext}`,
        },
      ]
    : cleanMessages;

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEYS[provider]}`,
  };

  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = req.headers.origin || '';
    headers['X-Title'] = 'Inferencia';
  }

  const response = await fetch(ENDPOINTS[provider], {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: finalMessages,
      stream: false,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    return res.status(response.status).json({
      error: data?.error?.message || data?.message || `HTTP ${response.status}`,
    });
  }

  const choice = data.choices?.[0];

  res.status(200).json({
    content: choice?.message?.content || choice?.text || '',
  });
}

async function parseImages(messages, images, origin) {
  const lastUserText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEYS[IMAGE_PARSER_PROVIDER]}`,
  };

  if (IMAGE_PARSER_PROVIDER === 'openrouter') {
    headers['HTTP-Referer'] = origin;
    headers['X-Title'] = 'Inferencia';
  }

  const response = await fetch(ENDPOINTS[IMAGE_PARSER_PROVIDER], {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: IMAGE_PARSER_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: lastUserText },
          ...images.map((image) => ({ type: 'image_url', image_url: { url: image } })),
        ],
      }],
      stream: false,
    }),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || data?.message || `Vision HTTP ${response.status}`);
  return data.choices?.[0]?.message?.content || '';
}
