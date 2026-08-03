/* Playwright bits, kept out of env.mjs so the node-only suites need no browser. */
export const CHROME = process.env.CHROME_PATH ||
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const mod = process.env.PLAYWRIGHT_MODULE || 'playwright';
export const { chromium } = await import(mod);

/**
 * Relay ArcGIS calls through node. A sandboxed browser often has no route to
 * the internet while node does, and this also gives a switch for simulating a
 * lost connection. Returns a setOffline(bool).
 */
export async function relayArcGIS(ctx, referer) {
  const state = { offline: false };
  await ctx.route('**://*.arcgis.com/**', async (route) => {
    if (state.offline) return route.abort('internetdisconnected');
    const req = route.request();
    const send = () => fetch(req.url(), {
      method: req.method(),
      headers: {
        ...Object.fromEntries(Object.entries(req.headers()).filter(([k]) =>
          !/^(host|origin|referer|connection|content-length|accept-encoding|sec-)/i.test(k))),
        Referer: referer,
      },
      body: req.postDataBuffer() ?? undefined,
      signal: AbortSignal.timeout(20000),
    });
    try {
      let res;
      try { res = await send(); } catch (e) { res = await send(); }   // the proxy stalls sometimes
      const body = Buffer.from(await res.arrayBuffer());
      const headers = {};
      res.headers.forEach((v, k) => {
        if (!/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) headers[k] = v;
      });
      headers['access-control-allow-origin'] = '*';
      await route.fulfill({ status: res.status, headers, body });
    } catch (e) {
      await route.abort('failed');
    }
  });
  return async (v) => {
    state.offline = v;
    for (const p of ctx.pages()) {
      await p.evaluate((v) => {
        window.__offline = v;
        window.dispatchEvent(new Event(v ? 'offline' : 'online'));
      }, v);
    }
  };
}
