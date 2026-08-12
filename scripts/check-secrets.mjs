import { execFileSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const listed = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: projectRoot, encoding: 'utf8' },
).split('\0').filter(Boolean);

const allowedExamples = /(?:^|\/)(?:\.env|\.dev\.vars)(?:\.[^/]+)?\.example$/;
const sensitiveNames = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
const sensitiveExtensions = new Set(['.pem', '.key', '.p12', '.pfx']);
const findings = [];

for (const path of listed) {
  const name = basename(path);
  if (!allowedExamples.test(path) && (
    /(?:^|\/)\.env(?:\.|$)/.test(path)
    || /(?:^|\/)\.dev\.vars(?:\.|$)/.test(path)
    || /(?:^|\/)\.codex_tmp(?:\/|$)/.test(path)
    || sensitiveNames.has(name)
    || [...sensitiveNames].some((prefix) => name.startsWith(`${prefix}.`))
    || sensitiveExtensions.has(extname(name).toLowerCase())
  )) {
    findings.push({ path, rule: 'credential-like filename' });
  }
}

const contentRules = [
  {
    name: 'private-key block',
    pattern: new RegExp(['-----BEGIN ', '(?:RSA |DSA |EC |OPENSSH )?', 'PRIVATE KEY-----'].join('')),
  },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', pattern: /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { name: 'OpenAI-style secret', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  {
    name: 'assigned API secret',
    pattern: /\b(?:CLOUDFLARE_API_TOKEN|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/,
  },
];

for (const path of listed) {
  const absolutePath = resolve(projectRoot, path);
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch {
    continue;
  }
  if (!fileStat.isFile() || fileStat.size > 2 * 1024 * 1024) continue;

  const buffer = await readFile(absolutePath);
  if (buffer.includes(0)) continue;
  const text = buffer.toString('utf8');
  for (const rule of contentRules) {
    if (rule.pattern.test(text)) findings.push({ path, rule: rule.name });
  }
}

const uniqueFindings = [...new Map(findings.map((finding) => [`${finding.path}:${finding.rule}`, finding])).values()];
if (uniqueFindings.length) {
  for (const finding of uniqueFindings) console.error(`BLOCK ${finding.path}: ${finding.rule}`);
  console.error(`Secret guard failed with ${uniqueFindings.length} finding(s). Values were intentionally not printed.`);
  process.exitCode = 1;
} else {
  console.log(`PASS secret guard scanned ${listed.length} versionable file(s)`);
}
