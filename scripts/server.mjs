import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { neon } from '@neondatabase/serverless';

loadEnv('.env.local');

const port = process.env.PORT || 3000;
let sql;

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

const AETHRA_MODELS = [
  { provider: 'mistral', model: 'mistral-large-latest', label: 'Mistral Large 3' },
  { provider: 'groq', model: 'qwen/qwen3.6-27b', label: 'Qwen 3.6 27B' },
  { provider: 'google', model: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
];
const AETHRA_INTEGRATOR = { provider: 'cerebras', model: 'gpt-oss-120b', label: 'GPT OSS 120B' };

if (isMainModule()) startServer();

function startServer() {
  createServer(async (req, res) => {
    try {
      if (req.url === '/api/chat') return await handleChat(req, res);
      if (req.url === '/api/conversations') return await handleConversations(req, res);
      serveStatic(req, res);
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  }).listen(port, () => {
    console.log(`Local: http://localhost:${port}`);
  });
}

export async function handleChat(req, res) {
  const { provider, model, messages, images = [], thinking = false } = await readJson(req);
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

  const content = thinking
    ? await runThinkingPipeline({ provider, model, messages: finalMessages })
    : await callChatCompletion(provider, model, finalMessages);

  json(res, 200, { content });
}

async function callChatCompletion(provider, model, messages, { aethra = false } = {}) {
  if (!ENDPOINTS[provider]) throw new Error(`Proveedor no soportado: ${provider}`);
  if (!API_KEYS[provider]) throw new Error(`Falta API key para ${provider}`);

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${API_KEYS[provider]}`,
  };

  if (provider === 'openrouter') {
    headers['HTTP-Referer'] = `http://localhost:${port}`;
    headers['X-Title'] = 'Inferencia';
  }

  const body = {
    model,
    messages,
    stream: false,
  };

  if (provider === 'cerebras') {
    body.max_completion_tokens = 65536;
    body.temperature = 1;
    body.top_p = 1;
    body.reasoning_effort = 'high';
  }

  if (provider === 'groq') {
    body.temperature = 1;
    body.max_completion_tokens = safeGroqMaxCompletionTokens(model);
  }

  const isAethraQwen = aethra && provider === 'groq' && model === 'qwen/qwen3.6-27b';
  if (isAethraQwen) {
    body.max_completion_tokens = 4096;
    body.top_p = 0.95;
    body.reasoning_effort = 'none';
    body.stream = true;
  }

  if (provider === 'mistral' || provider === 'sambanova') {
    body.temperature = 1;
    body.max_completion_tokens = 8192;
  }

  const response = await fetch(ENDPOINTS[provider], {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  if (body.stream && response.ok) return parseStreamContent(raw);

  let data = {};

  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error(`${provider}/${model} devolvio una respuesta no JSON`);
    }
  }

  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `${provider}/${model} HTTP ${response.status}`);
  }

  const choice = data.choices?.[0];
  return choice?.message?.content || choice?.text || '';
}

function parseStreamContent(raw) {
  let content = '';

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === '[DONE]') continue;

    try {
      const chunk = JSON.parse(payload);
      content += chunk.choices?.[0]?.delta?.content || '';
    } catch {
      // Ignore keep-alive and malformed stream events.
    }
  }

  return content;
}

function safeGroqMaxCompletionTokens(model) {
  if (model === 'qwen/qwen3-32b') return 2048;
  if (model === 'qwen/qwen3.6-27b') return 2048;
  return 4096;
}

async function parseImages(messages, images) {
  const lastUserText = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  return callChatCompletion(IMAGE_PARSER_PROVIDER, IMAGE_PARSER_MODEL, [{
    role: 'user',
    content: [
      { type: 'text', text: lastUserText },
      ...images.map((image) => ({ type: 'image_url', image_url: { url: image } })),
    ],
  }]);
}

