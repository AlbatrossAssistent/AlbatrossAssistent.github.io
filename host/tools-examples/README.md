# Tool examples

Copy what you want into `host/my-tools/` (next to `host.js`; the folder is made the first time the host runs). The host picks changes up by itself. The AI sees every tool as `pc_<name>`, in the website chat and the Chrome sidebar, whenever you're connected to this PC.

| File | What it is |
| --- | --- |
| `weather.json` | a **web address** tool: calls a public web service with the inputs filled in |
| `shout.json` + `shout.js` | a **script** tool: runs a Node script (inputs arrive as JSON on stdin, what it prints is the answer) |
| `mcp.example.json` | rename to `mcp.json` to connect **MCP servers** |

Tools made on the website (Settings → Tools → Your tools…) are saved in the same folder. They can only be a text for the AI or a call to a public https address. Scripts and MCP servers only run because **you** put them in this folder.

## MCP servers (the open-source tool collections)

MCP (Model Context Protocol) is the open standard most tool collections use. Each server is a small program; `mcp.json` says how to start it:

```json
{ "servers": { "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] } } }
```

Where to find them: the official [MCP Registry](https://registry.modelcontextprotocol.io) and the reference servers at https://github.com/modelcontextprotocol/servers, and community lists like https://github.com/punkpeye/awesome-mcp-servers and https://mcpservers.org.
A server is a program that runs on your PC with your rights. Read what it does and who made it before you add it, and give file servers only the folders they need.

## Script tools

A script tool is a `.json` file plus a `.js` file in the same folder (see `shout.json`). The script reads its inputs from stdin as JSON, prints the answer and exits; it's stopped after 30 seconds. It runs as a normal Node program with your rights.
