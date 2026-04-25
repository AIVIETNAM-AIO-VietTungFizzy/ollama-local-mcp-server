<aside>
🦙

Example TypeScript MCP server for Docker setups where the MCP server and Ollama run in separate containers. The MCP server exposes an HTTP endpoint and calls Ollama through `fetch()` over the Docker network.

</aside>

### Goal

Build an MCP server in TypeScript that:

- Runs as a **Streamable HTTP MCP server**, not stdio
- Calls Ollama through `fetch()` at an HTTP URL such as `http://ollama:11434`
- Works when the **MCP server** and **Ollama** are separate Docker containers on the same Docker network
- Exposes an `ask_ollama` tool for chat completion
- Exposes a `list_ollama_models` tool for local model discovery
- Uses normal HTTP logging safely because this server does not use stdio transport

### Container architecture

```
MCP client
  -> HTTP POST /mcp
    -> MCP server container
      -> fetch("http://ollama:11434/api/chat")
        -> Ollama container
```

### Recommended Docker service names

If using Docker Compose, name the Ollama service `ollama`. Then the MCP server container can reach Ollama at:

```
http://ollama:11434
```

### Project setup

```bash
mkdir ollama-http-mcp-server
cd ollama-http-mcp-server

npm init -y

npm install @modelcontextprotocol/sdk express zod
npm install -D @types/express @types/node typescript

mkdir src
touch src/index.ts
```

### `package.json`

```json
{
  "type": "module",
  "scripts": {
    "build": "tsc",
    "start": "node build/index.js"
  },
  "files": ["build"],
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "express": "^4.18.3",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

### `src/index.ts`

```tsx
import express, { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PORT = Number(process.env.PORT ?? 3000);
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://ollama:11434";
const DEFAULT_OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.2";

type OllamaMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type OllamaChatResponse = {
  model: string;
  created_at: string;
  message?: {
    role: string;
    content: string;
  };
  done: boolean;
  error?: string;
};

type OllamaTagsResponse = {
  models: Array<{
    name: string;
    model?: string;
    modified_at?: string;
    size?: number;
  }>;
};

async function callOllamaChat(options: {
  model: string;
  messages: OllamaMessage[];
}): Promise<string> {
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
    throw new Error(
      `Ollama /api/chat failed with ${response.status}: ${errorText}`,
    );
  }

  const data = (await response.json()) as OllamaChatResponse;

  if (data.error) {
    throw new Error(data.error);
  }

  return data.message?.content ?? "";
}

async function listOllamaModels(): Promise<string[]> {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/tags`);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Ollama /api/tags failed with ${response.status}: ${errorText}`,
    );
  }

  const data = (await response.json()) as OllamaTagsResponse;
  return data.models.map((model) => model.name);
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "ollama-http",
    version: "1.0.0",
  });

  server.registerTool(
    "ask_ollama",
    {
      description: "Ask an Ollama model running in another Docker container",
      inputSchema: {
        prompt: z.string().describe("The prompt to send to Ollama"),
        model: z
          .string()
          .optional()
          .describe(
            `The Ollama model to use. Defaults to ${DEFAULT_OLLAMA_MODEL}`,
          ),
        system: z
          .string()
          .optional()
          .describe("Optional system instruction for the model"),
      },
    },
    async ({ prompt, model, system }) => {
      const selectedModel = model ?? DEFAULT_OLLAMA_MODEL;

      try {
        const messages: OllamaMessage[] = [];

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
      } catch (error) {
        console.error("Error calling Ollama:", error);

        return {
          content: [
            {
              type: "text",
              text: `Failed to call Ollama model "${selectedModel}" at ${OLLAMA_BASE_URL}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "list_ollama_models",
    {
      description: "List models available in the Ollama container",
      inputSchema: {},
    },
    async () => {
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
      } catch (error) {
        console.error("Error listing Ollama models:", error);

        return {
          content: [
            {
              type: "text",
              text: `Failed to list Ollama models at ${OLLAMA_BASE_URL}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

const app = express();
app.use(express.json());

const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
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
  } else {
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

app.get("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing MCP session ID");
    return;
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing MCP session ID");
    return;
  }

  const transport = transports[sessionId];
  await transport.handleRequest(req, res);
});

app.get("/health", (_req: Request, res: Response) => {
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
```

### Dockerfile

```docker
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV OLLAMA_BASE_URL=http://ollama:11434
ENV OLLAMA_MODEL=llama3.2

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/build ./build

EXPOSE 3000

CMD ["node", "build/index.js"]
```

### `docker-compose.yml`

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama-data:/root/.ollama

  ollama-mcp-server:
    build: .
    container_name: ollama-mcp-server
    depends_on:
      - ollama
    environment:
      PORT: "3000"
      OLLAMA_BASE_URL: "http://ollama:11434"
      OLLAMA_MODEL: "llama3.2"
    ports:
      - "3000:3000"

volumes:
  ollama-data:
```

### Build and run

```bash
docker compose up --build
```

Pull a model into the Ollama container:

```bash
docker exec -it ollama ollama pull llama3.2
```

Check the MCP server health endpoint:

```bash
curl http://localhost:3000/health
```

### MCP client connection URL

Use this URL from an MCP client that supports Streamable HTTP:

```
http://localhost:3000/mcp
```

If another container connects to the MCP server through Docker Compose, use the service name:

```
http://ollama-mcp-server:3000/mcp
```

### Available tools

| Tool | Purpose |
| --- | --- |
| `ask_ollama` | Sends a prompt to Ollama through `fetch()` and returns the model response. |
| `list_ollama_models` | Calls Ollama’s `/api/tags` endpoint and lists installed models. |

### Example tool call intent

```
Use ask_ollama with:
prompt: "Explain MCP in one paragraph"
model: "llama3.2"
```

### Notes

- Use `OLLAMA_BASE_URL=http://ollama:11434` when both containers are in the same Docker Compose network.
- Use `OLLAMA_BASE_URL=http://host.docker.internal:11434` if the MCP server container needs to reach Ollama running on the host machine.
- Use `stream: false` for simpler request-response behavior from Ollama’s `/api/chat` endpoint.
- Stdio is useful when a desktop client launches the MCP server process directly. For container-to-container setups, Streamable HTTP is usually easier to deploy and connect.
- Because this server uses HTTP transport, normal `console.log()` logging is safe and does not corrupt MCP stdio messages.