async function runThinkingPipeline({ messages }) {
  const originalQuestion = [...messages].reverse().find((message) => message.role === 'user')?.content || '';

  const modelResponses = await Promise.all(AETHRA_MODELS.map(async (model) => {
    try {
      const content = await callChatCompletion(model.provider, model.model, messages, { aethra: true });
      const { reasoning, text } = extractThinkTags(content);
      return {
        ok: true,
        model,
        response: text,
        reasoning,
      };
    } catch (error) {
      return {
        ok: false,
        model,
        response: `Error: ${error.message}`,
        reasoning: '',
      };
    }
  }));

  const concatenatedResponses = modelResponses
    .map(({ model, response }) => `### ${model.label}\n${response}`)
    .join('\n\n---\n\n');

  const integrated = await callChatCompletion(
    AETHRA_INTEGRATOR.provider,
    AETHRA_INTEGRATOR.model,
    [
      {
        role: 'system',
        content:
          'Eres un asistente experto en sintetizar y consolidar informacion de multiples modelos. Tu tarea es analizar profundamente cada respuesta, identificar patrones, similitudes, diferencias, errores y omisiones. Integra lo mejor de todas las respuestas en una respuesta final extensa, clara, precisa, accionable y completa. No reduzcas ni simplifiques en exceso.',
      },
      {
        role: 'user',
        content: `Pregunta original del usuario: "${originalQuestion}"\n\n===== RESPUESTAS DE MULTIPLES MODELOS =====\n\n${concatenatedResponses}\n\n===== TU TAREA =====\n\nGenera un mega-resumen consolidado que:\n- Integre toda la informacion util\n- Profundice en cada punto relevante\n- Identifique insights unicos de cada modelo\n- Corrija contradicciones o errores\n- Entregue una respuesta final completa y accionable`,
      },
    ],
  );

  const { reasoning, text } = extractThinkTags(integrated);
  const individualSections = modelResponses
    .map(({ model, response }) => `## ${model.label}\n\n${response}`)
    .join('\n\n---\n\n');

  return `${individualSections}\n\n---\n\n# Aethra\n\n${reasoning ? `<think>${reasoning}</think>\n\n` : ''}${text}`.trim();
}

function extractThinkTags(content) {
  const value = decodeMaybeJsonString(content);
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  const matches = value.match(thinkRegex);
  if (!matches) return { reasoning: '', text: value };

  const reasoning = matches
    .map((match) => match.replace(/<\/?think>/gi, '').trim())
    .join('\n\n');
  const text = value.replace(thinkRegex, '').trim();

  return { reasoning, text };
}

function stripThinking(content) {
  const value = decodeMaybeJsonString(content);
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/\\n?<think>[\s\S]*?\\n?<\\\/think>/gi, '')
    .replace(/^\s*Here's a thinking process:\s*[\s\S]*?(?=\n\S|$)/i, '')
    .trim();
}

function decodeMaybeJsonString(content) {
  const value = String(content || '').trim();
  if (!value.startsWith('"') || !value.endsWith('"')) return value;

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : value;
  } catch {
    return value;
  }
}

function parseHarnessJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;

    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function validateExtraction(payload, extractor, index, raw) {
  const source = isObject(payload) ? payload : {};
  const fallbackEvidence = raw
    ? [{ id: `ev_${index + 1}_001`, type: 'unknown', content: `Salida no valida del extractor: ${truncate(raw, HARNESS_LIMITS.text)}`, source: 'inference', confidence: 'low', relevance: 'low', should_preserve: false }]
    : [];

  return {
    schema_version: '1.0',
    stage: 'evidence_extraction',
    extractor: {
      provider: extractor.provider,
      model: extractor.model,
      label: extractor.label,
    },
    user_intent: {
      primary_goal: text(source.user_intent?.primary_goal, HARNESS_LIMITS.shortText),
      task_type: enumValue(source.user_intent?.task_type, TASK_TYPES, 'unknown'),
      domain: text(source.user_intent?.domain, HARNESS_LIMITS.shortText),
      explicit_requirements: stringList(source.user_intent?.explicit_requirements),
      implicit_requirements: stringList(source.user_intent?.implicit_requirements),
      constraints: stringList(source.user_intent?.constraints),
      success_criteria: stringList(source.user_intent?.success_criteria),
    },
    evidence_items: evidenceItems(source.evidence_items, index, fallbackEvidence),
    risks: stringList(source.risks),
    counterarguments: stringList(source.counterarguments),
    unknowns: stringList(source.unknowns),
    recommended_next_steps: stringList(source.recommended_next_steps),
    do_not_do: stringList(source.do_not_do),
  };
}

