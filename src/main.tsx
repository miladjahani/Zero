import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { AuthProvider } from './lib/auth'

// HashRouter (not BrowserRouter) is used intentionally: this app is built to
// be deployed both on GitHub Pages (served from a repo sub-path, e.g.
// /miliconfig-pro/) and on Cloudflare Workers Static Assets. Neither host is
// guaranteed to rewrite unknown deep-link paths back to index.html, which
// causes a hard 404 on refresh/direct-link with a path-based router. Hash
// routing (/#/tokens instead of /tokens) never touches the actual request
// path, so it works identically — with zero server-side rewrite rules — on
// GitHub Pages, Cloudflare Workers, Cloudflare Pages, or any plain static host.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </HashRouter>
  </React.StrictMode>,
)

// PWA: register the service worker (production only, never blocks startup).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => null)
  })
}
