/**
 * Claude3P-MCP-Router - HTTP Server
 * 由 index.ts 中的 serve 命令调用
 */

import express from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { spawn, execSync, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import winston from 'winston';
import dotenv from 'dotenv';

// ============== Types ==============

interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled?: boolean;
}

interface RouterConfig {
  port: number;
  host: string;
  https?: { key: string; cert: string };
  servers: MCPServerConfig[];
}

interface MCPServer {
  name: string;
  process: ChildProcess;
  initialized: boolean;
  pendingRequests: Map<number | string, {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>;
  buffer: string;
}

// ============== Logger ==============

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
      return `${timestamp} [${level.toUpperCase()}] ${message} ${metaStr}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/mcp-router.log', maxsize: 5 * 1024 * 1024, maxFiles: 3 }),
  ],
});

// ============== MCP Server Manager ==============

class MCPServerManager {
  private servers: Map<string, MCPServer> = new Map();
  private requestIdCounter = 0;

  private nextRequestId(): number { return ++this.requestIdCounter; }

  async startServer(config: MCPServerConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      const childEnv: Record<string, string | undefined> = { ...process.env };
      if (config.env) {
        for (const [key, value] of Object.entries(config.env)) {
          if (value) childEnv[key] = value;
        }
      }

      const child = spawn(config.command, config.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
        shell: true,
        windowsVerbatimArguments: true,
        windowsHide: true,
        cwd: process.cwd(),
      });

      const server: MCPServer = {
        name: config.name,
        process: child,
        initialized: false,
        pendingRequests: new Map(),
        buffer: '',
      };

      child.stdout?.on('data', (data: Buffer) => {
        server.buffer += data.toString();
        const lines = server.buffer.split('\n');
        server.buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed);
            if (msg.id !== undefined && msg.id !== null && server.pendingRequests.has(msg.id)) {
              const pending = server.pendingRequests.get(msg.id)!;
              server.pendingRequests.delete(msg.id);
              clearTimeout(pending.timer);
              if (msg.error) {
                pending.reject(new Error(msg.error.message || `MCP error ${msg.error.code}`));
              } else {
                pending.resolve(msg.result);
              }
            }
          } catch { /* non-JSON */ }
        }
      });

      child.stderr?.on('data', (data: Buffer) => {
        const output = data.toString().trim();
        if (output) logger.warn(`[${config.name}] stderr:`, output);
      });

      child.on('error', (err) => {
        logger.error(`[${config.name}] Process error:`, err);
        this.rejectAllPending(server, err);
        this.servers.delete(config.name);
        reject(err);
      });

      child.on('exit', (code, signal) => {
        logger.warn(`[${config.name}] Process exited`, { code, signal });
        this.rejectAllPending(server, new Error(`Process exited with code ${code}`));
        this.servers.delete(config.name);
        setTimeout(() => {
          if (this.servers.has(config.name)) return;
          logger.info(`Restarting ${config.name}...`);
          this.startServer(config).catch((err) => logger.error(`Failed to restart ${config.name}:`, err));
        }, 5000);
      });

      this.servers.set(config.name, server);

      setTimeout(() => {
        this.initializeServer(server).then(() => {
          logger.info(`Server initialized: ${config.name}`);
          resolve();
        }).catch(reject);
      }, 500);
    });
  }

  private async initializeServer(server: MCPServer): Promise<void> {
    const initRequest = {
      jsonrpc: '2.0',
      id: this.nextRequestId(),
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-router', version: '1.0.0' },
      },
    };
    await this.sendRequest(server, initRequest);
    this.sendNotification(server, { jsonrpc: '2.0', method: 'notifications/initialized' });
    server.initialized = true;
  }

  async startAll(servers: MCPServerConfig[]): Promise<void> {
    const enabled = servers.filter(s => s.enabled !== false);
    logger.info('Starting MCP servers...', { count: enabled.length });
    for (const config of enabled) {
      try { await this.startServer(config); } catch (err) {
        logger.error(`Failed to start: ${config.name}`, { error: err });
      }
    }
    logger.info('MCP servers ready', { running: this.servers.size });
  }

  stopAll(): void {
    for (const [, server] of this.servers) { server.process.kill('SIGTERM'); }
    this.servers.clear();
  }

  private rejectAllPending(server: MCPServer, error: Error): void {
    for (const [, pending] of server.pendingRequests) { clearTimeout(pending.timer); pending.reject(error); }
    server.pendingRequests.clear();
  }

  sendRequest(server: MCPServer, request: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        server.pendingRequests.delete(request.id);
        reject(new Error('MCP server timeout'));
      }, 30000);
      server.pendingRequests.set(request.id, { resolve, reject, timer: timeout });
      server.process.stdin?.write(JSON.stringify(request) + '\n', (err) => {
        if (err) { server.pendingRequests.delete(request.id); clearTimeout(timeout); reject(err); }
      });
    });
  }

  sendNotification(server: MCPServer, notification: any): void {
    server.process.stdin?.write(JSON.stringify(notification) + '\n');
  }

  getServer(name: string): MCPServer | undefined { return this.servers.get(name); }
  getAllServers(): Map<string, MCPServer> { return this.servers; }
  getNextRequestId(): number { return this.nextRequestId(); }
}

// ============== Router ==============

class MCPRouter {
  private app: express.Application;
  private server: https.Server | http.Server;
  private manager: MCPServerManager;

  constructor(private config: RouterConfig) {
    this.manager = new MCPServerManager();
    this.app = express();
    this.app.use(express.json({ type: 'application/json' }));
    this.setupRoutes();
    this.setupGracefulShutdown();

    if (config.https) {
      this.server = https.createServer({
        key: fs.readFileSync(config.https.key),
        cert: fs.readFileSync(config.https.cert),
      }, this.app);
    } else {
      this.server = http.createServer(this.app);
    }
  }

  private setupRoutes(): void {
    this.app.get('/health', (_req, res) => {
      const names = Array.from(this.manager.getAllServers().keys());
      res.json({ status: 'healthy', servers: names, endpoints: names.map(n => `/mcp/${n}`), uptime: process.uptime() });
    });

    this.app.get('/mcp/:server', (req, res) => {
      const srv = this.manager.getServer(req.params.server);
      if (!srv) { res.status(404).json({ error: `Server '${req.params.server}' not found` }); return; }
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.write(`data: ${JSON.stringify({ type: 'connected', server: srv.name })}\n\n`);
      const hb = setInterval(() => res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`), 30000);
      res.on('close', () => clearInterval(hb));
    });

    this.app.post('/mcp/:server', async (req, res) => {
      const srv = this.manager.getServer(req.params.server);
      if (!srv) {
        res.status(404).json({ jsonrpc: '2.0', id: req.body.id, error: { code: -32602, message: `Server '${req.params.server}' not found` } });
        return;
      }
      try {
        const proxyReq = { jsonrpc: '2.0', id: this.manager.getNextRequestId(), method: req.body.method, params: req.body.params || {} };
        const result = await this.manager.sendRequest(srv, proxyReq);
        res.json({ jsonrpc: '2.0', id: req.body.id, result });
      } catch (error: any) {
        res.json({ jsonrpc: '2.0', id: req.body.id, error: { code: -32603, message: error.message } });
      }
    });

    this.app.get('/mcp', (_req, res) => {
      const names = Array.from(this.manager.getAllServers().keys());
      res.json({ message: 'Use /mcp/{server-name} endpoints', availableServers: names, endpoints: names.map(n => `/mcp/${n}`) });
    });
  }

  private setupGracefulShutdown(): void {
    const shutdown = (sig: string) => {
      logger.info(`Received ${sig}, shutting down...`);
      this.manager.stopAll();
      this.server.close(() => { logger.info('Server closed'); process.exit(0); });
      setTimeout(() => process.exit(1), 10000);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }

  async start(): Promise<void> {
    await this.manager.startAll(this.config.servers);
    return new Promise((resolve) => {
      this.server.listen(this.config.port, this.config.host, () => {
        const proto = this.config.https ? 'https' : 'http';
        logger.info(`Claude3P-MCP-Router running at ${proto}://${this.config.host}:${this.config.port}`);
        for (const s of this.config.servers.filter(s => s.enabled !== false)) {
          logger.info(`  /mcp/${s.name}`);
        }
        resolve();
      });
    });
  }
}

