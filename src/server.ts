import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';

import { loadConfig } from './config';
import { initPool } from './db';
import { initAudit, audit, readAudit } from './audit';
import { initAuth, checkLogin, setSession, clearSession, isAuthed, adminName } from './auth';
import {
  listWorkspaces, listAccounts, healthChecks, listOrganizationsForSelect,
  organizationExists, workspaceDeletePreflight, accountDeletePreflight,
} from './health';
import {
  addMembersToWorkspace, createWorkspaceWithOwner, createAndPopulate,
  changeRole, removeMember, bulkImportMembers, bulkCreateWorkspaces,
  isRole, ROLES, Role, NewMember, LastSuperadminError,
} from './creation';
import { parseCsv, diffMembers, diffWorkspaces, asRole } from './csv';
import { runDelete } from './deleteEngine';
import { backup } from './backup';
import { mint, consume } from './tokens';
import { layout, loginPage, esc, badge } from './views';

const cfg = loadConfig();
initPool(cfg);
initAudit(cfg);
initAuth(cfg);

const app = Fastify({ bodyLimit: 8 * 1024 * 1024 });
app.register(cookie, { secret: cfg.sessionSecret });
app.register(formbody);
app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024 } });

// ── auth gate ────────────────────────────────────────────────────────────────
const OPEN = new Set(['/login', '/healthz']);
app.addHook('preHandler', async (req, reply) => {
  if (OPEN.has(req.url.split('?')[0])) return;
  if (!isAuthed(req)) { reply.redirect('/login'); return reply; }
});

function page(title: string, body: string, active?: string) {
  return layout(title, body, { active, admin: adminName() });
}

// ── helpers ──────────────────────────────────────────────────────────────────
function credentialsCsv(rows: { workspace: string; name: string; email: string; password: string }[]): string {
  const q = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
  const head = 'workspace,name,email,password';
  const body = rows.map((r) => [r.workspace, r.name, r.email, r.password].map(q).join(',')).join('\n');
  return `${head}\n${body}\n`;
}
function downloadLink(csv: string, filename: string): string {
  const b64 = Buffer.from(csv, 'utf8').toString('base64');
  return `<a class="btn" download="${esc(filename)}" href="data:text/csv;base64,${b64}">⬇ Download credentials CSV</a>`;
}
function credentialsTable(rows: { workspace: string; name: string; email: string; password: string }[]): string {
  if (!rows.length) return '';
  return `<div class="okbox"><strong>Credentials — shown once, not stored anywhere.</strong>
  <table><tr><th>Workspace</th><th>Name</th><th>Email</th><th>Password</th></tr>
  ${rows.map((r) => `<tr><td>${esc(r.workspace)}</td><td>${esc(r.name)}</td><td>${esc(r.email)}</td><td class="mono">${esc(r.password)}</td></tr>`).join('')}
  </table><div style="margin-top:8px">${downloadLink(credentialsCsv(rows), 'postiz-credentials.csv')}</div></div>`;
}

// ── login ────────────────────────────────────────────────────────────────────
app.get('/login', async (req, reply) => {
  if (isAuthed(req)) return reply.redirect('/');
  reply.type('text/html').send(loginPage());
});
app.post('/login', async (req, reply) => {
  const { username = '', password = '' } = (req.body || {}) as Record<string, string>;
  if (checkLogin(username, password)) {
    setSession(reply);
    audit({ admin: username, action: 'login', ok: true });
    return reply.redirect('/');
  }
  audit({ admin: username || '?', action: 'login', ok: false, error: 'bad credentials' });
  reply.code(401).type('text/html').send(loginPage('Invalid username or password.'));
});
app.post('/logout', async (req, reply) => {
  clearSession(reply);
  reply.redirect('/login');
});
app.get('/healthz', async () => ({ ok: true }));

