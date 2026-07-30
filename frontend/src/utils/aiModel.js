export const AI_MODEL_STORAGE_KEY = 'arlo-ai-model';

export const FREE_OPENROUTER_MODELS = [
  { value: 'openai/gpt-oss-20b:free', label: 'OpenAI gpt-oss-20b (free)' },
  { value: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'NVIDIA Nemotron 3 Super 120B (free)' },
  { value: 'google/gemma-4-31b-it:free', label: 'Google Gemma 4 31B (free)' },
];

export function getPreferredAiModel() {
  try {
    const value = localStorage.getItem(AI_MODEL_STORAGE_KEY);
    return FREE_OPENROUTER_MODELS.some((model) => model.value === value)
      ? value
      : FREE_OPENROUTER_MODELS[0].value;
  } catch {
    return FREE_OPENROUTER_MODELS[0].value;
  }
}

export function setPreferredAiModel(model) {
  if (!FREE_OPENROUTER_MODELS.some((candidate) => candidate.value === model)) {
    return FREE_OPENROUTER_MODELS[0].value;
  }

  try {
    localStorage.setItem(AI_MODEL_STORAGE_KEY, model);
  } catch {
    // Ignore storage failures in embedded webviews.
  }
  return model;
}
