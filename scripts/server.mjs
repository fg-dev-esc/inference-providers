import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { neon } from '@neondatabase/serverless';

loadEnv('.env.local');

const port = process.env.PORT || 3000;
const sql = neon(process.env.DATABASE_URL);

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

createServer(async (req, res) => {
  try {
    if (req.url === '/api/chat') return handleChat(req, res);
    if (req.url === '/api/conversations') return handleConversations(req, res);
    serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: error.message });
  }
}).listen(port, () => {
  console.log(`Local: http://localhost:${port}`);
});

async function handleChat(req, res) {
  const { provider, model, messages, images = [] } = await readJson(req);
  const limitedImages = images.slice(0, MAX_IMAGES);
  const cleanMessages = messages.map(({ role, content }) => ({ role, content }));
  const imageContext = limitedImages.length ? await parseImages(cleanMessages, limitedImages) : '';
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
    headers['HTTP-Referer'] = `http://localhost:${port}`;
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
    return json(res, response.status, {
      error: data?.error?.message || data?.message || `HTTP ${response.status}`,
    });
  }

  const choice = data.choices?.[0];
  json(res, 200, { content: choice?.message?.content || choice?.text || '' });
}

async function parseImages(messages, images) {
  const lastUserText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${API_KEYS[IMAGE_PARSER_PROVIDER]}`,
  };

  if (IMAGE_PARSER_PROVIDER === 'openrouter') {
    headers['HTTP-Referer'] = `http://localhost:${port}`;
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
          { type: 'text', text: `Extrae el contexto visual relevante para responder esta pregunta:\n${lastUserText}` },
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

async function handleConversations(req, res) {
  if (req.method === 'GET') {
    const rows = await sql`
      SELECT * FROM public.conversations
      ORDER BY updated_at DESC
      LIMIT 100
    `;

    return json(res, 200, {
      conversations: rows.map((r) => ({
        id: r.id,
        title: r.title,
        messages: typeof r.messages === 'string' ? JSON.parse(r.messages) : r.messages || [],
        created_at: r.created_at,
        updated_at: r.updated_at,
      })),
    });
  }

  const conv = await readJson(req);

  if (req.method === 'DELETE') {
    await sql`DELETE FROM public.conversations WHERE id = ${conv.id}`;
    return json(res, 200, { ok: true });
  }

  await sql`
    INSERT INTO public.conversations (id, title, messages, created_at, updated_at)
    VALUES (${conv.id}, ${conv.title}, ${JSON.stringify(conv.messages)}, ${conv.created_at}, ${conv.updated_at})
    ON CONFLICT (id) DO UPDATE SET
      title = ${conv.title},
      messages = ${JSON.stringify(conv.messages)},
      updated_at = ${conv.updated_at}
  `;

  json(res, 200, { ok: true });
}

function serveStatic(req, res) {
  const url = req.url === '/' ? '/index.html' : req.url;
  const file = join(process.cwd(), decodeURIComponent(url.split('?')[0]));

  if (!existsSync(file)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const type = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
  }[extname(file)] || 'application/octet-stream';

  res.writeHead(200, { 'Content-Type': type });
  res.end(readFileSync(file));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => resolve(body ? JSON.parse(body) : {}));
    req.on('error', reject);
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function loadEnv(file) {
  if (!existsSync(file)) return;

  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}