// ── dashboard ────────────────────────────────────────────────────────────────
function healthPanel(h: Awaited<ReturnType<typeof healthChecks>>): string {
  const sec = (title: string, kind: 'ok' | 'warn' | 'danger', count: number, inner: string) =>
    `<div class="panel"><h3>${esc(title)} ${badge(String(count), count ? kind : 'ok')}</h3>${count ? inner : '<small>None ✓</small>'}</div>`;
  return `<div class="row">
  ${sec('Workspaces with no SUPERADMIN', 'danger', h.noSuperadmin.length,
    `<table><tr><th>Name</th><th>id</th></tr>${h.noSuperadmin.map((r) => `<tr><td>${esc(r.name)}</td><td class="mono">${esc(r.id)}</td></tr>`).join('')}</table>`)}
  ${sec('Orphaned accounts (0 memberships)', 'warn', h.orphanAccounts.length,
    `<table><tr><th>Email</th><th>Provider</th><th>Activated</th></tr>${h.orphanAccounts.map((r) => `<tr><td>${esc(r.email)}</td><td>${esc(r.provider)}</td><td>${r.activated ? 'yes' : 'no'}</td></tr>`).join('')}</table>`)}
  </div><div class="row">
  ${sec('Duplicate workspace names', 'warn', h.duplicateNames.length,
    `<table><tr><th>Name</th><th>Copies</th><th>ids</th></tr>${h.duplicateNames.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.copies}</td><td class="mono">${esc(r.ids)}</td></tr>`).join('')}</table>`)}
  ${sec('Shared accounts (>1 workspace)', 'info' as 'warn', h.sharedAccounts.length,
    `<table><tr><th>Email</th><th>Workspaces</th><th>Roles</th></tr>${h.sharedAccounts.map((r) => `<tr><td>${esc(r.email)}</td><td>${r.workspaces}</td><td>${esc(r.roles)}</td></tr>`).join('')}</table>`)}
  </div>`;
}

app.get('/', async (_req, reply) => {
  const [ws, accts, h] = await Promise.all([listWorkspaces(), listAccounts(), healthChecks()]);
  const body = `
  <div class="row">
    <div class="panel"><h3>${ws.length}</h3><small>Workspaces</small></div>
    <div class="panel"><h3>${accts.length}</h3><small>Accounts</small></div>
    <div class="panel"><h3>${ws.reduce((a, w) => a + w.channels, 0)}</h3><small>Connected channels</small></div>
    <div class="panel"><h3>${ws.reduce((a, w) => a + w.posts, 0)}</h3><small>Posts</small></div>
  </div>
  <h2>Health checks</h2>${healthPanel(h)}`;
  reply.type('text/html').send(page('Dashboard', body, '/'));
});

// ── workspaces ───────────────────────────────────────────────────────────────
app.get('/workspaces', async (_req, reply) => {
  const ws = await listWorkspaces();
  const rows = ws.map((w) => `<tr>
    <td>${esc(w.name)} ${w.duplicateName ? badge('dup', 'warn') : ''} ${w.emptyShell ? badge('empty', 'muted') : ''}</td>
    <td class="mono">${esc(w.id)}</td><td>${w.members}</td><td>${w.channels}</td><td>${w.posts}</td>
    <td>${w.superadmins.length ? w.superadmins.map(esc).join('<br>') : badge('NONE', 'danger')}</td>
    <td><a href="/workspaces/${esc(w.id)}">manage</a></td></tr>`).join('');
  const body = `<div class="panel"><table>
    <tr><th>Name</th><th>id</th><th>Members</th><th>Channels</th><th>Posts</th><th>SUPERADMIN(s)</th><th></th></tr>
    ${rows || '<tr><td colspan="7"><small>No workspaces.</small></td></tr>'}</table></div>`;
  reply.type('text/html').send(page('Workspaces', body, '/workspaces'));
});

app.get<{ Params: { id: string } }>('/workspaces/:id', async (req, reply) => {
  const orgId = req.params.id;
  if (!(await organizationExists(orgId))) { reply.code(404).type('text/html').send(page('Not found', '<div class="warnbox">No such workspace.</div>')); return; }
  const pf = await workspaceDeletePreflight([orgId]);
  const roster = pf.roster.filter((r) => r.org_id === orgId);
  const name = roster[0]?.org_name || '(unknown)';
  const rows = roster.map((r) => `<tr><td>${esc(r.email)}</td><td>
    <form method="post" action="/member/role" style="display:flex;gap:6px;align-items:center">
      <input type="hidden" name="orgId" value="${esc(orgId)}"><input type="hidden" name="userId" value="${esc(r.user_id)}">
      <select name="role" style="width:auto">${ROLES.map((ro) => `<option ${ro === r.role ? 'selected' : ''}>${ro}</option>`).join('')}</select>
      <button class="btn ghost">Save</button>
      <label style="margin:0"><input type="checkbox" name="override" style="width:auto"> override last-SA</label>
    </form></td>
    <td><form method="post" action="/member/remove" onsubmit="return confirm('Remove ${esc(r.email)} from this workspace?')">
      <input type="hidden" name="orgId" value="${esc(orgId)}"><input type="hidden" name="userId" value="${esc(r.user_id)}">
      <label style="margin:0 0 4px"><input type="checkbox" name="override" style="width:auto"> override</label>
      <button class="btn danger">Remove</button></form></td></tr>`).join('');
  const body = `<p><a href="/workspaces">← all workspaces</a></p>
  <div class="panel"><h3>${esc(name)}</h3><div class="mono">${esc(orgId)}</div>
  <table><tr><th>Email</th><th>Role</th><th></th></tr>${rows || '<tr><td colspan="3"><small>No members.</small></td></tr>'}</table></div>
  <div class="panel"><h3>Add members</h3>${addMembersForm(orgId)}</div>`;
  reply.type('text/html').send(page('Manage workspace', body, '/workspaces'));
});

app.post('/member/role', async (req, reply) => {
  const { orgId, userId, role, override } = (req.body || {}) as Record<string, string>;
  if (!isRole(role)) { reply.code(400).send('bad role'); return; }
  try {
    const r = await changeRole(orgId, userId, role as Role, override === 'on');
    audit({ admin: adminName(), action: 'change-role', targets: { orgId, userId, role }, rowCounts: { updated: r.updated ? 1 : 0 }, ok: true });
    reply.redirect(`/workspaces/${orgId}`);
  } catch (e) {
    const last = e instanceof LastSuperadminError;
    audit({ admin: adminName(), action: 'change-role', targets: { orgId, userId, role }, ok: false, error: (e as Error).message });
    reply.code(last ? 409 : 500).type('text/html').send(page('Blocked', `<div class="warnbox">${esc((e as Error).message)}</div><p><a href="/workspaces/${esc(orgId)}">back</a></p>`));
  }
});

app.post('/member/remove', async (req, reply) => {
  const { orgId, userId, override } = (req.body || {}) as Record<string, string>;
  try {
    const r = await removeMember(orgId, userId, override === 'on');
    audit({ admin: adminName(), action: 'remove-member', targets: { orgId, userId }, rowCounts: { removed: r.removed ? 1 : 0 }, ok: true });
    reply.redirect(`/workspaces/${orgId}`);
  } catch (e) {
    const last = e instanceof LastSuperadminError;
    audit({ admin: adminName(), action: 'remove-member', targets: { orgId, userId }, ok: false, error: (e as Error).message });
    reply.code(last ? 409 : 500).type('text/html').send(page('Blocked', `<div class="warnbox">${esc((e as Error).message)}</div><p><a href="/workspaces/${esc(orgId)}">back</a></p>`));
  }
});

// ── accounts ─────────────────────────────────────────────────────────────────
app.get('/accounts', async (_req, reply) => {
  const accts = await listAccounts();
  const rows = accts.map((a) => `<tr>
    <td>${esc(a.email)} ${a.orphan ? badge('orphan', 'warn') : ''} ${a.shared ? badge('shared', 'info') : ''}</td>
    <td>${esc(a.provider)}</td><td>${a.activated ? 'yes' : 'no'}</td><td>${a.memberships}</td>
    <td>${a.workspaces.map((w) => `${esc(w.name)}:${esc(w.role)}`).join('<br>') || '<small>—</small>'}</td></tr>`).join('');
  const body = `<div class="panel"><table>
    <tr><th>Email</th><th>Provider</th><th>Activated</th><th>Memberships</th><th>Workspace : role</th></tr>
    ${rows || '<tr><td colspan="5"><small>No accounts.</small></td></tr>'}</table></div>`;
  reply.type('text/html').send(page('Accounts', body, '/accounts'));
});

// ── creation (A/B/C) ─────────────────────────────────────────────────────────
function membersInputs(): string {
  return `<table id="mtab"><tr><th>Email</th><th>Name</th><th>Role</th></tr>
  ${[0, 1, 2].map(() => `<tr>
    <td><input name="email"></td><td><input name="name"></td>
    <td><select name="role" style="width:auto">${ROLES.map((r) => `<option ${r === 'USER' ? 'selected' : ''}>${r}</option>`).join('')}</select></td></tr>`).join('')}
  </table><small>Empty rows are ignored. Passwords are generated automatically for new accounts.</small>`;
}
function addMembersForm(orgId: string): string {
  return `<form method="post" action="/create/members">
  <input type="hidden" name="orgId" value="${esc(orgId)}">${membersInputs()}
  <div style="margin-top:10px"><button class="btn">Add members</button></div></form>`;
}

app.get('/create', async (_req, reply) => {
  const orgs = await listOrganizationsForSelect();
  const opts = orgs.map((o) => `<option value="${esc(o.id)}">${esc(o.name)} — ${esc(o.id)} (${o.members} members)</option>`).join('');
  const tokB = mint('create-workspace');
  const tokC = mint('create-populate');
  const body = `
  <div class="panel"><h2 style="margin-top:0">A · Add accounts to an existing workspace</h2>
  <form method="post" action="/create/members">
  <label>Workspace</label><select name="orgId" style="width:auto;max-width:100%">${opts || '<option disabled>no workspaces yet</option>'}</select>
  ${membersInputs()}<div style="margin-top:10px"><button class="btn">Add members</button></div></form></div>

  <div class="panel"><h2 style="margin-top:0">B · Create workspace + owner</h2>
  <form method="post" action="/create/workspace"><input type="hidden" name="token" value="${tokB}">
  <div class="row"><div><label>Workspace name</label><input name="workspaceName"></div>
  <div><label>Owner email</label><input name="ownerEmail"></div></div>
  <div class="row"><div><label>Owner name</label><input name="ownerName"></div>
  <div><label>Owner password <small>(blank = generate)</small></label><input name="ownerPassword"></div></div>
  <div style="margin-top:10px"><button class="btn">Create workspace</button></div></form></div>

  <div class="panel"><h2 style="margin-top:0">C · Create workspace + populate</h2>
  <form method="post" action="/create/populate"><input type="hidden" name="token" value="${tokC}">
  <div class="row"><div><label>Workspace name</label><input name="workspaceName"></div>
  <div><label>Owner email</label><input name="ownerEmail"></div></div>
  <div class="row"><div><label>Owner name</label><input name="ownerName"></div>
  <div><label>Owner password <small>(blank = generate)</small></label><input name="ownerPassword"></div></div>
  <h3>Members</h3>${membersInputs()}
  <div style="margin-top:10px"><button class="btn">Create + populate</button></div></form></div>`;
  reply.type('text/html').send(page('Create', body, '/create'));
});

// Collect repeated email/name/role inputs into member objects (skip blanks).
function collectMembers(body: Record<string, unknown>): NewMember[] {
  const emails = ([] as string[]).concat((body.email as string[]) || []);
  const names = ([] as string[]).concat((body.name as string[]) || []);
  const roles = ([] as string[]).concat((body.role as string[]) || []);
  const out: NewMember[] = [];
  for (let i = 0; i < emails.length; i++) {
    const email = (emails[i] || '').trim();
    if (!email) continue;
    const role = (roles[i] || 'USER').toUpperCase();
    out.push({ email, name: (names[i] || '').trim() || email, role: (isRole(role) ? role : 'USER') as Role });
  }
  return out;
}

app.post('/create/members', async (req, reply) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const orgId = String(body.orgId || '');
  if (!(await organizationExists(orgId))) { reply.code(400).type('text/html').send(page('Error', '<div class="warnbox">Pick a valid workspace.</div>')); return; }
  const members = collectMembers(body);
  if (!members.length) { reply.type('text/html').send(page('Nothing to do', '<div class="warnbox">No members entered.</div><p><a href="/create">back</a></p>')); return; }
  const res = await addMembersToWorkspace(orgId, members);
  audit({ admin: adminName(), action: 'add-members', targets: { orgId, count: members.length }, rowCounts: { added: res.filter((r) => r.membershipStatus === 'added').length }, ok: true });
  const orgName = (await workspaceDeletePreflight([orgId])).roster[0]?.org_name || orgId;
  const creds = res.filter((r) => r.password).map((r) => ({ workspace: orgName, name: r.name, email: r.email, password: r.password! }));
  const summary = res.map((r) => `<tr><td>${esc(r.email)}</td><td>${esc(r.role)}</td><td>${badge(r.accountStatus, r.accountStatus === 'new' ? 'ok' : 'muted')}</td><td>${badge(r.membershipStatus, r.membershipStatus === 'added' ? 'ok' : 'muted')}</td></tr>`).join('');
  reply.type('text/html').send(page('Members added',
    `<div class="panel"><table><tr><th>Email</th><th>Role</th><th>Account</th><th>Membership</th></tr>${summary}</table></div>${credentialsTable(creds)}<p><a href="/workspaces/${esc(orgId)}">manage workspace</a></p>`));
});

app.post('/create/workspace', async (req, reply) => {
  const body = (req.body || {}) as Record<string, string>;
  if (!consume(body.token).ok) { reply.code(409).type('text/html').send(page('Expired', '<div class="warnbox">This form was already submitted or expired. <a href="/create">Start again</a>.</div>')); return; }
  if (!body.workspaceName?.trim() || !body.ownerEmail?.trim()) { reply.code(400).type('text/html').send(page('Error', '<div class="warnbox">Workspace name and owner email are required.</div>')); return; }
  const r = await createWorkspaceWithOwner({
    workspaceName: body.workspaceName, ownerEmail: body.ownerEmail,
    ownerName: body.ownerName?.trim() || body.ownerEmail, ownerPassword: body.ownerPassword?.trim() || undefined,
  });
  audit({ admin: adminName(), action: 'create-workspace', targets: { orgId: r.orgId, name: r.workspaceName, owner: r.ownerEmail }, ok: true });
  const creds = r.password ? [{ workspace: r.workspaceName, name: r.ownerName, email: r.ownerEmail, password: r.password }] : [];
  reply.type('text/html').send(page('Workspace created',
    `<div class="okbox">Created <strong>${esc(r.workspaceName)}</strong><br><span class="mono">${esc(r.orgId)}</span><br>Owner ${esc(r.ownerEmail)} (${esc(r.accountStatus)})</div>${credentialsTable(creds)}<p><a href="/workspaces/${esc(r.orgId)}">manage</a> · <a href="/create">create another</a></p>`));
});

app.post('/create/populate', async (req, reply) => {
  const body = (req.body || {}) as Record<string, unknown>;
  if (!consume(String(body.token || '')).ok) { reply.code(409).type('text/html').send(page('Expired', '<div class="warnbox">This form was already submitted or expired. <a href="/create">Start again</a>.</div>')); return; }
  const wsName = String(body.workspaceName || '').trim();
  const ownerEmail = String(body.ownerEmail || '').trim();
  if (!wsName || !ownerEmail) { reply.code(400).type('text/html').send(page('Error', '<div class="warnbox">Workspace name and owner email are required.</div>')); return; }
  const members = collectMembers(body);
  const r = await createAndPopulate(
    { workspaceName: wsName, ownerEmail, ownerName: String(body.ownerName || '').trim() || ownerEmail, ownerPassword: String(body.ownerPassword || '').trim() || undefined },
    members,
  );
  audit({ admin: adminName(), action: 'create-populate', targets: { orgId: r.workspace.orgId, name: wsName, members: members.length }, ok: true });
  const creds = [
    ...(r.workspace.password ? [{ workspace: wsName, name: r.workspace.ownerName, email: r.workspace.ownerEmail, password: r.workspace.password }] : []),
    ...r.members.filter((m) => m.password).map((m) => ({ workspace: wsName, name: m.name, email: m.email, password: m.password! })),
  ];
  reply.type('text/html').send(page('Created + populated',
    `<div class="okbox">Created <strong>${esc(wsName)}</strong> <span class="mono">${esc(r.workspace.orgId)}</span> with ${r.members.length} member(s).</div>${credentialsTable(creds)}<p><a href="/workspaces/${esc(r.workspace.orgId)}">manage</a></p>`));
});

// ── bulk CSV ─────────────────────────────────────────────────────────────────
app.get('/import', async (_req, reply) => {
  const body = `
  <div class="panel"><h2 style="margin-top:0">members.csv</h2>
  <p class="muted">Header: <span class="mono">email,password,name,org_id,role</span>. Idempotent. Blank password ⇒ generated.</p>
  <form method="post" action="/import/members" enctype="multipart/form-data">
  <input type="file" name="file" accept=".csv,text/csv"><div style="margin-top:10px"><button class="btn">Dry-run diff</button></div></form></div>
  <div class="panel"><h2 style="margin-top:0">workspaces.csv</h2>
  <p class="muted">Header: <span class="mono">workspace_name,owner_email,owner_password,owner_name</span>. Not idempotent (names aren't unique).</p>
  <form method="post" action="/import/workspaces" enctype="multipart/form-data">
  <input type="file" name="file" accept=".csv,text/csv"><div style="margin-top:10px"><button class="btn">Dry-run diff</button></div></form></div>`;
  reply.type('text/html').send(page('Bulk CSV', body, '/import'));
});

async function readUpload(req: any): Promise<string> {
  const f = await req.file();
  if (!f) throw new Error('No file uploaded.');
  const buf = await f.toBuffer();
  return buf.toString('utf8');
}

app.post('/import/members', async (req, reply) => {
  let text: string;
  try { text = await readUpload(req); } catch (e) { reply.code(400).type('text/html').send(page('Error', `<div class="warnbox">${esc((e as Error).message)}</div>`)); return; }
  const records = parseCsv(text);
  const diff = await diffMembers(records);
  const rows = diff.rows.map((r) => `<tr>
    <td>${r.line}</td><td>${esc(r.email)}</td><td>${esc(r.orgId)}</td><td>${esc(r.role)}</td>
    <td>${r.accountClass ? badge(r.accountClass, r.accountClass === 'new-account' ? 'ok' : 'muted') : ''} ${r.membershipClass ? badge(r.membershipClass, r.membershipClass === 'add-membership' ? 'ok' : 'muted') : ''}</td>
    <td>${r.errors.length ? badge(r.errors.join('; '), 'danger') : '✓'}</td></tr>`).join('');
  const tok = diff.valid ? mint({ kind: 'members', records }) : '';
  const body = `<div class="panel"><table><tr><th>Line</th><th>Email</th><th>org_id</th><th>Role</th><th>Plan</th><th>Validation</th></tr>${rows}</table></div>
  ${diff.valid
    ? `<form method="post" action="/import/members/confirm"><input type="hidden" name="token" value="${tok}">
       <div class="okbox">${diff.rows.length} row(s) valid. Executes in one transaction.<div style="margin-top:8px"><button class="btn">Confirm import</button></div></div></form>`
    : '<div class="warnbox">Validation errors present — fix the CSV and re-upload. Nothing was executed.</div>'}
  <p><a href="/import">← back</a></p>`;
  reply.type('text/html').send(page('members.csv dry-run', body, '/import'));
});

app.post('/import/members/confirm', async (req, reply) => {
  const { token } = (req.body || {}) as Record<string, string>;
  const c = consume(token);
  if (!c.ok) { reply.code(409).type('text/html').send(page('Expired', '<div class="warnbox">Preview expired — re-run the dry-run. <a href="/import">back</a></div>')); return; }
  const records = (c.meta as any).records as Record<string, string>[];
  const rows = records.map((r) => ({ email: r.email, name: r.name || r.email, orgId: (r.org_id || '').trim(), role: asRole(r.role), password: (r.password || '').trim() || undefined }));
  const res = await bulkImportMembers(rows);
  audit({ admin: adminName(), action: 'bulk-members', targets: { count: rows.length }, rowCounts: { added: res.filter((r) => r.membershipStatus === 'added').length }, ok: true });
  const creds = res.filter((r) => r.password).map((r) => ({ workspace: '(see org_id)', name: r.name, email: r.email, password: r.password! }));
  reply.type('text/html').send(page('Import complete', `<div class="okbox">Imported ${res.length} membership row(s).</div>${credentialsTable(creds)}<p><a href="/accounts">accounts</a></p>`));
});

app.post('/import/workspaces', async (req, reply) => {
  let text: string;
  try { text = await readUpload(req); } catch (e) { reply.code(400).type('text/html').send(page('Error', `<div class="warnbox">${esc((e as Error).message)}</div>`)); return; }
  const records = parseCsv(text);
  const diff = await diffWorkspaces(records);
  const rows = diff.rows.map((r) => `<tr><td>${r.line}</td><td>${esc(r.workspaceName)}</td><td>${esc(r.ownerEmail)}</td>
    <td>${r.ownerClass ? badge(r.ownerClass, r.ownerClass === 'new-account' ? 'ok' : 'muted') : ''}</td>
    <td>${r.errors.length ? badge(r.errors.join('; '), 'danger') : '✓'}</td></tr>`).join('');
  const tok = diff.valid ? mint({ kind: 'workspaces', records }) : '';
  const body = `<div class="panel"><table><tr><th>Line</th><th>Workspace</th><th>Owner</th><th>Owner account</th><th>Validation</th></tr>${rows}</table></div>
  ${diff.valid
    ? `<form method="post" action="/import/workspaces/confirm"><input type="hidden" name="token" value="${tok}">
       <div class="okbox">${diff.rows.length} workspace(s) will be created (one transaction).<div style="margin-top:8px"><button class="btn">Confirm import</button></div></div></form>`
    : '<div class="warnbox">Validation errors present — fix the CSV and re-upload.</div>'}
  <p><a href="/import">← back</a></p>`;
  reply.type('text/html').send(page('workspaces.csv dry-run', body, '/import'));
});

app.post('/import/workspaces/confirm', async (req, reply) => {
  const { token } = (req.body || {}) as Record<string, string>;
  const c = consume(token);
  if (!c.ok) { reply.code(409).type('text/html').send(page('Expired', '<div class="warnbox">Preview expired — re-run the dry-run. <a href="/import">back</a></div>')); return; }
  const records = (c.meta as any).records as Record<string, string>[];
  const rows = records.map((r) => ({ workspaceName: r.workspace_name, ownerEmail: r.owner_email, ownerName: r.owner_name || r.owner_email, ownerPassword: (r.owner_password || '').trim() || undefined }));
  const res = await bulkCreateWorkspaces(rows);
  audit({ admin: adminName(), action: 'bulk-workspaces', targets: { count: rows.length }, ok: true });
  const creds = res.filter((r) => r.password).map((r) => ({ workspace: r.workspaceName, name: r.ownerName, email: r.ownerEmail, password: r.password! }));
  reply.type('text/html').send(page('Import complete', `<div class="okbox">Created ${res.length} workspace(s).</div>${credentialsTable(creds)}<p><a href="/workspaces">workspaces</a></p>`));
});

// ── delete (preview → backup → confirm) ──────────────────────────────────────
app.get('/delete', async (_req, reply) => {
  const [ws, accts] = await Promise.all([listWorkspaces(), listAccounts()]);
  const wsRows = ws.map((w) => `<tr><td><input type="checkbox" name="orgIds" value="${esc(w.id)}" style="width:auto"></td>
    <td>${esc(w.name)}</td><td class="mono">${esc(w.id)}</td><td>${w.members}/${w.channels}/${w.posts}</td></tr>`).join('');
  const acRows = accts.map((a) => `<tr><td><input type="checkbox" name="userIds" value="${esc(a.id)}" style="width:auto"></td>
    <td>${esc(a.email)}</td><td>${a.memberships}</td><td>${a.shared ? badge('shared', 'info') : ''}</td></tr>`).join('');
  const body = `<form method="post" action="/delete/preview">
  <div class="warnbox"><strong>Destructive.</strong> Deleting a workspace destroys its connected social-account tokens (Integration rows) with no OAuth revocation. A backup runs automatically before any delete.</div>
  <div class="panel"><h2 style="margin-top:0">Workspaces</h2>
  <table><tr><th></th><th>Name</th><th>id</th><th>mem/chan/posts</th></tr>${wsRows || '<tr><td colspan="4"><small>none</small></td></tr>'}</table>
  <label style="margin-top:10px"><input type="checkbox" name="cascade" style="width:auto"> Also delete accounts whose <em>sole</em> membership is a deleted workspace (never shared accounts) — SPEC Sec 7 toggle. Default policy: <strong>${esc(cfg.orphanPolicy)}</strong></label></div>
  <div class="panel"><h2 style="margin-top:0">Accounts</h2>
  <table><tr><th></th><th>Email</th><th>Memberships</th><th></th></tr>${acRows || '<tr><td colspan="4"><small>none</small></td></tr>'}</table></div>
  <button class="btn danger">Preview deletion</button></form>`;
  reply.type('text/html').send(page('Delete', body, '/delete'));
});

function asArray(v: unknown): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map(String).filter(Boolean);
}

app.post('/delete/preview', async (req, reply) => {
  const body = (req.body || {}) as Record<string, unknown>;
  const orgIds = asArray(body.orgIds);
  const userIds = asArray(body.userIds);
  const cascade = body.cascade === 'on' || cfg.orphanPolicy === 'cascade';
  if (!orgIds.length && !userIds.length) { reply.type('text/html').send(page('Nothing selected', '<div class="warnbox">Select at least one workspace or account.</div><p><a href="/delete">back</a></p>')); return; }

  const [wsPf, acPf, dry] = await Promise.all([
    orgIds.length ? workspaceDeletePreflight(orgIds) : Promise.resolve({ roster: [], wouldOrphan: [] }),
    userIds.length ? accountDeletePreflight(userIds) : Promise.resolve({ memberships: [], losingLastSuperadmin: [] }),
    runDelete({ orgIds, userIds, cascadeOrphans: cascade, dryRun: true }),
  ]);

  const planRows = dry.steps.filter((s) => s.rows > 0 || s.kind === 'delete').map((s) =>
    `<tr><td>${esc(s.kind)}</td><td>${esc(s.table)}${s.column ? '.' + esc(s.column) : ''}</td><td>${s.rows}</td></tr>`).join('');
  const lastSa = acPf.losingLastSuperadmin;
  const tok = mint({ orgIds, userIds, cascade });
  const names = [
    ...wsPf.roster.filter((r, i, a) => a.findIndex((x) => x.org_id === r.org_id) === i).map((r) => r.org_name),
    ...acPf.memberships.filter((r, i, a) => a.findIndex((x) => x.user_id === r.user_id) === i).map((r) => r.email),
  ];
  const html = `
  ${lastSa.length ? `<div class="warnbox">⚠ These workspaces would lose their <strong>last SUPERADMIN</strong>: ${lastSa.map((s) => esc(s.name)).join(', ')}. Proceeding leaves them unadministrable.</div>` : ''}
  ${cascade && dry.cascadedUserIds.length ? `<div class="warnbox">Cascade will additionally delete ${dry.cascadedUserIds.length} now-orphaned account(s).</div>` : ''}
  ${orgIds.length ? `<div class="panel"><h3>Workspaces to delete (${orgIds.length})</h3>
    <table><tr><th>Workspace</th><th>Member</th><th>Role</th></tr>${wsPf.roster.map((r) => `<tr><td>${esc(r.org_name)}</td><td>${esc(r.email)}</td><td>${esc(r.role)}</td></tr>`).join('') || '<tr><td colspan=3><small>no members</small></td></tr>'}</table>
    ${wsPf.wouldOrphan.length ? `<p class="muted">Members dropping to <strong>zero memberships</strong>: ${wsPf.wouldOrphan.map((o) => esc(o.email)).join(', ')} ${cascade ? '(will be cascade-deleted)' : '(left as orphans)'}.</p>` : ''}</div>` : ''}
  ${userIds.length ? `<div class="panel"><h3>Accounts to delete (${userIds.length})</h3>
    <table><tr><th>Email</th><th>Workspace</th><th>Role</th></tr>${acPf.memberships.map((r) => `<tr><td>${esc(r.email)}</td><td>${esc(r.org_name)}</td><td>${esc(r.role)}</td></tr>`).join('') || '<tr><td colspan=3><small>no memberships</small></td></tr>'}</table></div>` : ''}
  <div class="panel"><h3>Predicted row deletions (dry-run, rolled back)</h3>
    <table><tr><th>Op</th><th>Table</th><th>Rows</th></tr>${planRows}</table>
    <p><strong>Total rows: ${dry.totalRows}</strong></p></div>
  <form method="post" action="/delete/confirm"><input type="hidden" name="token" value="${tok}">
    <div class="warnbox">Type the exact name(s)/email(s) to confirm: <span class="mono">${names.map(esc).join(' , ')}</span>
    <label>Confirmation</label><input name="confirm" placeholder="${esc(names.join(' , '))}" autocomplete="off">
    <div style="margin-top:10px"><button class="btn danger">Backup &amp; delete</button> <a class="btn ghost" href="/delete">cancel</a></div></div>
  </form>`;
  reply.type('text/html').send(page('Confirm deletion', html, '/delete'));
});

app.post('/delete/confirm', async (req, reply) => {
  const body = (req.body || {}) as Record<string, string>;
  const c = consume(body.token);
  if (!c.ok) { reply.code(409).type('text/html').send(page('Expired', '<div class="warnbox">Preview expired — start the deletion again. <a href="/delete">back</a></div>')); return; }
  const meta = c.meta as { orgIds: string[]; userIds: string[]; cascade: boolean };

  // Re-derive the expected confirmation names and require an exact-set match.
  const [wsPf, acPf] = await Promise.all([
    meta.orgIds.length ? workspaceDeletePreflight(meta.orgIds) : Promise.resolve({ roster: [], wouldOrphan: [] }),
    meta.userIds.length ? accountDeletePreflight(meta.userIds) : Promise.resolve({ memberships: [], losingLastSuperadmin: [] }),
  ]);
  const expected = new Set<string>([
    ...wsPf.roster.map((r) => r.org_name),
    ...acPf.memberships.map((r) => r.email),
  ]);
  const typed = new Set((body.confirm || '').split(',').map((s) => s.trim()).filter(Boolean));
  const match = expected.size > 0 && [...expected].every((e) => typed.has(e)) && [...typed].every((t) => expected.has(t));
  if (!match) {
    audit({ admin: adminName(), action: 'delete', targets: meta, ok: false, error: 'confirmation mismatch' });
    reply.code(400).type('text/html').send(page('Confirmation failed', `<div class="warnbox">Typed names did not match. Nothing was deleted. Expected: <span class="mono">${[...expected].map(esc).join(' , ')}</span></div><p><a href="/delete">try again</a></p>`));
    return;
  }

  // Backup → delete. Refuse if backup fails/empty.
  let bkp;
  try {
    bkp = await backup(cfg);
  } catch (e) {
    audit({ admin: adminName(), action: 'backup', targets: meta, ok: false, error: (e as Error).message });
    reply.code(500).type('text/html').send(page('Backup failed', `<div class="warnbox">Backup failed, so nothing was deleted:<br>${esc((e as Error).message)}</div><p><a href="/delete">back</a></p>`));
    return;
  }

  try {
    const res = await runDelete({ orgIds: meta.orgIds, userIds: meta.userIds, cascadeOrphans: meta.cascade, dryRun: false });
    audit({
      admin: adminName(), action: 'delete',
      targets: { orgIds: meta.orgIds, userIds: res.userIds, cascade: meta.cascade, backup: bkp.file },
      rowCounts: { totalRows: res.totalRows, ...Object.fromEntries(res.steps.filter((s) => s.rows).map((s) => [s.table, s.rows])) },
      ok: true,
    });
    const after = await healthChecks();
    const newIssues = after.noSuperadmin.length || after.orphanAccounts.length;
    const stepRows = res.steps.filter((s) => s.rows > 0).map((s) => `<tr><td>${esc(s.kind)}</td><td>${esc(s.table)}${s.column ? '.' + esc(s.column) : ''}</td><td>${s.rows}</td></tr>`).join('');
    reply.type('text/html').send(page('Deleted',
      `<div class="okbox">Deleted ${res.totalRows} row(s). Roots remaining: ${res.rootsLeft.orgs} orgs / ${res.rootsLeft.users} users.<br>Backup: <span class="mono">${esc(bkp.file)}</span> (${bkp.bytes} bytes)</div>
       <div class="panel"><table><tr><th>Op</th><th>Table</th><th>Rows</th></tr>${stepRows}</table></div>
       ${newIssues ? '<div class="warnbox">Post-delete health check found new issues — review the dashboard.</div>' : '<div class="okbox">Post-delete health checks: clean ✓</div>'}
       <p><a href="/">dashboard</a></p>`));
  } catch (e) {
    audit({ admin: adminName(), action: 'delete', targets: meta, ok: false, error: (e as Error).message });
    reply.code(500).type('text/html').send(page('Delete failed', `<div class="warnbox">Delete rolled back:<br>${esc((e as Error).message)}<br>Backup is safe at <span class="mono">${esc(bkp.file)}</span>.</div><p><a href="/delete">back</a></p>`));
  }
});

// ── audit log ────────────────────────────────────────────────────────────────
app.get('/audit', async (_req, reply) => {
  const entries = readAudit(300) as any[];
  const rows = entries.map((e) => `<tr><td class="mono">${esc(e.ts)}</td><td>${esc(e.admin)}</td><td>${esc(e.action)}</td>
    <td>${e.ok ? badge('ok', 'ok') : badge('fail', 'danger')}</td>
    <td class="mono">${esc(JSON.stringify(e.targets || {}))}</td>
    <td class="mono">${esc(JSON.stringify(e.rowCounts || {}))}</td>
    <td>${e.error ? esc(e.error) : ''}</td></tr>`).join('');
  const body = `<div class="panel"><p class="muted">Append-only. Passwords &amp; bcrypt hashes are redacted. Newest first.</p>
  <table><tr><th>When (UTC)</th><th>Admin</th><th>Action</th><th>Result</th><th>Targets</th><th>Rows</th><th>Error</th></tr>${rows || '<tr><td colspan=7><small>empty</small></td></tr>'}</table></div>`;
  reply.type('text/html').send(page('Audit log', body, '/audit'));
});

// ── boot ─────────────────────────────────────────────────────────────────────
app.listen({ host: cfg.app.host, port: cfg.app.port }).then(() => {
  // eslint-disable-next-line no-console
  console.log(`postiz-admin-console listening on ${cfg.app.host}:${cfg.app.port}`);
}).catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start:', e);
  process.exit(1);
});
