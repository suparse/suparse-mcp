import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdkMock = vi.hoisted(() => {
  class SuparseError extends Error {}

  class SuparseAPIError extends SuparseError {
    statusCode: number;
    code?: string;
    meta?: Record<string, unknown>;

    constructor(
      message = "API failed",
      statusCode = 500,
      _responseBody = "",
      details?: { code?: string; meta?: Record<string, unknown> },
    ) {
      super(message);
      this.statusCode = statusCode;
      this.code = details?.code;
      this.meta = details?.meta;
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
    getDocumentResult: ReturnType<typeof vi.fn>;
    getQuickSchemaCreation: ReturnType<typeof vi.fn>;
    listTemplates: ReturnType<typeof vi.fn>;
    options: unknown;
    pollTaskStatus: ReturnType<typeof vi.fn>;
    processBatch: ReturnType<typeof vi.fn>;
    startQuickSchemaCreation: ReturnType<typeof vi.fn>;
    uploadFile: ReturnType<typeof vi.fn>;
    waitForQuickSchemaCreation: ReturnType<typeof vi.fn>;
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
    this.getDocumentResult = vi.fn(async () => ({
      task_id: "task-1",
      original_file: "invoice.pdf",
      total_documents_extracted: 1,
      documents: [
        {
          document_id: "doc-1",
          file_name: "invoice.pdf",
          page_start: 1,
          page_end: 1,
          template_id: "team-template",
          credits_used: 1,
          extracted_data: { total: 10 },
        },
      ],
    }));
    this.getQuickSchemaCreation = vi.fn(async () => ({
      status: "completed",
      document_id: "doc-1",
      saved_document_id: "saved-doc-1",
      template_id: "team-template",
      template_group_id: "team-template-group",
      path: "generated",
    }));
    this.listTemplates = vi.fn(async () => [
      {
        id: "team-template",
        name: "Invoice",
        description: null,
        template_language: "en",
        template_group_id: "team-template-group",
        parent_template_id: null,
        version: 1,
        team_id: "team-1",
        is_active: true,
        is_system_template: false,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "system-template",
        name: "Receipt",
        description: "System receipt template",
        template_language: "en",
        template_group_id: "system-template-group",
        parent_template_id: null,
        version: 1,
        team_id: null,
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
    this.startQuickSchemaCreation = vi.fn(async () => ({
      run_id: "run-1",
      document_id: "doc-1",
      status: "queued",
      stage: "template_matching",
      path: "pending",
    }));
    this.uploadFile = vi.fn(async () => "task-1");
    this.waitForQuickSchemaCreation = vi.fn(async () => ({
      status: "completed",
      document_id: "doc-1",
      saved_document_id: "saved-doc-1",
      template_id: "team-template",
      template_group_id: "team-template-group",
      path: "generated",
    }));

    if (state.nextClient) Object.assign(this, state.nextClient);
    state.instances.push(this);
  });

  return {
    ALLOWED_EXTENSIONS: new Set([".pdf", ".png", ".jpg", ".jpeg"]),
    SuparseAPIError,
    SuparseAuthError,
    SuparseError,
    SuparseNodeClient,
    VERSION: "1.4.0",
    getQuickSchemaRunId: (result: { run_id?: string; quick_schema_run_id?: string }) =>
      result.run_id ?? result.quick_schema_run_id ?? "",
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
      "fetch_document_result",
      "fetch_json_results",
      "get_quick_schema_creation",
      "list_templates",
      "start_quick_schema_creation",
      "wait_for_quick_schema_creation",
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

  it("uses SUPARSE_API_URL when no per-tool API URL override is provided", async () => {
    process.env.SUPARSE_API_KEY = "test-key";
    process.env.SUPARSE_API_URL = "https://env-api.example.test/v1";

    await callTool("list_templates", {});

    expect(sdkMock.state.instances[0]?.options).toEqual({
      apiKey: "test-key",
      baseUrl: "https://env-api.example.test/v1",
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
      pdf_password: undefined,
      folder_id: undefined,
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
      pdf_password: undefined,
      folder_id: undefined,
      cleanup: true,
    });
  });

  it("forwards encrypted-PDF and remote-folder options", async () => {
    process.env.SUPARSE_API_KEY = "test-key";

    await callTool("extract_file", {
      file_path: "/tmp/encrypted-invoice.pdf",
      pdf_password: "secret-password",
      folder_id: "remote-folder-1",
      result_mode: "return_json",
    });

    expect(sdkMock.state.instances[0]?.extract).toHaveBeenCalledWith(
      "/tmp/encrypted-invoice.pdf",
      {
        template_id: undefined,
        split: undefined,
        pdf_password: "secret-password",
        folder_id: "remote-folder-1",
        cleanup: undefined,
      },
    );
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
        pdf_password: undefined,
        folder_id: undefined,
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

  it("forwards XLSX layout selection and reports it", async () => {
    process.env.SUPARSE_API_KEY = "test-key";

    const result = await callTool("download_results", {
      document_ids: ["doc-1"],
      format: "xlsx",
      xlsx_layout: "flat",
    });

    expect(result.structuredContent).toEqual({
      format: "xlsx",
      export_type: "unified",
      xlsx_layout: "flat",
      output_path: "/tmp/export.json",
      document_ids: ["doc-1"],
    });
    expect(sdkMock.state.instances[0]?.downloadResults).toHaveBeenCalledWith(
      ["doc-1"],
      undefined,
      {
        format: "xlsx",
        export_type: "unified",
        xlsxLayout: "flat",
      },
    );
  });

  it("fetches a single document result through the SDK", async () => {
    process.env.SUPARSE_API_KEY = "test-key";

    const result = await callTool("fetch_document_result", { document_id: "doc-1" });

    expect(result.structuredContent).toEqual({
      task_id: "task-1",
      original_file: "invoice.pdf",
      total_documents_extracted: 1,
      documents: [
        {
          document_id: "doc-1",
          file_name: "invoice.pdf",
          page_start: 1,
          page_end: 1,
          template_id: "team-template",
          credits_used: 1,
          extracted_data: { total: 10 },
        },
      ],
    });
    expect(sdkMock.state.instances[0]?.getDocumentResult).toHaveBeenCalledWith("doc-1");
  });

  it("starts quick schema creation and normalizes the run ID", async () => {
    process.env.SUPARSE_API_KEY = "test-key";

    const result = await callTool("start_quick_schema_creation", {
      file_path: "/tmp/receipt.pdf",
      pdf_password: "pdf-secret",
      folder_id: "folder-1",
      upload_batch_id: "batch-1",
      source_upload_id: "source-1",
    });

    expect(result.structuredContent).toEqual({
      run_id: "run-1",
      result: {
        run_id: "run-1",
        document_id: "doc-1",
        status: "queued",
        stage: "template_matching",
        path: "pending",
      },
    });
    expect(sdkMock.state.instances[0]?.startQuickSchemaCreation).toHaveBeenCalledWith(
      "/tmp/receipt.pdf",
      {
        pdf_password: "pdf-secret",
        folder_id: "folder-1",
        upload_batch_id: "batch-1",
        source_upload_id: "source-1",
      },
    );
  });

  it("gets and waits for quick schema creation", async () => {
    process.env.SUPARSE_API_KEY = "test-key";

    const status = await callTool("get_quick_schema_creation", { run_id: "run-1" });
    const terminal = await callTool("wait_for_quick_schema_creation", {
      run_id: "run-1",
      poll_interval: 1,
      max_poll_attempts: 5,
    });

    expect(status.structuredContent).toMatchObject({ run_id: "run-1", result: { status: "completed" } });
    expect(terminal.structuredContent).toMatchObject({
      run_id: "run-1",
      result: { status: "completed", saved_document_id: "saved-doc-1" },
    });
    expect(sdkMock.state.instances[0]?.getQuickSchemaCreation).toHaveBeenCalledWith("run-1");
    expect(sdkMock.state.instances[1]?.waitForQuickSchemaCreation).toHaveBeenCalledWith("run-1", {
      pollInterval: 1,
      maxPollAttempts: 5,
    });
  });

  it("preserves structured API errors while redacting PDF passwords", async () => {
    process.env.SUPARSE_API_KEY = "test-key";
    sdkMock.state.nextClient = {
      startQuickSchemaCreation: vi.fn(async () => {
        throw new sdkMock.SuparseAPIError("pdf-secret", 400, "", {
          code: "INVALID_PDF_PASSWORD",
          meta: { rejected_value: "pdf-secret" },
        });
      }),
    };

    const result = await callTool("start_quick_schema_creation", {
      file_path: "/tmp/encrypted.pdf",
      pdf_password: "pdf-secret",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe("API error (400): [redacted]");
    expect(result.structuredContent).toEqual({
      error: "API error (400): [redacted]",
      status_code: 400,
      code: "INVALID_PDF_PASSWORD",
      meta: { rejected_value: "[redacted]" },
    });
  });

  it("deletes documents through the SDK", async () => {
    process.env.SUPARSE_API_KEY = "test-key";

    const result = await callTool("delete_documents", { document_ids: ["doc-1"] });

    expect(result.structuredContent).toEqual({ deleted: true, document_ids: ["doc-1"] });
    expect(sdkMock.state.instances[0]?.deleteDocuments).toHaveBeenCalledWith(["doc-1"]);
  });
});