function validateIntegration(payload, raw) {
  const source = isObject(payload) ? payload : {};
  return {
    schema_version: '1.0',
    stage: 'evidence_integration',
    normalized_request: text(source.normalized_request || raw, HARNESS_LIMITS.text),
    task_classification: {
      type: enumValue(source.task_classification?.type, TASK_TYPES, 'unknown'),
      complexity: enumValue(source.task_classification?.complexity, COMPLEXITY_LEVELS, 'medium'),
      requires_code: booleanValue(source.task_classification?.requires_code),
      requires_architecture: booleanValue(source.task_classification?.requires_architecture),
      requires_validation: source.task_classification?.requires_validation !== false,
    },
    task_diagnostics: {
      scenario: text(source.task_diagnostics?.scenario, HARNESS_LIMITS.shortText),
      capabilities: stringList(source.task_diagnostics?.capabilities),
      modality: enumValue(source.task_diagnostics?.modality, MODALITIES, 'unknown'),
      environment: enumValue(source.task_diagnostics?.environment, ENVIRONMENTS, 'unknown'),
    },
    merged_requirements: stringList(source.merged_requirements),
    technical_constraints: stringList(source.technical_constraints),
    user_preferences: stringList(source.user_preferences),
    success_criteria: stringList(source.success_criteria),
    support_map: supportMap(source.support_map),
    verification_plan: stringList(source.verification_plan),
    safety_checks: stringList(source.safety_checks),
    high_confidence_facts: stringList(source.high_confidence_facts),
    low_confidence_items: stringList(source.low_confidence_items),
    consensus: stringList(source.consensus),
    contradictions: stringList(source.contradictions),
    open_questions: stringList(source.open_questions),
    risks: stringList(source.risks),
    answer_strategy: {
      recommended_structure: stringList(source.answer_strategy?.recommended_structure),
      must_include: stringList(source.answer_strategy?.must_include),
      must_avoid: stringList(source.answer_strategy?.must_avoid),
      tone: enumValue(source.answer_strategy?.tone, TONES, 'direct'),
    },
  };
}

function validateCritique(payload, raw) {
  const source = isObject(payload) ? payload : {};
  const fallbackIssue = raw && !isObject(payload)
    ? [{ severity: 'medium', issue: `Critica no valida: ${truncate(raw, HARNESS_LIMITS.shortText)}`, evidence_reference: 'critic_output', fix: 'Usar el borrador y el brief integrado sin aplicar cambios especulativos.' }]
    : [];

  return {
    schema_version: '1.0',
    stage: 'critique',
    verdict: enumValue(source.verdict, CRITIC_VERDICTS, fallbackIssue.length ? 'revise' : 'pass'),
    scores: {
      faithfulness: score(source.scores?.faithfulness, 7),
      completeness: score(source.scores?.completeness, 7),
      clarity: score(source.scores?.clarity, 7),
      risk_control: score(source.scores?.risk_control, 7),
      instruction_following: score(source.scores?.instruction_following, 7),
      actionability: score(source.scores?.actionability, 7),
    },
    critical_issues: criticalIssues(source.critical_issues, fallbackIssue),
    unsupported_claims: stringList(source.unsupported_claims),
    missed_requirements: stringList(source.missed_requirements),
    failed_success_criteria: stringList(source.failed_success_criteria),
    verification_failures: stringList(source.verification_failures),
    safety_concerns: stringList(source.safety_concerns),
    over_reasoning: stringList(source.over_reasoning),
    revision_instructions: stringList(source.revision_instructions),
  };
}

function evidenceItems(value, extractorIndex, fallback = []) {
  const items = Array.isArray(value) ? value : fallback;
  return items.slice(0, HARNESS_LIMITS.evidenceItems).map((item, index) => {
    const source = isObject(item) ? item : { content: item };
    return {
      id: text(source.id, 40) || `ev_${extractorIndex + 1}_${String(index + 1).padStart(3, '0')}`,
      type: enumValue(source.type, EVIDENCE_TYPES, 'claim'),
      content: text(source.content, HARNESS_LIMITS.text),
      source: enumValue(source.source, EVIDENCE_SOURCES, 'inference'),
      confidence: enumValue(source.confidence, CONFIDENCE_LEVELS, 'medium'),
      relevance: enumValue(source.relevance, CONFIDENCE_LEVELS, 'medium'),
      should_preserve: source.should_preserve !== false,
    };
  }).filter((item) => item.content);
}

