import type { ComponentType } from 'react'
import {
  AntGroup,
  Azure,
  Baseten,
  Bedrock,
  Cerebras,
  Claude,
  Cloudflare,
  DeepSeek,
  Fireworks,
  Gemini,
  GithubCopilot,
  Groq,
  HuggingFace,
  Kimi,
  Minimax,
  Mistral,
  Moonshot,
  Nvidia,
  OpenAI,
  OpenCode,
  OpenRouter,
  Qwen,
  Together,
  Vercel,
  XAI,
  XiaomiMiMo,
  ZAI
} from '@lobehub/icons'

type LobeIcon = ComponentType<{ size?: string | number; className?: string }>

/**
 * pi-ai provider ids (see pi-ai/dist/providers/*.models.js) → brand icon from
 * @lobehub/icons. Anything missing falls back to an initial-letter tile, so
 * custom providers stay recognizable.
 */
const PROVIDER_ICONS: Record<string, LobeIcon> = {
  anthropic: Claude,
  openai: OpenAI,
  'openai-codex': OpenAI,
  google: Gemini,
  'google-vertex': Gemini,
  zai: ZAI,
  'zai-coding-cn': ZAI,
  deepseek: DeepSeek,
  qwen: Qwen,
  'qwen-token-plan': Qwen,
  'qwen-token-plan-cn': Qwen,
  'qwen-token-plan-individual': Qwen,
  mistral: Mistral,
  groq: Groq,
  openrouter: OpenRouter,
  moonshotai: Moonshot,
  'moonshotai-cn': Moonshot,
  'kimi-coding': Kimi,
  xai: XAI,
  minimax: Minimax,
  'minimax-cn': Minimax,
  'amazon-bedrock': Bedrock,
  'azure-openai-responses': Azure,
  huggingface: HuggingFace,
  together: Together,
  fireworks: Fireworks,
  'github-copilot': GithubCopilot,
  nvidia: Nvidia,
  cerebras: Cerebras,
  'cloudflare-ai-gateway': Cloudflare,
  'cloudflare-workers-ai': Cloudflare,
  baseten: Baseten,
  'vercel-ai-gateway': Vercel,
  opencode: OpenCode,
  'opencode-go': OpenCode,
  xiaomi: XiaomiMiMo,
  'xiaomi-token-plan-ams': XiaomiMiMo,
  'xiaomi-token-plan-cn': XiaomiMiMo,
  'xiaomi-token-plan-sgp': XiaomiMiMo,
  'ant-ling': AntGroup
}

export function ProviderIcon({
  providerId,
  name,
  size = 16
}: {
  providerId: string
  name?: string
  size?: number
}) {
  const Icon = PROVIDER_ICONS[providerId]
  if (Icon) return <Icon size={size} />
  const letter = (name ?? providerId).trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-md bg-primary/10 font-semibold leading-none text-primary"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.7) }}
    >
      {letter}
    </span>
  )
}
