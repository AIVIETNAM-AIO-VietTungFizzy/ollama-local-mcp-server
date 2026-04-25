import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
const PORT = Number(process.env.PORT ?? 3000);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://ollama:11434";
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";
async function callOllamaChat(options) {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: options.model,
            messages: options.messages,
            stream: false,
        }),
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama /api/chat failed with ${response.status}: ${errorText}`);
    }
    const data = (await response.json());
    if (data.error) {
        throw new Error(data.error);
    }
    return data.message?.content ?? "";
}
async function listOllamaModels() {
    const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama /api/tags failed with ${response.status}: ${errorText}`);
    }
    const data = (await response.json());
    return data.models.map((model) => model.name);
}
function createMcpServer() {
    const server = new McpServer({
        name: "ollama-http",
        version: "1.0.0",
    });
    server.registerTool("ask_ollama", {
        description: "Ask an Ollama model running in another Docker container",
        inputSchema: {
            prompt: z.string().describe("The prompt to send to Ollama"),
            model: z
                .string()
                .optional()
                .describe(`The Ollama model to use. Defaults to ${DEFAULT_OLLAMA_MODEL}`),
            system: z
                .string()
                .optional()
                .describe("Optional system instruction for the model"),
        },
    }, async ({ prompt, model, system }) => {
        const selectedModel = model ?? DEFAULT_OLLAMA_MODEL;
        try {
            const messages = [];
            if (system) {
                messages.push({
                    role: "system",
                    content: system,
                });
            }
            messages.push({
                role: "user",
                content: prompt,
            });
            const text = await callOllamaChat({
                model: selectedModel,
                messages,
            });
            return {
                content: [
                    {
                        type: "text",
                        text,
                    },
                ],
            };
        }
        catch (error) {
            console.error("Error calling Ollama:", error);
            return {
                content: [
                    {
                        type: "text",
                        text: `Failed to call Ollama model "${selectedModel}" at ${OLLAMA_BASE_URL}: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    });
    server.registerTool("list_ollama_models", {
        description: "List models available in the Ollama container",
        inputSchema: {},
    }, async () => {
        try {
            const models = await listOllamaModels();
            if (!models.length) {
                return {
                    content: [
                        {
                            type: "text",
                            text: "No Ollama models found. Run `ollama pull llama3.2` in the Ollama container.",
                        },
                    ],
                };
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `Available Ollama models:\n\n${models
                            .map((name) => `- ${name}`)
                            .join("\n")}`,
                    },
                ],
            };
        }
        catch (error) {
            console.error("Error listing Ollama models:", error);
            return {
                content: [
                    {
                        type: "text",
                        text: `Failed to list Ollama models at ${OLLAMA_BASE_URL}: ${error instanceof Error ? error.message : String(error)}`,
                    },
                ],
                isError: true,
            };
        }
    });
    return server;
}
const app = express();
app.use(express.json());
const transports = {};
app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    let transport;
    if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
    }
    else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
                transports[newSessionId] = transport;
            },
        });
        transport.onclose = () => {
            if (transport.sessionId) {
                delete transports[transport.sessionId];
            }
        };
        const server = createMcpServer();
        await server.connect(transport);
    }
    else {
        res.status(400).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "Bad Request: No valid session ID provided",
            },
            id: null,
        });
        return;
    }
    await transport.handleRequest(req, res, req.body);
});
app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing MCP session ID");
        return;
    }
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
});
app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing MCP session ID");
        return;
    }
    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
});
app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        ollamaBaseUrl: OLLAMA_BASE_URL,
        defaultModel: DEFAULT_OLLAMA_MODEL,
    });
});
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Ollama HTTP MCP server listening on port ${PORT}`);
    console.log(`Ollama base URL: ${OLLAMA_BASE_URL}`);
    console.log(`Default Ollama model: ${DEFAULT_OLLAMA_MODEL}`);
});
