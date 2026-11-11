// ISP-specific TLS-fragmentation presets (community-tuned starting points).
// Applied at sub-serve time when a member picks a preset instead of manual
// fragment values — helps against ISP-level DPI throttling in Iran.

export interface FragmentPreset {
  code: string
  label: string
  flag: string
  config: { packets: string; length: string; interval: string }
}

export const FRAGMENT_PRESETS: FragmentPreset[] = [
  { code: 'mci',      label: 'همراه اول',   flag: '🇮🇷', config: { packets: 'tlshello', length: '1-3',     interval: '1-2'   } },
  { code: 'irancel',  label: 'ایرانسل',     flag: '🇮🇷', config: { packets: 'tlshello', length: '10-20',   interval: '5-10'  } },
  { code: 'rightel',  label: 'رایتل',       flag: '🇮🇷', config: { packets: 'tlshello', length: '100-200', interval: '10-20' } },
  { code: 'tci',      label: 'مخابرات (TCI)', flag: '🇮🇷', config: { packets: 'tlshello', length: '50-100', interval: '10-20' } },
  { code: 'gaming',   label: 'گیمینگ (کم‌تأخیر)', flag: '🎮', config: { packets: 'tlshello', length: '1-5',   interval: '10-20' } },
]

/** Ready cipher-suite (`cs=`) presets — injected verbatim into every link.
 * The full list is the Xray-core recommended suite order (user-verified in Iran). */
export const CS_PRESETS: Array<{ code: string; label: string; value: string }> = [
  {
    code: 'cs-full',
    label: 'مجموعه کامل (Xray توصیه‌شده)',
    value:
      'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256:' +
      'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384:TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384:' +
      'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256:TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256:' +
      'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256:TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256:' +
      'TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA:TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA:' +
      'TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256:TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256',
  },
  {
    code: 'cs-modern',
    label: 'مدرن (AES + ChaCha)',
    value: 'TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256',
  },
  {
    code: 'cs-ecdhe',
    label: 'ECDHE فقط (سبک)',
    value: 'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256:TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256:TLS_AES_128_GCM_SHA256',
  },
]

/** Client-specific TLS-fragment presets from edgetunnel — emitted verbatim
 *  as the `fragment=` query param (different format per client app). */
export const CLIENT_FRAGMENT_PRESETS: Array<{ code: string; label: string; value: string }> = [
  { code: 'shadowrocket', label: 'Shadowrocket', value: '1,40-60,30-50,tlshello' },
  { code: 'happ', label: 'Happ', value: '3,1,tlshello' },
]

/** Chain-proxy protocols supported by edgetunnel workers (per-request egress). */
export const CHAIN_PROTOCOLS = ['socks5', 'http', 'https', 'turn', 'sstp'] as const

/** Real, permissive SNI values (community-tested from Iran) for the SNI-mask
 * dropdowns. These domains are not blocked and their TLS cert allows CDN
 * fronting — used to bypass sanction/SNI filtering (Gemini, OpenAI, ...). */
export const KNOWN_SNIS: string[] = [
  'www.speedtest.net',
  'fast.com',
  'player.vimeo.com',
  'www.icloud.com',
  'www.apple.com',
  'www.samsung.com',
  'www.yahoo.com',
  'www.bing.com',
  'cdn.discordapp.com',
  'www.datadoghq-browser-agent.com',
]

export function findPreset(code: string | undefined): FragmentPreset | null {
  if (!code) return null
  return FRAGMENT_PRESETS.find((p) => p.code === code) ?? null
}

/** Battle-tested multi-fragment `fm=` JSON configs (Iran-verified). These are
 * injected VERBATIM into every link as the `fm` query param — exactly what
 * cf-optimizor's ready buttons emit. Never rewritten by the panel. */
export const FM_PRESETS: Array<{ code: string; label: string; json: string }> = [
  {
    code: 'fm-dual',
    label: 'فرگمنت دو مرحله‌ای (پایدار)',
    json: '{"tcp":[{"type":"fragment","settings":{"packets":"tlshello","lengths":["5","94","1"],"delays":["0"],"maxSplit":"0"}},{"type":"fragment","settings":{"packets":"1-1","lengths":["109","1"],"delays":["1"],"maxSplit":"355"}}]}',
  },
  {
    code: 'fm-single',
    label: 'فرگمنت ساده (سبک)',
    json: '{"tcp":[{"type":"fragment","settings":{"packets":"tlshello","lengths":["1-1"],"delays":["0"],"maxSplit":"0"}}]}',
  },
  {
    code: 'fm-combo',
    label: 'فرگمنت ترکیبی (ضد اختلال)',
    json: '{"tcp":[{"type":"fragment","settings":{"packets":"tlshello","lengths":["1-1"],"delays":["0"],"maxSplit":"0"}},{"type":"fragment","settings":{"packets":"1-3","lengths":["1-1"],"delays":["1"],"maxSplit":"500"}}]}',
  },
]