// ============== Main ==============

export async function startServer() {
  logger.info('='.repeat(50));
  logger.info('Local Claude3P-MCP-Router starting...');
  logger.info('='.repeat(50));

  const projectDir = process.env.MCP_ROUTER_HOME || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  dotenv.config({ path: path.join(projectDir, '.env') });
  const configPath = path.join(projectDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    logger.error('config.json not found!');
    process.exit(1);
  }

  const userConfig: any = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const config: RouterConfig = {
    port: userConfig.port || 3100,
    host: userConfig.host || 'localhost',
    https: userConfig.https || undefined,
    servers: userConfig.servers || [],
  };

  if (config.https) {
    if (!fs.existsSync(config.https.key) || !fs.existsSync(config.https.cert)) {
      // Attempt to auto-generate self-signed certificate using OpenSSL
      // Self-signed root certs avoid Windows SChannel CRYPT_E_NO_REVOCATION_CHECK
      logger.warn('HTTPS certificates not found, attempting to auto-generate...');
      try {
        fs.mkdirSync(path.dirname(config.https.key), { recursive: true });
        execSync(
          `openssl req -x509 -newkey rsa:2048 -nodes ` +
          `-keyout "${config.https.key}" -out "${config.https.cert}" -days 1825 ` +
          `-subj "//CN=localhost" ` +
          `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1"`,
          { stdio: 'pipe' }
        );
        // Install as trusted root (root certs skip SChannel revocation checks)
        execSync(`certutil -addstore -user Root "${config.https.cert}"`, { stdio: 'pipe' });
        logger.info('HTTPS certificates auto-generated and trusted');
      } catch {
        logger.error('Failed to auto-generate certificates. Run: claude3p-mcp-router cert-setup');
        process.exit(1);
      }
    }
  }

  const router = new MCPRouter(config);
  await router.start();
}
