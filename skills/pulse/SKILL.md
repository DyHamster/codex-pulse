---
name: pulse
description: 查看 Codex 剩余额度、Token 用量、网络连接状态，或打开本地实时监控面板。
---

Use the codex-pulse MCP tools. Use get_status for a snapshot, diagnose_network to schedule an immediate refresh, and get_dashboard_url to open the live dashboard in the Codex browser panel when available or provide a clickable link.

Use open_menubar when the user asks to open or reopen the installed macOS menu bar monitor. This starts the local app; it does not install it. If unavailable, explain that the user can open ~/Applications/Codex Pulse.app in Finder or search Codex Pulse in Spotlight.

Remaining quota percentages are account-wide, never a remaining token count. Show stale/error flags and last update time. Missing metrics are unknown, not zero. The account is the local Codex CLI account and may differ from the desktop account. Network probes use environment proxies, do not guarantee the same route as Codex, and never measure generation latency. HTTP 401/403/429 means an HTTP response was received, not an offline connection.

The dashboard URL contains a local access key. Only show it to the requesting user. Never publish it or pass it to remote services. Monitoring runs in a local process, without repeated model turns. Do not repeatedly call tools to simulate monitoring. Desktop/browser notifications require the dashboard to remain open and explicit browser permission.
