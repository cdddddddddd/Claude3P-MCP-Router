/**
 * Claude3P-MCP-Router
 *
 * claude3p-mcp-router [command]
 *   (none)       Start the HTTP proxy server
 *   sync         Sync managedMcpServers to Claude 3p config
 *   cert-setup   Generate HTTPS certificates
 *   help         Show help
 */

import { startServer } from './serve.js';
import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'fs';
import * as fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

function getProjectDir(): string {
  if (process.env.MCP_ROUTER_HOME) return process.env.MCP_ROUTER_HOME;
  // dist/index.js或src/index.ts 都是 项目根/子目录/index.js → 上级的上级=项目根
  return dirname(dirname(fileURLToPath(import.meta.url)));
}
const PROJECT_DIR = getProjectDir();

// ============== 命令 ==============

function runHelp(): void {
  console.log('Claude3P-MCP-Router v1.0.0');
  console.log('');
  console.log('Usage: claude3p-mcp-router [command]');
  console.log('');
  console.log('Commands:');
  console.log('  start       Start the HTTP proxy server');
  console.log('  stop        Stop the HTTP proxy server');
  console.log('  status      Check server status');
  console.log('  reload      Sync + restart server');
  console.log('  sync        Sync managedMcpServers to Claude 3p config');
  console.log('  cert-setup  Generate HTTPS certificates');
  console.log('  help        Show this help');
}

function runSync(): void {
  const configPath = join(PROJECT_DIR, 'config.json');
  if (!existsSync(configPath)) { console.error('config.json not found in', PROJECT_DIR); process.exit(1); }

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const { port, host, managedMcpServers } = config;
  if (!managedMcpServers?.length) { console.error('managedMcpServers not configured'); process.exit(1); }

  const protocol = config.https ? 'https' : 'http';
  const mcp3p = managedMcpServers.map((m: any) => ({
    name: m.name,
    url: `${protocol}://${host}:${port}/mcp/${m.name}`,
    transport: 'http',
    toolPolicy: m.toolPolicy,
  }));

  let lib = config.claude3pConfigLibraryPath || '';
  if (!lib) {
    const lad = process.env.LOCALAPPDATA || '';
    const pkgs = readdirSync(join(lad, 'Packages')).filter((d: string) => d.startsWith('Claude_'));
    if (!pkgs.length) throw new Error('Claude package not found');
    lib = join(lad, 'Packages', pkgs[0], 'LocalCache', 'Roaming', 'Claude-3p', 'configLibrary');
  }

  console.log(`Config library: ${lib}`);
  const meta = JSON.parse(readFileSync(join(lib, '_meta.json'), 'utf-8'));
  const aid = meta.appliedId;
  console.log(`Current: ${meta.entries?.find((e: any) => e.id === aid)?.name || aid}`);

  const tgt = JSON.parse(readFileSync(join(lib, `${aid}.json`), 'utf-8'));
  tgt.managedMcpServers = mcp3p;
  writeFileSync(join(lib, `${aid}.json`), JSON.stringify(tgt, null, 2) + '\n', 'utf-8');

  console.log(`\nSynced ${mcp3p.length} servers:`);
  for (const m of mcp3p) {
    const tools = Object.entries(m.toolPolicy) as [string, string][];
    const allow = tools.filter(([, s]) => s === 'allow');
    const ask   = tools.filter(([, s]) => s === 'ask');
    const block = tools.filter(([, s]) => s === 'blocked');
    console.log(`  ${m.name}: ${m.url}`);
    if (allow.length) console.log(`    allow:   ${allow.map(([t]) => t).join(', ')}`);
    if (ask.length)   console.log(`    ask:     ${ask.map(([t]) => t).join(', ')}`);
    if (block.length) console.log(`    blocked: ${block.map(([t]) => t).join(', ')}`);
  }
  console.log('\nDone. Restart Claude to apply.');
}

function runCertSetup(): void {
  const mkcertPath = join(PROJECT_DIR, 'dist', 'mkcert.exe');
  if (!existsSync(mkcertPath)) {
    console.error('mkcert.exe not found. Place it next to the exe or install via choco: choco install mkcert');
    process.exit(1);
  }
  try { execSync(`"${mkcertPath}" -install`, { stdio: 'inherit' }); } catch {}
  const cdir = join(PROJECT_DIR, 'certs');
  if (!existsSync(cdir)) mkdirSync(cdir, { recursive: true });
  execSync(`"${mkcertPath}" -key-file "${join(cdir, 'localhost-key.pem')}" -cert-file "${join(cdir, 'localhost.pem')}" localhost 127.0.0.1`, { stdio: 'inherit' });
  console.log('Certificates generated.');
}

