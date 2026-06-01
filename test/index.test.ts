import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdkMock = vi.hoisted(() => {
  class SuparseError extends Error {}

  class SuparseAPIError extends SuparseError {
    statusCode: number;

    constructor(message = "API failed", statusCode = 500) {
      super(message);
      this.statusCode = statusCode;
    }
  }

  class SuparseAuthError extends SuparseAPIError {}

  interface MockClient {
    close: ReturnType<typeof vi.fn>;
    deleteDocuments: ReturnType<typeof vi.fn>;
    downloadResults: ReturnType<typeof vi.fn>;
    extract: ReturnType<typeof vi.fn>;
    extractFolder: ReturnType<typeof vi.fn>;
    fetchResults: ReturnType<typeof vi.fn>;
    listTemplates: ReturnType<typeof vi.fn>;
    options: unknown;
    pollTaskStatus: ReturnType<typeof vi.fn>;
    processBatch: ReturnType<typeof vi.fn>;
    uploadFile: ReturnType<typeof vi.fn>;
  }

  const state = {
    constructorError: undefined as unknown,
    instances: [] as MockClient[],
    nextClient: undefined as Partial<MockClient> | undefined,
  };

  const SuparseNodeClient = vi.fn(function (this: MockClient, options: unknown) {
    if (state.constructorError) throw state.constructorError;

    this.options = options;
    this.close = vi.fn(async () => undefined);
    this.deleteDocuments = vi.fn(async () => true);
    this.downloadResults = vi.fn(async () => "/tmp/export.json");
    this.extract = vi.fn(async () => ({
      total: 1,
      succeeded: [
        {
          task_id: "task-1",
          original_file: "invoice.pdf",
          total_documents_extracted: 1,
          documents: [],
        },
      ],
      failed: [],
    }));
    this.extractFolder = vi.fn(async () => ({ total: 0, succeeded: [], failed: [] }));
    this.fetchResults = vi.fn(async () => [
      {
        task_id: "task-1",
        original_file: "invoice.pdf",
        total_documents_extracted: 1,
        documents: [],
      },
    ]);
    this.listTemplates = vi.fn(async () => [
      {
        id: "team-template",
        name: "Invoice",
        description: null,
        template_language: "en",
        version: 1,
        is_active: true,
        is_system_template: false,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "system-template",
        name: "Receipt",
        description: "System receipt template",
        template_language: "en",
        version: 1,
        is_active: true,
        is_system_template: true,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    this.pollTaskStatus = vi.fn(async () => ({ documentIds: ["doc-1"] }));
    this.processBatch = vi.fn(async () => ({
      succeeded: [{ filePath: "/tmp/invoice.pdf", taskId: "task-1", documentIds: ["doc-1"] }],
      failed: [],
    }));
    this.uploadFile = vi.fn(async () => "task-1");

    if (state.nextClient) Object.assign(this, state.nextClient);
    state.instances.push(this);
  });

  return {
    ALLOWED_EXTENSIONS: new Set([".pdf", ".png", ".jpg", ".jpeg"]),
    SuparseAPIError,
    SuparseAuthError,
    SuparseError,
    SuparseNodeClient,
    VERSION: "1.2.0",
    state,
  };
});

vi.mock("@suparse/sdk/node", () => sdkMock);

import { createSuparseMcpServer } from "../src/index";

interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

interface RegisteredTool {
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
  outputSchema?: unknown;
}

function registeredTools(): Record<string, RegisteredTool> {
  const server = createSuparseMcpServer();
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = registeredTools()[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.handler(args);
}

describe("createSuparseMcpServer", () => {
  let tempHome: string;
  let originalApiKey: string | undefined;
  let originalApiUrl: string | undefined;
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalApiKey = process.env.SUPARSE_API_KEY;
    originalApiUrl = process.env.SUPARSE_API_URL;
    originalHome = process.env.HOME;
    tempHome = await mkdtemp(path.join(os.tmpdir(), "suparse-mcp-test-"));

    delete process.env.SUPARSE_API_KEY;
    delete process.env.SUPARSE_API_URL;
    process.env.HOME = tempHome;
    sdkMock.state.constructorError = undefined;
    sdkMock.state.instances = [];
    sdkMock.state.nextClient = undefined;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (originalApiKey === undefined) delete process.env.SUPARSE_API_KEY;
    else process.env.SUPARSE_API_KEY = originalApiKey;

    if (originalApiUrl === undefined) delete process.env.SUPARSE_API_URL;
    else process.env.SUPARSE_API_URL = originalApiUrl;

    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    await rm(tempHome, { recursive: true, force: true });
  });

  it("registers the public Suparse tool surface with output schemas", () => {
    const tools = registeredTools();

    expect(Object.keys(tools).sort()).toEqual([
      "delete_documents",
      "download_results",
      "extract_file",
      "extract_folder",
      "fetch_json_results",
      "list_templates",
    ]);

    for (const tool of Object.values(tools)) {
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it("returns a structured MCP error when the API key is missing", async () => {
    const result = await callTool("list_templates", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("API key not found");
    expect(sdkMock.SuparseNodeClient).not.toHaveBeenCalled();
  });

  it("returns a structured MCP error when SDK client construction fails", async () => {
    process.env.SUPARSE_API_KEY = "test-key";
    sdkMock.state.constructorError = new Error("constructor failed");

    const result = await callTool("list_templates", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("constructor failed");
  });

  it("reads API credentials from the Suparse config file", async () => {
    await mkdir(path.join(tempHome, ".config", "suparse"), { recursive: true });
    await writeFile(
      path.join(tempHome, ".config", "suparse", "config.json"),
      JSON.stringify({ apiKey: "config-key" }),
    );

    await callTool("list_templates", {});

    expect(sdkMock.state.instances[0]?.options).toEqual({ apiKey: "config-key" });
  });

  it("passes per-tool API URL overrides to the SDK client", async () => {
    process.env.SUPARSE_API_KEY = "test-key";

    await callTool("list_templates", { api_url: "https://api.example.test/v1" });

    expect(sdkMock.state.instances[0]?.options).toEqual({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
    });
  });

  it("maps Suparse auth errors to user-actionable MCP errors", async () => {
    process.env.SUPARSE_API_KEY = "test-key";
    sdkMock.state.nextClient = {
      listTemplates: vi.fn(async () => {
        throw new sdkMock.SuparseAuthError("bad key", 401);
      }),
    };

    const result = await callTool("list_templates", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("Permission denied (401): bad key. Check SUPARSE_API_KEY.");
    expect(sdkMock.state.instances[0]?.close).toHaveBeenCalledOnce();
  });

  it("defers extract_file by default and returns document IDs", async () => {
    process.env.SUPARSE_API_KEY = "test-key";

    const result = await callTool("extract_file", { file_path: "/tmp/invoice.pdf" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      result_mode: "defer",
      total: 1,
      succeeded: [{ file_path: "/tmp/invoice.pdf", task_id: "task-1", document_ids: ["doc-1"] }],
      failed: [],
    });
    expect(sdkMock.state.instances[0]?.uploadFile).toHaveBeenCalledWith("/tmp/invoice.pdf", {
      template_id: undefined,
      split: undefined,
    });
  });

  it("rejects cleanup with deferred extraction before uploading", async () => {
    process.env.SUPARSE_API_KEY = "test-key";

    const result = await callTool("extract_file", {
      file_path: "/tmp/invoice.pdf",
      cleanup: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("cleanup is only valid");
    expect(sdkMock.state.instances[0]?.uploadFile).not.toHaveBeenCalled();
  });

  it("returns JSON extraction results when result_mode is return_json", async () => {
    process.env.SUPARSE_API_KEY = "test-key";

    const result = await callTool("extract_file", {
      file_path: "/tmp/invoice.pdf",
      result_mode: "return_json",
      cleanup: true,
    });

    expect(result.structuredContent?.result_mode).toBe("return_json");
    expect(sdkMock.state.instances[0]?.extract).toHaveBeenCalledWith("/tmp/invoice.pdf", {
      template_id: undefined,
      split: undefined,
      cleanup: true,
    });
  });

  it("filters extract_folder inputs to supported immediate files", async () => {
    process.env.SUPARSE_API_KEY = "test-key";
    const folder = path.join(tempHome, "docs");
    await mkdir(folder);
    await writeFile(path.join(folder, "invoice.pdf"), "");
    await writeFile(path.join(folder, "notes.txt"), "");
    await mkdir(path.join(folder, "nested"));
    await writeFile(path.join(folder, "nested", "nested.pdf"), "");

    await callTool("extract_folder", { folder_path: folder });

    expect(sdkMock.state.instances[0]?.processBatch).toHaveBeenCalledWith(
      [path.join(folder, "invoice.pdf")],
      {
        template_id: undefined,
        split: undefined,
      },
    );
  });

  it("downloads exports to disk through the SDK", async () => {
    process.env.SUPARSE_API_KEY = "test-key";

    const result = await callTool("download_results", {
      document_ids: ["doc-1"],
      format: "csv",
      output_path: "/tmp/out.csv",
    });

    expect(result.structuredContent).toEqual({
      format: "csv",
      export_type: "unified",
      output_path: "/tmp/export.json",
      document_ids: ["doc-1"],
    });
    expect(sdkMock.state.instances[0]?.downloadResults).toHaveBeenCalledWith(
      ["doc-1"],
      "/tmp/out.csv",
      {
        format: "csv",
        export_type: "unified",
      },
    );
  });

  it("deletes documents through the SDK", async () => {
    process.env.SUPARSE_API_KEY = "test-key";

    const result = await callTool("delete_documents", { document_ids: ["doc-1"] });

    expect(result.structuredContent).toEqual({ deleted: true, document_ids: ["doc-1"] });
    expect(sdkMock.state.instances[0]?.deleteDocuments).toHaveBeenCalledWith(["doc-1"]);
  });
});
