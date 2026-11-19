// Copyright (c) 2026 Orime, Inc.
// SPDX-License-Identifier: AGPL-3.0-only
import { InMemoryTransport, type JSONRPCMessage, type McpServer } from "@modelcontextprotocol/server";

/** A tool call's result as the client receives it. */
export interface CallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

/** A minimal MCP client over an in-memory transport. */
export interface TestClient {
  initialize: () => Promise<{ instructions?: string; serverInfo: { name: string } }>;
  listTools: () => Promise<Array<{ name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }>>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallResult>;
  /** The first text content of a call, parsed as JSON. */
  callJson: (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; body: Record<string, unknown> }>;
}

/**
 * Connect a client to a server over a linked in-memory pair.
 * @param server - The server.
 * @returns The client, already initialized.
 */
export async function connectClient(server: McpServer): Promise<TestClient> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const waiting = new Map<number, (message: JSONRPCMessage) => void>();
  clientSide.onmessage = (message) => {
    const id = (message as { id?: number }).id;
    if (typeof id === "number") waiting.get(id)?.(message);
  };
  await server.connect(serverSide);
  await clientSide.start();
  let next = 1;

  /**
   * Send a request and wait for its response.
   * @param method - The method.
   * @param params - Its params.
   * @returns The result.
   * @throws {Error} When the server answers with a JSON-RPC error.
   */
  const request = async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = next++;
    const answer = new Promise<JSONRPCMessage>((resolve) => waiting.set(id, resolve));
    await clientSide.send({ jsonrpc: "2.0", id, method, params });
    const message = (await answer) as { result?: Record<string, unknown>; error?: { message: string } };
    if (message.error) throw new Error(message.error.message);
    return message.result!;
  };

  const client: TestClient = {
    initialize: async () => {
      const result = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
      await clientSide.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      return result as { instructions?: string; serverInfo: { name: string } };
    },
    listTools: async () => (await request("tools/list", {})).tools as Awaited<ReturnType<TestClient["listTools"]>>,
    callTool: async (name, args) => (await request("tools/call", { name, arguments: args })) as unknown as CallResult,
    callJson: async (name, args) => {
      const result = await client.callTool(name, args);
      return { isError: result.isError === true, body: JSON.parse(result.content[0]!.text!) as Record<string, unknown> };
    },
  };
  return client;
}
