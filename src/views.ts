// Server-rendered HTML. No external CDN (runs on an internal-only network).
export function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root{--bg:#0f1419;--panel:#1a212b;--line:#2b3543;--fg:#e6edf3;--muted:#8b98a9;
--accent:#3b82f6;--danger:#ef4444;--ok:#22c55e;--warn:#f59e0b;}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif;
background:var(--bg);color:var(--fg)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--panel);border-bottom:1px solid var(--line);padding:10px 18px;
display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header .brand{font-weight:700}header nav{display:flex;gap:14px;flex-wrap:wrap}
header .sp{margin-left:auto;color:var(--muted)}
main{max-width:1100px;margin:0 auto;padding:20px 18px}
h1,h2,h3{line-height:1.2}h2{border-bottom:1px solid var(--line);padding-bottom:6px;margin-top:30px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;margin:14px 0}
table{border-collapse:collapse;width:100%;margin:8px 0;font-size:13px}
th,td{border:1px solid var(--line);padding:6px 9px;text-align:left;vertical-align:top}
th{background:#141b24;color:var(--muted);font-weight:600}
.badge{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:600}
.b-ok{background:rgba(34,197,94,.15);color:var(--ok)}.b-warn{background:rgba(245,158,11,.15);color:var(--warn)}
.b-danger{background:rgba(239,68,68,.15);color:var(--danger)}.b-muted{background:rgba(139,152,169,.15);color:var(--muted)}
.b-info{background:rgba(59,130,246,.15);color:var(--accent)}
input,select,textarea,button{font:inherit}
input,select,textarea{background:#0c1117;border:1px solid var(--line);color:var(--fg);
border-radius:6px;padding:7px 9px;width:100%}
label{display:block;margin:10px 0 3px;color:var(--muted);font-size:12px}
.btn{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:6px;
padding:8px 14px;cursor:pointer;font-weight:600;width:auto}
.btn:hover{filter:brightness(1.1)}.btn.danger{background:var(--danger)}
.btn.ghost{background:transparent;border:1px solid var(--line);color:var(--fg)}
.row{display:flex;gap:14px;flex-wrap:wrap}.row>*{flex:1;min-width:220px}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.warnbox{background:rgba(239,68,68,.08);border:1px solid var(--danger);border-radius:8px;padding:12px;margin:12px 0}
.okbox{background:rgba(34,197,94,.08);border:1px solid var(--ok);border-radius:8px;padding:12px;margin:12px 0}
pre{background:#0c1117;border:1px solid var(--line);border-radius:6px;padding:10px;overflow:auto;font-size:12px}
.flash{padding:10px 14px;border-radius:6px;margin:10px 0}
small{color:var(--muted)}
`;

const NAV = [
  ['/', 'Dashboard'],
  ['/workspaces', 'Workspaces'],
  ['/accounts', 'Accounts'],
  ['/create', 'Create'],
  ['/import', 'Bulk CSV'],
  ['/delete', 'Delete'],
  ['/audit', 'Audit log'],
];

export function layout(title: string, body: string, opts: { active?: string; admin?: string } = {}): string {
  const nav = NAV.map(
    ([href, label]) =>
      `<a href="${href}"${opts.active === href ? ' style="color:#fff;text-decoration:underline"' : ''}>${label}</a>`,
  ).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Postiz Admin Console</title><style>${STYLE}</style></head>
<body><header><span class="brand">⚙ Postiz Admin</span><nav>${nav}</nav>
<span class="sp">${opts.admin ? `${esc(opts.admin)} · <a href="/logout" onclick="event.preventDefault();document.getElementById('lo').submit()">logout</a><form id="lo" method="post" action="/logout" style="display:none"></form>` : ''}</span>
</header><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

export function loginPage(error?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Login · Postiz Admin</title>
<style>${STYLE}</style></head><body><main style="max-width:360px;margin-top:12vh">
<h1>Postiz Admin Console</h1>
<div class="warnbox">Internal tool. Never expose this to the public internet.</div>
${error ? `<div class="flash" style="background:rgba(239,68,68,.15);color:#fff">${esc(error)}</div>` : ''}
<form method="post" action="/login" class="panel">
<label>Username</label><input name="username" autofocus autocomplete="username">
<label>Password</label><input name="password" type="password" autocomplete="current-password">
<div style="margin-top:14px"><button class="btn">Sign in</button></div>
</form></main></body></html>`;
}

export function badge(text: string, kind: 'ok' | 'warn' | 'danger' | 'muted' | 'info' = 'muted'): string {
  return `<span class="badge b-${kind}">${esc(text)}</span>`;
}
