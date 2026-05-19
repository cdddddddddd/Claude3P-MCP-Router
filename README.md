# Claude3P-MCP-Router

<p align="center">
  <b>English</b> | <a href="#中文">中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen" alt="Node.js >= 20">
  <img src="https://img.shields.io/badge/platform-Windows-blue" alt="Platform: Windows">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License: MIT">
</p>

---

A local HTTPS MCP proxy server that aggregates multiple stdio-based MCP servers into independent endpoints, enabling **per-tool access control** (`allow` / `ask` / `blocked`) via Claude 3P Gateway's `managedMcpServers` configuration.

---

## Quick Start

```bash
git clone <repo-url> && cd Claude3P-MCP-Router
npm install
copy config.template.json config.json     # Add your MCP servers
copy .env.example .env                     # Fill in API keys
npm link                                   # Register global CLI command
claude3p-mcp-router cert-setup             # Generate HTTPS certificate
claude3p-mcp-router start                  # Start the server (background)
claude3p-mcp-router sync                   # Sync config to Claude 3P
# Restart Claude Desktop
```

## Commands

| Command | Description |
|---------|-------------|
| `start` | Start HTTP proxy server in background (with spinner) |
| `stop` | Stop the running server |
| `status` | Show health status table (endpoints + tool counts) |
| `sync` | Write `managedMcpServers` to Claude 3P config |
| `reload` | `sync` + restart server |
| `cert-setup` | Generate localhost HTTPS certificate via node-forge |
| `autostart` | Enable/disable auto-start on Windows boot |
| `help` | Show help |

## Configuration (`config.json`)

Add each MCP server in **both** the `servers` and `managedMcpServers` sections:

```json
{
  "port": 3100,
  "host": "localhost",
  "servers": [
    {
      "name": "context7",
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp"],
      "enabled": true
    }
  ],
  "managedMcpServers": [
    {
      "name": "context7",
      "toolPolicy": {
        "resolve-library-id": "allow",
        "query-docs": "allow"
      }
    }
  ]
}
```

### toolPolicy States

| State | Behavior |
|-------|----------|
| `allow` | Tool executes immediately, no prompt |
| `ask` | Claude asks for confirmation each time |
| `blocked` | Tool is completely unavailable |

Environment variables (API keys, etc.) go in `.env` at the project root — never commit this file.

## Architecture

```
Claude Desktop (3P Gateway)
  │
  ├─ POST https://localhost:3100/mcp/context7  ──► npx @upstash/context7-mcp
  ├─ POST https://localhost:3100/mcp/fetch      ──► uvx mcp-server-fetch
  ├─ POST https://localhost:3100/mcp/filesystem ──► npx @anthropic/mcp-server-filesystem
  └─ POST https://localhost:3100/mcp/minimax    ──► uvx minimax-mcp
```

Each MCP server gets its own endpoint and toolPolicy. The router manages child process lifecycles (spawn → initialize handshake → proxy → auto-restart on crash).

## Requirements

- **Node.js** >= 20
- **Windows** (currently; cross-platform support planned)
- **pip** (for installing `uv`, auto-detected on first start)

---

## 中文 <a id="中文"></a>

本地 HTTPS MCP 代理服务器，将多个基于 stdio 的 MCP 服务聚合为独立端点，通过 Claude 3P Gateway 的 `managedMcpServers` 配置实现**精细的工具权限控制**（`allow` 允许 / `ask` 询问 / `blocked` 禁止）。

### 快速开始

```bash
git clone <repo-url> && cd Claude3P-MCP-Router
npm install
copy config.template.json config.json     # 编辑添加 MCP 服务器
copy .env.example .env                     # 填入 API 密钥
npm link                                   # 注册全局命令
claude3p-mcp-router cert-setup             # 生成 HTTPS 证书
claude3p-mcp-router start                  # 后台启动服务
claude3p-mcp-router sync                   # 同步配置到 Claude 3P
# 重启 Claude Desktop
```

### 命令

| 命令 | 说明 |
|------|------|
| `start` | 后台启动 HTTP 代理服务（带进度动画） |
| `stop` | 停止运行中的服务 |
| `status` | 查看健康状态表格（端点 + 工具数） |
| `sync` | 将 `managedMcpServers` 同步写入 Claude 3P 配置 |
| `reload` | 同步配置 + 重启服务 |
| `cert-setup` | 通过 node-forge 生成本地 HTTPS 自签名证书 |
| `autostart` | 开启/关闭 Windows 开机自动启动 |
| `help` | 显示帮助信息 |

### 配置说明 (`config.json`)

每新增一个 MCP 服务，需在 `servers`（启动参数）和 `managedMcpServers`（权限策略）各添加一条记录。配置完成后运行 `claude3p-mcp-router reload` 生效。

### toolPolicy 权限

| 状态 | 行为 |
|------|------|
| `allow` | 工具直接执行，无需确认 |
| `ask` | 每次调用前弹出确认对话框 |
| `blocked` | 工具完全不可用 |

### 架构

```
Claude Desktop (3P Gateway)
  │
  ├─ POST https://localhost:3100/mcp/context7  ──► npx @upstash/context7-mcp
  ├─ POST https://localhost:3100/mcp/fetch      ──► uvx mcp-server-fetch
  ├─ POST https://localhost:3100/mcp/filesystem ──► npx @anthropic/mcp-server-filesystem
  └─ POST https://localhost:3100/mcp/minimax    ──► uvx minimax-mcp
```

每个 MCP 服务拥有独立端点和独立 toolPolicy。路由器管理子进程生命周期：启动 → 初始化握手 → 代理请求 → 崩溃自动重启。

### 环境要求

- **Node.js** >= 20
- **Windows**（目前仅支持 Windows，跨平台计划中）
- **pip**（用于安装 uv，首次启动自动检测）

---

## License

MIT — see [LICENSE](./LICENSE) for details.

This project is not affiliated with Anthropic.
