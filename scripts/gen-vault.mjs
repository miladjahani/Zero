#!/usr/bin/env node
/**
 * NEXUS vault generator — produces the encoded string table embedded in
 * public/repo/nexus.js. Each plain string is encoded as:
 *
 *   utf8 → byte ^ (i % 5 + 3)  →  base64
 *
 * and the worker decodes it at load time with the matching `_s(i)` pipeline.
 * Kept as a dev tool so the table can be regenerated/extended without
 * hand-computing base64.
 */
const STRINGS = [
  // routes
  '/api/info', '/api/nodes', '/api/config', '/api/map', '/api/unlock',
  '/sub', '/healthz', '/favicon.ico', '/robots.txt', '/',
  // methods / content types
  'GET', 'POST', 'PUT', 'OPTIONS', 'DELETE',
  'application/json', 'text/plain', 'text/html; charset=utf-8',
  'application/yaml', 'application/octet-stream', 'image/svg+xml',
  // headers
  'content-type', 'cache-control', 'no-store', 'no-cache',
  'Subscription-Userinfo', 'content-disposition', 'attachment',
  'access-control-allow-origin', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-max-age', 'origin',
  'X-Key', 'x-key', 'k=', '&k=', 'cf-ipcountry', 'cf-ray', 'cf-colo',
  'user-agent', 'cf-connecting-ip', 'x-real-ip',
  // core tokens
  'NEXUS', 'nexus', 'vless', 'trojan', 'ss', 'vmess',
  'ws', 'grpc', 'xhttp', 'tls', 'none', 'chrome', 'random',
  'encryption', 'security', 'sni', 'fp', 'type', 'host', 'path',
  'serviceName', 'mode', 'auto', 'plugin', 'v2ray-plugin',
  'tls;mode=websocket;host=', 'servername', 'client-fingerprint',
  'ws-opts', 'grpc-opts', 'proxies', 'proxy-groups', 'url-test',
  'outbounds', 'tag', 'protocol', 'settings', 'stream-settings',
  'network', 'real-header', 'upload', 'download', 'expire', 'total',
  'disabled', 'c', 'config.json', 'ADD.txt', 'stats',
  // semantic
  'colocation', 'country', 'city', 'continent', 'asn', 'isp',
  'timezone', 'version', 'keySet', 'zone', 'visitor', 'pop',
  'links', 'subs', 'base64', 'plain', 'clash', 'singbox', 'qr',
  'clients', 'rtt', 'uptime', 'now', 'count', 'line', 'proto',
  'transport', 'port', 'fragment', 'flow', 'reality', 'ech', 'alpn',
  'socks5', 'socks', 'username', 'password', 'address', 'keepalive',
  'ok', 'error', 'forbidden', 'invalid', 'unlock', 'locked',
  'gateway', 'future', 'live', 'smart', 'engine', 'panel', 'map',
  'save', 'settings', 'dark', 'light', 'theme', 'lang', 'fa', 'en',
  'workers.dev', 'pages.dev', 'cloudflare',
]

const enc = (s) => {
  const bytes = new TextEncoder().encode(s)
  const out = bytes.map((b, i) => b ^ ((i % 5) + 3))
  let bin = ''
  for (const b of out) bin += String.fromCharCode(b)
  return Buffer.from(bin, 'binary').toString('base64')
}

const rows = STRINGS.map(enc)
const lines = []
for (let i = 0; i < rows.length; i += 4) {
  lines.push('  ' + rows.slice(i, i + 4).map((r) => `'${r}'`).join(', '))
}
console.log('// ' + STRINGS.length + ' strings, encoded (base64 of xor-shift)')
console.log('const ' + '字' + ' = [')
console.log(lines.join(',\n'))
console.log('];')
