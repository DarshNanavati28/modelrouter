export const MODELS = [
  {
    id: "google/gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    vendor: "Google",
    quality: 2,
    contextTokens: 1048576,
    latencyMs: 420,
    inputPricePerMillion: 0.10,
    outputPricePerMillion: 0.40,
    tier: "FAST",
    qualityNote: "Best for short, clear tasks"
  },
  {
    id: "openai/gpt-4.1-nano",
    name: "GPT-4.1 Nano",
    vendor: "OpenAI",
    quality: 2,
    contextTokens: 1047576,
    latencyMs: 480,
    inputPricePerMillion: 0.10,
    outputPricePerMillion: 0.40,
    tier: "BUDGET",
    qualityNote: "Low-cost general purpose"
  },
  {
    id: "meta-llama/llama-3.3-70b-instruct",
    name: "Llama 3.3 70B",
    vendor: "Meta",
    quality: 3,
    contextTokens: 131072,
    latencyMs: 880,
    inputPricePerMillion: 0.10,
    outputPricePerMillion: 0.32,
    tier: "BALANCED",
    qualityNote: "Good value for longer prompts"
  },
  {
    id: "anthropic/claude-haiku-5.5",
    name: "Claude Haiku 5.5",
    vendor: "Anthropic",
    quality: 3,
    contextTokens: 1000000,
    latencyMs: 680,
    inputPricePerMillion: 0.10,
    outputPricePerMillion: 0.50,
    tier: "BALANCED",
    qualityNote: "Fast reasoning with a large context"
  },
  {
    id: "deepseek/deepseek-chat-v3.1",
    name: "DeepSeek V3.1",
    vendor: "DeepSeek",
    quality: 4,
    contextTokens: 163840,
    latencyMs: 1080,
    inputPricePerMillion: 0.25,
    outputPricePerMillion: 0.95,
    tier: "ADVANCED",
    qualityNote: "Stronger analysis at a measured price"
  },
  {
    id: "openai/gpt-4.1-mini",
    name: "GPT-4.1 Mini",
    vendor: "OpenAI",
    quality: 4,
    contextTokens: 1047576,
    latencyMs: 820,
    inputPricePerMillion: 0.40,
    outputPricePerMillion: 1.60,
    tier: "ADVANCED",
    qualityNote: "Higher capability for complex tasks"
  },
  {
    id: "anthropic/claude-sonnet-5.5",
    name: "Claude Sonnet 5.5",
    vendor: "Anthropic",
    quality: 5,
    contextTokens: 1000000,
    latencyMs: 1280,
    inputPricePerMillion: 2.00,
    outputPricePerMillion: 10.00,
    tier: "PREMIUM",
    qualityNote: "Highest capability for demanding work"
  }
];

export const CATALOG_SOURCE = "OpenRouter catalog snapshot";