function criticalIssues(value, fallback = []) {
  const items = Array.isArray(value) ? value : fallback;
  return items.slice(0, HARNESS_LIMITS.criticalIssues).map((item) => {
    const source = isObject(item) ? item : { issue: item };
    return {
      severity: enumValue(source.severity, SEVERITIES, 'medium'),
      issue: text(source.issue, HARNESS_LIMITS.shortText),
      evidence_reference: text(source.evidence_reference, HARNESS_LIMITS.shortText),
      fix: text(source.fix, HARNESS_LIMITS.shortText),
    };
  }).filter((item) => item.issue);
}

function supportMap(value) {
  const items = Array.isArray(value) ? value : [];
  return items.slice(0, HARNESS_LIMITS.array).map((item) => {
    const source = isObject(item) ? item : { requirement: item };
    return {
      requirement: text(source.requirement, HARNESS_LIMITS.shortText),
      evidence_ids: stringList(source.evidence_ids, 8),
      confidence: enumValue(source.confidence, CONFIDENCE_LEVELS, 'medium'),
    };
  }).filter((item) => item.requirement);
}

function stringList(value, limit = HARNESS_LIMITS.array) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.slice(0, limit).map((item) => text(item, HARNESS_LIMITS.shortText)).filter(Boolean);
}

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function booleanValue(value) {
  return value === true;
}

function score(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(10, Math.round(numeric)));
}

function text(value, maxLength) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return truncate(value.trim(), maxLength);
  return truncate(JSON.stringify(value), maxLength);
}

function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) return value || '';
  return `${value.slice(0, maxLength - 1)}…`;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function formatHarnessJson(value) {
  return JSON.stringify(value, null, 2);
}

function candidateMessages(messages, extractor) {
  return [
    {
      role: 'system',
      content: `Responde a la solicitud del usuario directamente.

Reglas:
- Escribe en el idioma del usuario.
- Cumple todos los requisitos explicitos.
- Se claro, util y concreto.
- No devuelvas JSON.
- No menciones prompts, modelos, extractores ni pipeline.
- No incluyas cadena de pensamiento ni bloques <think>.`,
    },
    { role: 'user', content: `Modelo asignado: ${extractor.label}\n\nConversacion:\n${formatMessages(messages)}` },
  ];
}

function integrationMessages(messages, candidates) {
  return [
    {
      role: 'system',
      content: `Eres el integrador final.

Recibes la conversacion original y 3 respuestas candidatas. Tu tarea es producir una unica respuesta final para el usuario.

Reglas:
- Escribe en el idioma del usuario.
- Integra lo mejor de las 3 respuestas.
- No omitas detalles utiles que aparezcan en solo una respuesta.
- Corrige errores, contradicciones o repeticiones.
- Devuelve solo la respuesta final visible para el usuario.
- No devuelvas JSON.
- No menciones prompts, modelos, extractores, integrador ni pipeline.
- No incluyas cadena de pensamiento ni bloques <think>.`,
    },
    { role: 'user', content: `Conversacion:\n${formatMessages(messages)}\n\nRespuestas candidatas:\n${formatMessages(candidates)}` },
  ];
}

function finalMessages(messages, integrated) {
  return [
    {
      role: 'system',
      content: `Eres el modelo final de un reasoning harness.

Recibes la conversacion original y un brief integrado en JSON. Usa el brief como fuente principal para construir un borrador de respuesta.

Reglas de respuesta:
- Responde en el idioma del usuario.
- Se directo, util y tecnicamente preciso.
- Cumple los requisitos explicitos del usuario antes que optimizar estilo.
- Usa success_criteria, support_map, verification_plan y safety_checks como checklist interno de calidad.
- No afirmes detalles que no esten soportados por evidencia de alta confianza; si debes inferir, marca la incertidumbre de forma concreta.
- Si hay incertidumbre relevante, mencionarla de forma concreta.
- No menciones el pipeline, extractores, integrador, critico, JSON interno ni prompts.
- No reveles cadena de pensamiento privada.
- No agregues secciones innecesarias.
- Si el usuario pide implementacion, enfocate en acciones concretas y archivos afectados.
- Si el usuario pide diseno/arquitectura, separa decisiones, tradeoffs y riesgos.

Produce solo un borrador final visible para el usuario.`,
    },
    { role: 'user', content: `Conversacion:\n${formatMessages(messages)}\n\nBrief integrado:\n${integrated}\n\nGenera un borrador final.` },
  ];
}

