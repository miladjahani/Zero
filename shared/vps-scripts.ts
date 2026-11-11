/**
 * Script-based VPS installers — projects that are installed by running an
 * official shell script directly on the server (Ubuntu/Debian) instead of a
 * container image or Dockerfile.
 *
 * They cannot be part of the automated Docker deployer (they own the host:
 * systemd, SSH, kernel modules), so the wizard shows their **verified official
 * install command** to copy-paste on the VPS. Same liveness rule as the panel
 * catalog: only repositories that were alive at verification time are listed,
 * and every installer command below was read from the project's own README.
 */

import type { PanelOrigin } from './panels'

export interface VpsScriptSpec {
  id: string
  name: string
  /** GitHub repository in `owner/name` form. */
  repo: string
  url: string
  origin: PanelOrigin
  description: string
  /** Official one-line installer (exactly as documented by the project). */
  installCommand?: string
  /** Optional Docker/appliance installer. */
  dockerCommand?: string
  /** Menu command to reopen the panel after install. */
  manageCommand?: string
  notes?: string
  /** Newest upstream commit we verified (YYYY-MM-DD). */
  lastCommit: string
  /** Day this entry was verified against the live repository. */
  verifiedAt: string
}

export const VPS_SCRIPTS: VpsScriptSpec[] = [
  {
    id: 'shahanpanel',
    name: 'ShahanPanel (پنل شاهان)',
    repo: 'HamedAp/ShahanPanel',
    url: 'https://github.com/HamedAp/ShahanPanel',
    origin: 'ir',
    description:
      'پنل مدیریت کاربران SSH با نظارت ترافیک، پورت SSH/DropBear/UDP، پشتیبان‌گیری خودکار، API و ربات تلگرام — نسخهٔ رایگان + نسخهٔ Pro.',
    installCommand:
      'bash <(curl -Ls https://raw.githubusercontent.com/HamedAp/Ssh-User-management/master/install.sh --ipv4)',
    notes:
      'روی Ubuntu نصب می‌شود (اسکریپت رسمی خودش). نسخهٔ رایگان محدود است؛ پروتکل‌های TUIC/WireGuard/Shadowsocks/OpenVPN در نسخهٔ Pro هستند.',
    lastCommit: '2026-09-12',
    verifiedAt: '2026-09-12',
  },
  {
    id: 'v2ray-agent',
    name: 'v2ray-agent (mack-a)',
    repo: 'mack-a/v2ray-agent',
    url: 'https://github.com/mack-a/v2ray-agent',
    origin: 'cn',
    description:
      'اسکریپت یک‌خطی جامعهٔ چینی: Xray-core و sing-box، پروتکل‌های VLESS/Vmess/Trojan/Hysteria2/Tuic/NaiveProxy، صدور خودکار TLS و مدیریت ساب‌سکریپشن.',
    installCommand:
      'wget -P /root -N --no-check-certificate "https://raw.githubusercontent.com/mack-a/v2ray-agent/master/install.sh" && chmod 700 /root/install.sh && /root/install.sh',
    dockerCommand:
      'wget -P /root -N --no-check-certificate "https://raw.githubusercontent.com/mack-a/v2ray-agent/master/shell/docker_reality.sh" && chmod 700 /root/docker_reality.sh && /root/docker_reality.sh',
    manageCommand: 'vasma',
    notes: 'پس از نصب، با دستور vasma منوی مدیریت باز می‌شود (نسخهٔ داکری: vasmad).',
    lastCommit: '2026-09-09',
    verifiedAt: '2026-09-12',
  },
  {
    id: 'hiddify-manager',
    name: 'Hiddify Manager',
    repo: 'hiddify/Hiddify-Manager',
    url: 'https://github.com/hiddify/Hiddify-Manager',
    origin: 'intl',
    description:
      'پنل جامع چند‌پروتکلی (Xray/Sing-box/Hysteria/…) با نصب روی سرور و مدیریت دامنه/کاربر — پیش‌فرض شاخهٔ dev فعال است.',
    notes:
      'نصب با اسکریپت رسمی مخزن انجام می‌شود (شاخهٔ dev؛ Docker/نصب مستقیم). چون مستقیم روی هاست و systemd نصب می‌شود، در استقرار داکری خودکار ما قرار نمی‌گیرد.',
    lastCommit: '2026-09-07',
    verifiedAt: '2026-09-12',
  },
]

/**
 * Less-known panel names users asked about that have no verifiable public
 * repository (distributed through Telegram channels / resellers). Kept here so
 * the omission is explicit rather than accidental.
 */
export const UNVERIFIABLE_PANEL_BRANDS: Array<{ name: string; reason: string }> = [
  { name: 'SLV panel', reason: 'مخزن عمومی قابل‌تأیید پیدا نشد' },
  { name: 'RVG panel', reason: 'مخزن عمومی ندارد؛ فقط «سبک کانفیگ RVG» در چند پروژه ارجاع داده شده' },
  { name: 'loofi panel', reason: 'در گیت‌هاب فقط پروژه‌های هم‌نام و بی‌ربط' },
  { name: 'sanayii panel', reason: 'مخزن عمومی ندارد (پنل تجاری فارسی)' },
  { name: 'solgx', reason: 'هیچ نتیجهٔ مرتبطی در گیت‌هاب نبود' },
]
