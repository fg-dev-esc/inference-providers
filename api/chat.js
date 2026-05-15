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

export default async function handler(req, res) {
  const { provider, model, messages } = req.body;

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
      messages: messages.map(({ role, content }) => ({ role, content })),
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