function pad(s: string, n: number): string { return s + ' '.repeat(Math.max(0, n - s.length)); }

function runStatus(): void {
  try {
    const resp = execSync('curl -k https://localhost:3100/health 2>nul', { stdio: 'pipe' }).toString();
    const data = JSON.parse(resp);
    console.log('');
    console.log('  Status   RUNNING  (uptime: ' + Math.round(data.uptime || 0) + 's)');
    console.log('  ' + '-'.repeat(64));

    // 读取 config 获取 toolPolicy 计数
    const configPath = join(PROJECT_DIR, 'config.json');
    let policies: Record<string, number> = {};
    if (existsSync(configPath)) {
      const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
      for (const m of cfg.managedMcpServers || []) {
        policies[m.name] = Object.values(m.toolPolicy || {}).filter((s: any) => s === 'allow').length;
      }
    }

    const servers: string[] = data.servers || [];
    for (const s of ['fetch', 'context7', 'minimax', 'filesystem']) {
      const online = servers.includes(s) ? ' ✓' : ' ✗';
      const tools = policies[s] ? ' (' + policies[s] + ' tools)' : '';
      console.log('  ' + pad(s, 16) + 'https://localhost:3100/mcp/' + pad(s, 12) + online + tools);
    }
    console.log('  ' + '-'.repeat(64));
  } catch {
    console.log('  Status   NOT RUNNING  (port 3100 unreachable)');
  }
}

function runStop(): void {
  try { execSync('curl -sk https://localhost:3100/health 2>nul', { stdio: 'pipe' }); }
  catch { console.log('Server is not running.'); return; }
  console.log('Stopping server...');
  // 杀掉监听 3100 的 node 进程
  try {
    const out = execSync('netstat -ano | findstr ":3100"', { stdio: 'pipe' }).toString();
    const lines = out.split(/\r?\n/);
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (/^\d+$/.test(pid)) { execSync(`cmd /c "taskkill /PID ${pid} /F"`, { stdio: 'pipe' }); console.log('  Stopped (PID ' + pid + ')'); return; }
    }
  } catch {}
  // 回退：杀所有 node
  try { execSync('cmd /c "taskkill /F /IM node.exe"', { stdio: 'pipe' }); console.log('  Stopped (all node processes)'); }
  catch { console.log('  Could not stop server. Run as Administrator if needed.'); }
}

function startInBackground(): void {
  const logDir = join(PROJECT_DIR, 'logs');
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(join(logDir, 'out.log'), 'a');
  const err = fs.openSync(join(logDir, 'err.log'), 'a');
  const child = spawn(process.execPath, [join(PROJECT_DIR, 'dist', 'index.js'), 'serve'], {
    detached: true, stdio: ['ignore', out, err], windowsHide: true, cwd: PROJECT_DIR
  });
  child.unref();

  const spinner = ['|','/','-','\\'];
  let tick = 0, ready = false;
  console.log('Starting server (PID: ' + child.pid + ')...');
  const spin = setInterval(() => {
    if (!ready) process.stdout.write('\r  Waiting for MCPs to initialize ' + spinner[tick++ % 4]);
  }, 80);
  const poll = setInterval(() => {
    try {
      const resp = execSync('curl -sk https://localhost:3100/health 2>nul', { stdio: 'pipe' }).toString();
      const d = JSON.parse(resp);
      if (d.servers && d.servers.length > 0) {
        ready = true; clearInterval(spin); clearInterval(poll);
        process.stdout.write('\r' + ' '.repeat(60) + '\r');
        runStatus();
      }
    } catch { /* still starting */ }
  }, 2000);
  setTimeout(() => { clearInterval(spin); clearInterval(poll); process.stdout.write('\r  Server may still be initializing\n'); }, 60000);
}

function runReload(): void {
  console.log('Syncing config...');
  runSync();
  console.log('Restarting server...');
  runStop();
  setTimeout(() => startInBackground(), 1500);
}

// ============== 主入口 ==============

const cmd = process.argv[2] || '';

switch (cmd) {
  case 'help': case '--help': case '-h': runHelp(); break;
  case 'sync':      runSync(); break;
  case 'reload':    runReload(); break;
  case 'cert-setup': case 'cert': runCertSetup(); break;
  case 'start': {
    try {
      execSync('curl -sk https://localhost:3100/health 2>nul', { stdio: 'pipe' });
      console.log('Server already running.'); runStatus(); break;
    } catch {}
    startInBackground();
    break;
  }
  case 'serve': case '': startServer(); break;
  case 'status':    runStatus(); break;
  case 'stop':      runStop(); break;
  default:          runHelp(); break;
}
