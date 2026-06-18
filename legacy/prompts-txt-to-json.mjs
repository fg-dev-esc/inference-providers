import { readFileSync, writeFileSync } from 'node:fs';

const input = readFileSync('legacy/prompts.txt', 'utf8');
const categories = [];
let category = null;
let prompt = null;

function finishPrompt() {
  if (!category || !prompt) return;
  prompt.prompt = prompt.lines.join('\n').trim();
  delete prompt.lines;
  if (prompt.prompt) category.items.push(prompt);
  prompt = null;
}

for (const line of input.split(/\r?\n/)) {
  const categoryMatch = line.match(/^-\s+\d+\s+—\s+(.+)$/);
  const promptMatch = line.match(/^ {4}-\s+(.+)$/);

  if (categoryMatch) {
    finishPrompt();
    category = { title: cleanCategory(categoryMatch[1]), items: [] };
    categories.push(category);
    continue;
  }

  if (promptMatch && category) {
    finishPrompt();
    prompt = { label: promptMatch[1].trim(), prompt: '', lines: [] };
    continue;
  }

  if (prompt) prompt.lines.push(line.replace(/^ {8}/, ''));
}

finishPrompt();

const data = categories.filter((item) => item.items.length);
writeFileSync('prompts.json', `${JSON.stringify(data, null, 2)}\n`);

function cleanCategory(title) {
  return title
    .replace(/\s+list[ao]s$/i, '')
    .replace('Prompts base', 'Base')
    .replace('Funciones JavaScript', 'Funciones')
    .replace('Métodos de array', 'Arrays')
    .replace('React desde cero', 'React base')
    .replace('Features completas', 'Features')
    .replace('Prompts de repaso', 'Repaso')
    .replace('JavaScript objetos y sintaxis moderna', 'Objetos y sintaxis')
    .replace('React render y composición', 'Render y composición')
    .replace('Formularios React', 'Formularios')
    .replace('Custom hooks extendidos', 'Custom hooks')
    .replace('Mini proyectos guiados', 'Mini proyectos')
    .replace('Prompts para convertir y profundizar', 'Convertir y profundizar')
    .replace('Rutas de curso', 'Rutas');
}
