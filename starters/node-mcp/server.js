// Vessel starter: an MCP server (Streamable HTTP, stateless) on Edge.js in a Wasmer sandbox.
// Vessel sets PORT and HOST. Clients connect to http://127.0.0.1:$PORT/mcp.
// CommonJS on purpose: under wasmer/edgejs 0.2.5 the ESM entry of zod/v3 (which the MCP SDK imports)
// fails with "reading 'arrayToEnum'", while the CommonJS builds load fine.
/* eslint-disable @typescript-eslint/no-require-imports */
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const express = require("express");
const { z } = require("zod");

function buildServer() {
  const server = new McpServer({ name: "vessel-starter", version: "0.1.0" });
  server.registerTool(
    "add",
    { title: "Add numbers", description: "Add two numbers.", inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
  );
  server.registerTool(
    "runtime",
    { title: "Runtime info", description: "Describe the runtime this server runs on.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: `${process.version} ${process.platform}/${process.arch}` }] }),
  );
  return server;
}

const app = express();
app.use(express.json());
// Stateless: a fresh server and transport per request, so no session state to lose across restarts.
app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.get("/", (_req, res) => res.json({ mcp: "/mcp", tools: ["add", "runtime"] }));

const port = Number(process.env.PORT ?? 3000);
app.listen(port, process.env.HOST ?? "127.0.0.1", () => console.log(`listening on ${port}`));
