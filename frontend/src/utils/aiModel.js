export const AI_MODEL_STORAGE_KEY = 'arlo-ai-model';

export const DEFAULT_FREE_OPENROUTER_MODELS = [
  'z-ai/glm-5.2:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
];

export function formatModelLabel(model) {
  const [provider, name] = String(model).replace(/:free$/, '').split('/');
  const title = (name || provider)
    .split('-')
    .map((part) => part ? part[0].toUpperCase() + part.slice(1) : part)
    .join(' ');
  return `${provider ? `${provider}: ` : ''}${title} (free)`;
}

export function getPreferredAiModel() {
  try {
    const value = localStorage.getItem(AI_MODEL_STORAGE_KEY);
    return value?.endsWith(':free') ? value : DEFAULT_FREE_OPENROUTER_MODELS[0];
  } catch {
    return DEFAULT_FREE_OPENROUTER_MODELS[0];
  }
}

export function setPreferredAiModel(model) {
  if (!String(model).endsWith(':free')) return getPreferredAiModel();
  try {
    localStorage.setItem(AI_MODEL_STORAGE_KEY, model);
  } catch {
    // Embedded webviews can restrict storage; the in-memory selection still works.
  }
  return model;
}
