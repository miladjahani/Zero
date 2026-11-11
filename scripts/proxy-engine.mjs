/* ───────────────────────────── ۱۰·۱ · موتور پروکسی WebSocket ────────────── */
function UUID2hex(bytes) {
  const h = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20,32);
}
function parseVLESS(buf, uuid) {
  if (buf.length < 18 || buf[0] !== 0) return null;
  const cid = UUID2hex(buf.slice(1,17));
  if (cid !== uuid) return null;
  const cmd = buf[17];
  const port = (buf[18]<<8)|buf[19];
  const atyp = buf[20];
  let addr='', hdrLen=21;
  if (atyp===1) { addr=[buf[21],buf[22],buf[23],buf[24]].join('.'); hdrLen=25; }
  else if (atyp===2) { const dl=buf[21]; addr=new TextDecoder().decode(buf.slice(22,22+dl)); hdrLen=22+dl; }
  else if (atyp===3) { const p=[]; for(let i=0;i<8;i++) p.push(((buf[21+i*2]<<8)|buf[22+i*2]).toString(16)); addr=p.join(':'); hdrLen=37; }
  return { cmd, addr, port, hdrLen, remaining: buf.slice(hdrLen) };
}
async function sha224hex(str) {
  const buf = await crypto.subtle.digest('SHA-224', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}
function parseTrojan(buf, uuid) {
  const txt = new TextDecoder().decode(buf);
  const CRLF_HASH = '\r\n';
  if (!buf.length || buf[0] !== 0x0D || buf[1] !== 0x0A) return null;
  let end = 2;
  while (end < buf.length - 1 && !(buf[end] === 0x0D && buf[end+1] === 0x0A)) end++;
  if (end >= buf.length - 1) return null;
  const hex56 = new TextDecoder().decode(buf.slice(2, end));
  if (hex56.length !== 56) return null;
  return { hex56, hdrEnd: end + 2 };
}
async function 代理(request, env, cfg) {
  const uuid = cfg.uuid || env.u || '';
  if (!uuid) return new Response('no uuid', { status: 403 });
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  server.accept();
  let ready = false;
  server.addEventListener('message', async (ev) => {
    if (ready) return;
    ready = true;
    const buf = new Uint8Array(ev.data);
    /* ── VLESS ── */
    if (buf.length > 0 && buf[0] === 0) {
      const vless = parseVLESS(buf, uuid);
      if (!vless || vless.cmd !== 1) { try { server.close(1008, 'bad'); } catch {} return; }
      const proxyIP = cfg.p || '';
      const target = proxyIP || vless.addr;
      const targetPort = vless.port || 443;
      try {
        const tcp = connect({ hostname: target, port: targetPort });
        server.send(new Uint8Array([0, 0]));
        const writer = tcp.writable.getWriter();
        if (vless.remaining.length > 0) await writer.write(vless.remaining);
        server.addEventListener('message', async (e) => { try { await writer.write(new Uint8Array(e.data)); } catch {} });
        const reader = tcp.readable.getReader();
        (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; server.send(value); } } catch {} try { server.close(); } catch {} })();
        tcp.closed.then(() => { try { server.close(); } catch {} }).catch(() => { try { server.close(); } catch {} });
      } catch { try { server.close(1011, 'connect failed'); } catch {} }
      return;
    }
    /* ── Trojan ── */
    const trojan = parseTrojan(buf, uuid);
    if (trojan) {
      const expected = await sha224hex(uuid);
      if (trojan.hex56 !== expected) { try { server.close(1008, 'auth'); } catch {} return; }
      const afterHash = buf.slice(trojan.hdrEnd);
      if (afterHash.length < 6) { try { server.close(1008, 'short'); } catch {} return; }
      const cmd = afterHash[0];
      if (cmd !== 1) { try { server.close(1008, 'not-tcp'); } catch {} return; }
      const atyp = afterHash[1];
      let addr = '', addrLen = 0;
      if (atyp === 1) { addr = [afterHash[2], afterHash[3], afterHash[4], afterHash[5]].join('.'); addrLen = 4; }
      else if (atyp === 2) { const dl = afterHash[2]; addr = new TextDecoder().decode(afterHash.slice(3, 3+dl)); addrLen = dl + 1; }
      else if (atyp === 3) { const p = []; for (let i = 0; i < 8; i++) p.push(((afterHash[2+i*2]<<8)|afterHash[3+i*2]).toString(16)); addr = p.join(':'); addrLen = 16; }
      const port = (afterHash[2+addrLen] << 8) | afterHash[3+addrLen];
      const dataStart = trojan.hdrEnd + 4 + addrLen;
      const remaining = buf.slice(dataStart);
      const proxyIP = cfg.p || '';
      const target = proxyIP || addr;
      try {
        const tcp = connect({ hostname: target, port: port || 443 });
        server.send(new Uint8Array([1, 0, 0])); // trojan response header
        const writer = tcp.writable.getWriter();
        if (remaining.length > 0) await writer.write(remaining);
        server.addEventListener('message', async (e) => { try { await writer.write(new Uint8Array(e.data)); } catch {} });
        const reader = tcp.readable.getReader();
        (async () => { try { for (;;) { const { done, value } = await reader.read(); if (done) break; server.send(value); } } catch {} try { server.close(); } catch {} })();
        tcp.closed.then(() => { try { server.close(); } catch {} }).catch(() => { try { server.close(); } catch {} });
      } catch { try { server.close(1011, 'connect failed'); } catch {} }
      return;
    }
    try { server.close(1008, 'unsupported'); } catch {}
  });
  return new Response(null, { status: 101, webSocket: client });
}
