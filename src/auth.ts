// Single-operator admin login (SPEC Sec 5). One shared login, signed cookie.
import { FastifyReply, FastifyRequest } from 'fastify';
import { Config } from './config';
import { hashPassword, verifyPassword } from './hash';

const COOKIE = 'pac_session';

let adminHash = '';
let adminUser = '';
let insecure = true;

export function initAuth(cfg: Config) {
  adminUser = cfg.admin.username;
  insecure = cfg.insecureCookies;
  if (cfg.admin.passwordHash) {
    adminHash = cfg.admin.passwordHash;
  } else if (cfg.admin.password) {
    adminHash = hashPassword(cfg.admin.password);
  } else {
    throw new Error('No admin password configured.');
  }
}

export function checkLogin(username: string, password: string): boolean {
  // Constant-ish: always run bcrypt to avoid trivial user-enumeration timing.
  const userOk = username === adminUser;
  const passOk = verifyPassword(password, adminHash);
  return userOk && passOk;
}

export function setSession(reply: FastifyReply) {
  reply.setCookie(COOKIE, adminUser, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: !insecure,
    signed: true,
    maxAge: 60 * 60 * 8, // 8h
  });
}

export function clearSession(reply: FastifyReply) {
  reply.clearCookie(COOKIE, { path: '/' });
}

export function isAuthed(req: FastifyRequest): boolean {
  const raw = req.cookies[COOKIE];
  if (!raw) return false;
  const un = req.unsignCookie(raw);
  return un.valid && un.value === adminUser;
}

// Fastify preHandler: redirect unauthenticated browser requests to /login.
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!isAuthed(req)) {
    reply.redirect('/login');
    return reply;
  }
}

export function adminName(): string {
  return adminUser;
}
