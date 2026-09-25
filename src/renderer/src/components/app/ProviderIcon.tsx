import AntGroup from '@lobehub/icons-static-svg/icons/antgroup.svg?url'
import Azure from '@lobehub/icons-static-svg/icons/azure.svg?url'
import Baseten from '@lobehub/icons-static-svg/icons/baseten.svg?url'
import Bedrock from '@lobehub/icons-static-svg/icons/bedrock.svg?url'
import Cerebras from '@lobehub/icons-static-svg/icons/cerebras.svg?url'
import Claude from '@lobehub/icons-static-svg/icons/claude.svg?url'
import Cloudflare from '@lobehub/icons-static-svg/icons/cloudflare.svg?url'
import DeepSeek from '@lobehub/icons-static-svg/icons/deepseek.svg?url'
import Fireworks from '@lobehub/icons-static-svg/icons/fireworks.svg?url'
import Gemini from '@lobehub/icons-static-svg/icons/gemini.svg?url'
import GithubCopilot from '@lobehub/icons-static-svg/icons/githubcopilot.svg?url'
import Groq from '@lobehub/icons-static-svg/icons/groq.svg?url'
import HuggingFace from '@lobehub/icons-static-svg/icons/huggingface.svg?url'
import Kimi from '@lobehub/icons-static-svg/icons/kimi.svg?url'
import Minimax from '@lobehub/icons-static-svg/icons/minimax.svg?url'
import Mistral from '@lobehub/icons-static-svg/icons/mistral.svg?url'
import Moonshot from '@lobehub/icons-static-svg/icons/moonshot.svg?url'
import Nvidia from '@lobehub/icons-static-svg/icons/nvidia.svg?url'
import OpenAI from '@lobehub/icons-static-svg/icons/openai.svg?url'
import OpenCode from '@lobehub/icons-static-svg/icons/opencode.svg?url'
import OpenRouter from '@lobehub/icons-static-svg/icons/openrouter.svg?url'
import Qwen from '@lobehub/icons-static-svg/icons/qwen.svg?url'
import Together from '@lobehub/icons-static-svg/icons/together.svg?url'
import Vercel from '@lobehub/icons-static-svg/icons/vercel.svg?url'
import XAI from '@lobehub/icons-static-svg/icons/xai.svg?url'
import XiaomiMiMo from '@lobehub/icons-static-svg/icons/xiaomimimo.svg?url'
import ZAI from '@lobehub/icons-static-svg/icons/zai.svg?url'

/**
 * pi-ai provider ids (see pi-ai/dist/providers/*.models.js) → brand icon from
 * the dependency-free static SVG pack. Anything missing falls back to an initial-letter tile, so
 * custom providers stay recognizable.
 */
const PROVIDER_ICONS: Record<string, string> = {
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
  const source = PROVIDER_ICONS[providerId]
  if (source) return (
    <span
      aria-hidden="true"
      data-provider-icon={providerId}
      className="inline-block shrink-0 bg-current align-middle"
      style={{
        width: size,
        height: size,
        maskImage: `url("${source}")`,
        maskSize: 'contain',
        maskRepeat: 'no-repeat',
        maskPosition: 'center'
      }}
    />
  )
  const letter = (name ?? providerId).trim().charAt(0).toUpperCase() || '?'
  // Keep the fallback letter within the interface's fixed type steps even as
  // its tile grows; provider SVGs above are artwork and have no text size.
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-md bg-primary/10 font-semibold leading-none text-primary"
      style={{ width: size, height: size, fontSize: size <= 14 ? 10 : size <= 20 ? 14 : 16 }}
    >
      {letter}
    </span>
  )
}
