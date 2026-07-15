// Segurança: domain filtering, CDP method blocklist, audit log
import { appendFileSync, chmodSync, existsSync } from 'fs';
import { redactCommandArgs } from './redaction.mjs';

export function checkDomain(url, config) {
  if (!url) return null;
  try {
    const { hostname } = new URL(url);

    if (config.allowedDomains?.length > 0) {
      const allowed = config.allowedDomains.some(d =>
        hostname === d || hostname.endsWith('.' + d)
      );
      if (!allowed) return `Domain "${hostname}" not in allowedDomains. Configure ~/.chromex/config.json`;
    }

    if (config.blockedDomains?.length > 0) {
      const blocked = config.blockedDomains.find(d =>
        hostname === d || hostname.endsWith('.' + d)
      );
      if (blocked) return `Domain "${hostname}" is blocked. Configure ~/.chromex/config.json`;
    }

    return null;
  } catch {
    return null;
  }
}

export function isCdpMethodBlocked(method, config) {
  if (!method) return false;
  return config.blockedCdpMethods.some(m =>
    m.toLowerCase() === method.toLowerCase()
  );
}

export function audit(cmd, target, args, result, config) {
  if (!config.auditLog) return;
  const entry = {
    ts: new Date().toISOString(),
    cmd,
    target: target?.slice(0, 12) || null,
    args: redactCommandArgs(cmd, args).slice(0, 3),
    ok: result?.ok ?? true,
  };
  try {
    appendFileSync(config._auditLogPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
    if (existsSync(config._auditLogPath)) chmodSync(config._auditLogPath, 0o600);
  } catch { /* falha no audit não deve quebrar o comando */ }
}