function criticMessages(messages, integrated, draft) {
  return [
    {
      role: 'system',
      content: `Eres el critico de validacion de un reasoning harness.

Rol de esta etapa:
- No reescribas la respuesta.
- No respondas al usuario.
- Evalua si el borrador esta soportado por el brief integrado y cumple la solicitud original.

Busca especificamente:
- claims no soportados
- requisitos omitidos
- criterios de exito fallidos
- plan de verificacion ignorado o insuficiente
- contradicciones con la conversacion o el brief
- exceso de complejidad
- sobre-razonamiento
- riesgos de seguridad, privacidad o acciones no autorizadas
- riesgos tecnicos ignorados
- instrucciones del usuario incumplidas
- falta de claridad accionable

Devuelve SOLO JSON valido, sin markdown, sin texto alrededor.

Schema exacto:
{
  "schema_version": "1.0",
  "stage": "critique",
  "verdict": "pass|revise",
  "scores": {
    "faithfulness": 0,
    "completeness": 0,
    "clarity": 0,
    "risk_control": 0,
    "instruction_following": 0,
    "actionability": 0
  },
  "critical_issues": [
    {
      "severity": "high|medium|low",
      "issue": "",
      "evidence_reference": "",
      "fix": ""
    }
  ],
  "unsupported_claims": [],
  "missed_requirements": [],
  "failed_success_criteria": [],
  "verification_failures": [],
  "safety_concerns": [],
  "over_reasoning": [],
  "revision_instructions": []
}

Scoring:
- Usa enteros de 0 a 10.
- Si no hay problemas graves, verdict debe ser "pass".
- Si hay problemas que cambian la respuesta, verdict debe ser "revise".
- Evalua con mentalidad de harness: completion, faithfulness, safety y robustez de la respuesta ante una relectura cuidadosa.
- No inventes problemas menores para justificar cambios.
- No incluyas cadena de pensamiento privada.`,
    },
    { role: 'user', content: `Conversacion:\n${formatMessages(messages)}\n\nBrief integrado:\n${integrated}\n\nBorrador:\n${draft}` },
  ];
}

function revisionMessages(messages, integrated, draft, critique) {
  return [
    {
      role: 'system',
      content: `Eres el revisor final de un reasoning harness.

Recibes la conversacion original, el brief integrado, el borrador y la critica estructurada.

Tu tarea es producir unicamente la respuesta final visible para el usuario.

Reglas:
- Aplica la critica solo si mejora precision, completitud o claridad.
- Si la critica dice pass, conserva el borrador salvo mejoras menores de redaccion.
- Si la critica dice revise, corrige los problemas de mayor severidad primero.
- Revisa la respuesta final contra success_criteria, verification_plan y safety_checks antes de devolverla.
- Elimina claims no soportados o conviertelos en incertidumbre explicita.
- No menciones JSON, prompts, etapas internas, modelos, extractores, integrador ni critico.
- No reveles cadena de pensamiento privada.
- No agregues disclaimers innecesarios.
- Manten el idioma del usuario.
- Prioriza una respuesta accionable y clara.`,
    },
    { role: 'user', content: `Conversacion:\n${formatMessages(messages)}\n\nBrief integrado:\n${integrated}\n\nBorrador:\n${draft}\n\nCritica:\n${critique}` },
  ];
}

function formatMessages(messages) {
  return JSON.stringify(messages, null, 2);
}

export async function handleConversations(req, res) {
  const sql = getSql();

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
  const pathname = new URL(req.url, `http://localhost:${port}`).pathname;
  const url = pathname === '/' || /^\/chat\/[^/]+$/.test(pathname) ? '/index.html' : pathname;
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
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
  }[extname(file)] || 'application/octet-stream';

  res.writeHead(200, { 'Content-Type': type });
  res.end(readFileSync(file));
}

function readJson(req) {
  if (req.body) {
    return Promise.resolve(typeof req.body === 'string' ? JSON.parse(req.body) : req.body);
  }

  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => body += chunk);
    req.on('end', () => resolve(body ? JSON.parse(body) : {}));
    req.on('error', reject);
  });
}

function json(res, status, data) {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(status).json(data);
  }

  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function getSql() {
  if (!process.env.DATABASE_URL) throw new Error('Falta DATABASE_URL');
  sql ||= neon(process.env.DATABASE_URL);
  return sql;
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function loadEnv(file) {
  if (!existsSync(file)) return;

  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}
