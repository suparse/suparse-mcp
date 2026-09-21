import { existsSync, readFileSync, realpathSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  SuparseAPIError,
  SuparseAuthError,
  SuparseError,
  SuparseNodeClient,
  VERSION as SDK_VERSION,
  ALLOWED_EXTENSIONS,
  type BatchResult,
  type DocumentExtractionResponse,
  type ExcelLayout,
  type ExportFormat,
  type ExportOptions,
  type ExportType,
  type ExtractionTemplateDetail,
  type ExtractionTemplateSummary,
  type FailedResult,
  getQuickSchemaRunId,
  type QuickSchemaCreateOptions,
  type QuickSchemaStartResult,
  type QuickSchemaStatusResult,
  type QuickSchemaTerminalResult,
  type SuparseNodeClientOptions,
  type TaskExport,
} from "@suparse/sdk/node";

const SERVER_NAME = "suparse-mcp";
const SERVER_VERSION = SDK_VERSION;
const API_KEY_NOT_FOUND_MESSAGE =
  "API key not found. Set SUPARSE_API_KEY or add apiKey to ~/.config/suparse/config.json.";

const extractOptionsSchema = {
  template_id: z
    .string()
    .optional()
    .describe(
      "Optional extraction template ID. Use only a non-system team template ID from list_templates. Do not pass system template IDs directly; ask the user to add the matching system template to their templates first. Omit to let Suparse auto-detect.",
    ),
  split: z
    .boolean()
    .optional()
    .describe("Enable auto-splitting of multi-page documents with mixed document types."),
  pdf_password: z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe(
      "Optional password for an encrypted PDF. Treat this as a secret; it is used only for the upload and is not returned in results.",
    ),
  folder_id: z
    .string()
    .min(1)
    .optional()
    .describe("Optional remote Suparse folder ID to assign to uploaded documents."),
  cleanup: z
    .boolean()
    .optional()
    .describe(
      "Only valid with result_mode return_json. Deletes processed Suparse documents after JSON results are returned, so later exports cannot be fetched from those document IDs.",
    ),
  result_mode: z
    .enum(["defer", "return_json"])
    .optional()
    .default("defer")
    .describe(
      "Controls whether extraction results in json format are returned directly. Use return_json only when you need the full JSON extraction in the MCP response. In all other cases you can retrieve the results in format of choice using download_results",
    ),
};

const clientOptionsSchema = {
  api_url: z
    .string()
    .url()
    .optional()
    .describe("Optional API base URL. Defaults to SUPARSE_API_URL or Suparse production API."),
};

const exportOptionsSchema = {
  export_type: z
    .enum(["original", "unified"])
    .optional()
    .describe("Export mode for JSON results. Defaults to unified."),
};

const downloadOptionsSchema = {
  format: z
    .enum(["json", "csv", "xlsx", "google_sheets"])
    .describe("Export format to write to local disk. Use this tool for csv and xlsx."),
  export_type: z
    .enum(["original", "unified"])
    .optional()
    .describe("Export mode for csv, xlsx, and google_sheets. Defaults to unified."),
  xlsx_layout: z
    .enum(["standard", "flat"])
    .optional()
    .describe("XLSX layout. Applies only to xlsx exports and defaults to standard."),
};

const templateSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  template_language: z.string(),
  template_group_id: z.string(),
  parent_template_id: z.string().nullable().optional(),
  version: z.number(),
  team_id: z.string().nullable().optional(),
  is_active: z.boolean(),
  is_system_template: z.boolean(),
  created_at: z.string(),
});

type TemplateSummary = z.infer<typeof templateSummarySchema>;

const templateDetailSchema = templateSummarySchema.extend({
  schema_definition: z.record(z.unknown()),
  prompt_set: z.record(z.unknown()),
  validation_rules: z.record(z.unknown()),
  created_by_user_id: z.string(),
  saved_document_id: z.string().nullable().optional(),
});

type TemplateDetail = z.infer<typeof templateDetailSchema>;
type TemplateRecord = TemplateSummary | TemplateDetail;

const taskExportSchema = z
  .object({
    task_id: z.string(),
    original_file: z.string(),
    total_documents_extracted: z.number(),
    documents: z.array(z.unknown()),
  })
  .passthrough();

const failedResultSchema = z.object({
  file: z.string(),
  error: z.string(),
});

const deferredExtractionSuccessSchema = z.object({
  file_path: z.string(),
  task_id: z.string(),
  document_ids: z.array(z.string()),
});

const deferredExtractionFailureSchema = z.object({
  file_path: z.string(),
  task_id: z.string().nullable(),
  error: z.string(),
});

const documentExtractionItemSchema = z
  .object({
    document_id: z.string(),
    file_name: z.string(),
    page_start: z.number(),
    page_end: z.number(),
    template_id: z.string().nullable(),
    credits_used: z.number(),
    extracted_data: z.record(z.unknown()),
  })
  .passthrough();

const quickSchemaSavedDocumentSchema = z
  .object({
    document_id: z.string(),
    template_id: z.string(),
    template_group_id: z.string(),
    ordinal: z.number(),
    page_start: z.number(),
    page_end: z.number(),
    schema_source: z.string(),
  })
  .passthrough();

const quickSchemaFailedDocumentSchema = z
  .object({
    ordinal: z.number(),
    page_start: z.number(),
    page_end: z.number(),
    error_code: z.string(),
    retryable: z.boolean(),
  })
  .passthrough();

const quickSchemaRunInitiatedSchema = z
  .object({
    run_id: z.string(),
    document_id: z.string(),
    status: z.literal("queued"),
    stage: z.string().optional(),
    path: z.string().optional(),
    upload_batch_id: z.string().nullable().optional(),
    source_upload_id: z.string().nullable().optional(),
    replayed: z.boolean().optional(),
    replay_state: z.string().nullable().optional(),
  })
  .passthrough();

const quickSchemaSourceConfirmSchema = z
  .object({
    document_id: z.string(),
    source_upload_id: z.string(),
    upload_batch_id: z.string(),
    quick_schema_run_id: z.string(),
    replayed: z.boolean(),
    replay_state: z.string().nullable().optional(),
  })
  .passthrough();

const quickSchemaRunProcessingSchema = z
  .object({
    status: z.literal("processing"),
    stage: z.string(),
    path: z.string(),
    parent_document_id: z.string().nullable().optional(),
    total_documents: z.number().nullable().optional(),
    completed_documents: z.number().nullable().optional(),
    failed_documents: z.number().nullable().optional(),
  })
  .passthrough();

const quickSchemaRunFailedSchema = z
  .object({
    status: z.literal("failed"),
    stage: z.string(),
    error_code: z.string(),
    error_message: z.string(),
    path: z.string(),
    parent_document_id: z.string().nullable().optional(),
    total_documents: z.number().nullable().optional(),
    failed_documents_count: z.number().nullable().optional(),
    can_retry_failed: z.boolean(),
  })
  .passthrough();

const quickSchemaRunCompletedSchema = z
  .object({
    status: z.literal("completed"),
    document_id: z.string(),
    saved_document_id: z.string(),
    template_id: z.string(),
    template_group_id: z.string(),
    path: z.string(),
  })
  .passthrough();

const quickSchemaMultipleCompletedSchema = z
  .object({
    status: z.enum(["completed", "completed_with_errors"]),
    path: z.literal("multiple"),
    parent_document_id: z.string(),
    total_documents: z.number(),
    completed_documents: z.number(),
    failed_documents_count: z.number(),
    saved_documents: z.array(quickSchemaSavedDocumentSchema),
    failed_documents: z.array(quickSchemaFailedDocumentSchema),
    can_retry_failed: z.boolean(),
  })
  .passthrough();

const quickSchemaStartResultSchema = z.union([
  quickSchemaRunInitiatedSchema,
  quickSchemaSourceConfirmSchema,
]);

const quickSchemaStatusResultSchema = z.union([
  quickSchemaRunProcessingSchema,
  quickSchemaRunFailedSchema,
  quickSchemaRunCompletedSchema,
  quickSchemaMultipleCompletedSchema,
]);

const quickSchemaTerminalResultSchema = z.union([
  quickSchemaRunFailedSchema,
  quickSchemaRunCompletedSchema,
  quickSchemaMultipleCompletedSchema,
]);

const TEMPLATE_AGENT_GUIDANCE =
  "Use team_templates for extraction. If no matching team template exists, check system_templates. When a matching system template exists, ask the user to add that system template to their templates in the Suparse UI before processing. If neither team_templates nor system_templates contains a matching template for the document type, ask the user to create a custom extraction schema for that document type in the Suparse UI.";

interface BatchResultPayload extends Record<string, unknown> {
  result_mode: "return_json";
  total: number;
  succeeded: TaskExport[];
  failed: FailedResult[];
}

interface DeferredExtractionSuccess {
  file_path: string;
  task_id: string;
  document_ids: string[];
}

interface DeferredExtractionFailure {
  file_path: string;
  task_id: string | null;
  error: string;
}

interface DeferredBatchResultPayload extends Record<string, unknown> {
  result_mode: "defer";
  total: number;
  succeeded: DeferredExtractionSuccess[];
  failed: DeferredExtractionFailure[];
}

interface TemplatesPayload extends Record<string, unknown> {
  templates: TemplateRecord[];
  team_templates: TemplateRecord[];
  system_templates: TemplateRecord[];
  agent_guidance: string;
}

interface FetchResultsPayload extends Record<string, unknown> {
  format: "json";
  export_type: ExportType;
  results: TaskExport[];
}

interface DownloadResultsPayload extends Record<string, unknown> {
  format: ExportFormat;
  export_type: ExportType;
  xlsx_layout?: ExcelLayout;
  output_path: string;
  document_ids: string[];
}

interface DocumentResultPayload extends Record<string, unknown> {
  task_id: string;
  original_file: string;
  total_documents_extracted: number;
  documents: DocumentExtractionResponse["documents"];
}

interface QuickSchemaStartPayload extends Record<string, unknown> {
  run_id: string;
  result: QuickSchemaStartResult;
}

interface QuickSchemaStatusPayload extends Record<string, unknown> {
  run_id: string;
  result: QuickSchemaStatusResult;
}

interface QuickSchemaTerminalPayload extends Record<string, unknown> {
  run_id: string;
  result: QuickSchemaTerminalResult;
}

interface ToolErrorPayload extends Record<string, unknown> {
  error: string;
  status_code?: number;
  code?: string;
  meta?: Record<string, unknown>;
}

interface DeleteDocumentsPayload extends Record<string, unknown> {
  deleted: boolean;
  document_ids: string[];
}

function getConfigApiKey(): string | undefined {
  const configPath = path.join(os.homedir(), ".config", "suparse", "config.json");
  if (!existsSync(configPath)) return undefined;

  const config = JSON.parse(readFileSync(configPath, "utf-8")) as { apiKey?: unknown };
  return typeof config.apiKey === "string" && config.apiKey ? config.apiKey : undefined;
}

function getApiKey(): string {
  const apiKey = process.env.SUPARSE_API_KEY ?? getConfigApiKey();
  if (!apiKey) throw new Error(API_KEY_NOT_FOUND_MESSAGE);
  return apiKey;
}

function redactSecret(value: unknown, secret?: string): unknown {
  if (!secret) return value;
  if (typeof value === "string") return value.split(secret).join("[redacted]");
  if (Array.isArray(value)) return value.map((item) => redactSecret(item, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSecret(item, secret)]),
    );
  }
  return value;
}

function formatErrorMessage(error: unknown, secret?: string): string {
  let message = error instanceof Error ? error.message : String(error);

  if (error instanceof SuparseAuthError) {
    message = `Permission denied (${error.statusCode}): ${error.message}. Check SUPARSE_API_KEY.`;
  } else if (error instanceof SuparseAPIError) {
    message = `API error (${error.statusCode}): ${error.message}`;
  } else if (error instanceof SuparseError) {
    message = `Suparse error: ${error.message}`;
  }

  return redactSecret(message, secret) as string;
}

function buildExportOptions(
  format: ExportFormat,
  exportType: ExportType,
  xlsxLayout?: ExcelLayout,
): ExportOptions {
  const options: ExportOptions = {
    format,
    export_type: exportType,
  };
  if (xlsxLayout !== undefined) options.xlsxLayout = xlsxLayout;
  return options;
}

function buildQuickSchemaOptions(
  pdfPassword?: string,
  folderId?: string,
  uploadBatchId?: string,
  sourceUploadId?: string,
): QuickSchemaCreateOptions | undefined {
  const options: QuickSchemaCreateOptions = {};
  if (pdfPassword !== undefined) options.pdf_password = pdfPassword;
  if (folderId !== undefined) options.folder_id = folderId;
  if (uploadBatchId !== undefined) options.upload_batch_id = uploadBatchId;
  if (sourceUploadId !== undefined) options.source_upload_id = sourceUploadId;
  return Object.keys(options).length > 0 ? options : undefined;
}

function mapTemplate(
  template: ExtractionTemplateSummary | ExtractionTemplateDetail,
): TemplateRecord {
  const summary: TemplateSummary = {
    id: template.id,
    name: template.name,
    description: template.description,
    template_language: template.template_language,
    template_group_id: template.template_group_id,
    parent_template_id: template.parent_template_id,
    version: template.version,
    team_id: template.team_id,
    is_active: template.is_active,
    is_system_template: template.is_system_template,
    created_at: template.created_at,
  };

  if ("schema_definition" in template) {
    return {
      ...summary,
      schema_definition: template.schema_definition,
      prompt_set: template.prompt_set,
      validation_rules: template.validation_rules,
      created_by_user_id: template.created_by_user_id,
      saved_document_id: template.saved_document_id,
    };
  }

  return summary;
}

function createClient(apiUrl?: string): SuparseNodeClient {
  const options: SuparseNodeClientOptions = { apiKey: getApiKey() };
  const baseUrl = apiUrl ?? process.env.SUPARSE_API_URL;
  if (baseUrl) options.baseUrl = baseUrl;
  return new SuparseNodeClient(options);
}

function toBatchResultPayload(result: BatchResult): BatchResultPayload {
  return {
    result_mode: "return_json",
    total: result.total,
    succeeded: result.succeeded,
    failed: result.failed,
  };
}

async function listSupportedFolderFiles(folderPath: string): Promise<string[]> {
  const resolved = path.resolve(folderPath);
  const folderStats = await stat(resolved);
  if (!folderStats.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }

  return (await readdir(resolved))
    .filter((entry) => ALLOWED_EXTENSIONS.has(path.extname(entry).toLowerCase()))
    .sort()
    .map((entry) => path.join(resolved, entry));
}

function toolResult<T extends Record<string, unknown>>(
  text: string,
  structuredContent: T,
): {
  content: { type: "text"; text: string }[];
  structuredContent: T;
} {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
  };
}

function toolError(error: unknown): {
  isError: boolean;
  content: { type: "text"; text: string }[];
  structuredContent?: ToolErrorPayload;
} {
  return toolErrorWithSecret(error);
}

function toolErrorWithSecret(error: unknown, secret?: string): {
  isError: boolean;
  content: { type: "text"; text: string }[];
  structuredContent: ToolErrorPayload;
} {
  const message = formatErrorMessage(error, secret);
  const payload: ToolErrorPayload = { error: message };

  if (error instanceof SuparseAPIError) {
    payload.status_code = error.statusCode;
    if (error.code) payload.code = error.code;
    if (error.meta) payload.meta = redactSecret(error.meta, secret) as Record<string, unknown>;
  }

  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
    structuredContent: payload,
  };
}

function summarizeBatch(payload: BatchResultPayload): string {
  return JSON.stringify(
    {
      result_mode: payload.result_mode,
      total: payload.total,
      succeeded: payload.succeeded.length,
      failed: payload.failed.length,
    },
    null,
    2,
  );
}

function summarizeDeferredBatch(payload: DeferredBatchResultPayload): string {
  return JSON.stringify(
    {
      result_mode: payload.result_mode,
      total: payload.total,
      succeeded: payload.succeeded.length,
      failed: payload.failed.length,
      document_ids: payload.succeeded.flatMap((item) => item.document_ids),
    },
    null,
    2,
  );
}

export function createSuparseMcpServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "extract_file",
    {
      title: "Extract File",
      description:
        "Process one local document through Suparse. Defaults to result_mode defer, which uploads and polls only, then returns compact task_id/document_ids for later download_results. Use result_mode return_json only when you need the full JSON extraction in the MCP response. cleanup is only valid with return_json.",
      inputSchema: {
        file_path: z.string().min(1).describe("Local path to a supported document file."),
        ...extractOptionsSchema,
        ...clientOptionsSchema,
      },
      outputSchema: {
        result_mode: z.enum(["defer", "return_json"]),
        total: z.number(),
        succeeded: z.array(z.union([deferredExtractionSuccessSchema, taskExportSchema])),
        failed: z.array(z.union([deferredExtractionFailureSchema, failedResultSchema])),
      },
    },
    async ({ file_path, template_id, split, pdf_password, folder_id, cleanup, result_mode, api_url }) => {
      let client: SuparseNodeClient | undefined;
      try {
        client = createClient(api_url);
        const mode = result_mode ?? "defer";
        if (mode === "defer") {
          if (cleanup) {
            throw new Error(
              "cleanup is only valid with result_mode return_json. Use download_results first, then delete_documents.",
            );
          }

          let taskId: string | null = null;
          try {
            taskId = await client.uploadFile(file_path, {
              template_id,
              split,
              pdf_password,
              folder_id,
            });
            const { documentIds } = await client.pollTaskStatus(taskId);
            const payload: DeferredBatchResultPayload = {
              result_mode: "defer",
              total: 1,
              succeeded: [{ file_path, task_id: taskId, document_ids: documentIds }],
              failed: [],
            };
            return toolResult(summarizeDeferredBatch(payload), payload);
          } catch (error) {
            const payload: DeferredBatchResultPayload = {
              result_mode: "defer",
              total: 1,
              succeeded: [],
              failed: [
                {
                  file_path,
                  task_id: taskId,
                  error: formatErrorMessage(error, pdf_password),
                },
              ],
            };
            return toolResult(summarizeDeferredBatch(payload), payload);
          }
        }

        const result = await client.extract(file_path, {
          template_id,
          split,
          pdf_password,
          folder_id,
          cleanup,
        });
        const payload = toBatchResultPayload(result);
        return toolResult(summarizeBatch(payload), payload);
      } catch (error) {
        return toolErrorWithSecret(error, pdf_password);
      } finally {
        await client?.close();
      }
    },
  );

  server.registerTool(
    "extract_folder",
    {
      title: "Extract Folder",
      description:
        "Process all supported files in an immediate local folder through Suparse. Defaults to result_mode defer, which uploads and polls only, then returns compact task_id/document_ids for later download_results. Use result_mode return_json only when you need full JSON extractions in the MCP response. cleanup is only valid with return_json.",
      inputSchema: {
        folder_path: z
          .string()
          .min(1)
          .describe("Local folder containing supported document files."),
        ...extractOptionsSchema,
        ...clientOptionsSchema,
      },
      outputSchema: {
        result_mode: z.enum(["defer", "return_json"]),
        total: z.number(),
        succeeded: z.array(z.union([deferredExtractionSuccessSchema, taskExportSchema])),
        failed: z.array(z.union([deferredExtractionFailureSchema, failedResultSchema])),
      },
    },
    async ({
      folder_path,
      template_id,
      split,
      pdf_password,
      folder_id,
      cleanup,
      result_mode,
      api_url,
    }) => {
      let client: SuparseNodeClient | undefined;
      try {
        client = createClient(api_url);
        const mode = result_mode ?? "defer";
        if (mode === "defer") {
          if (cleanup) {
            throw new Error(
              "cleanup is only valid with result_mode return_json. Use download_results first, then delete_documents.",
            );
          }

          const files = await listSupportedFolderFiles(folder_path);
          const result = await client.processBatch(files, {
            template_id,
            split,
            pdf_password,
            folder_id,
          });
          const payload: DeferredBatchResultPayload = {
            result_mode: "defer",
            total: result.succeeded.length + result.failed.length,
            succeeded: result.succeeded.map((item) => ({
              file_path: item.filePath,
              task_id: item.taskId,
              document_ids: item.documentIds,
            })),
            failed: result.failed.map((item) => ({
              file_path: item.filePath,
              task_id: item.taskId,
              error: formatErrorMessage(item.error, pdf_password),
            })),
          };
          return toolResult(summarizeDeferredBatch(payload), payload);
        }

        const result = await client.extractFolder(folder_path, {
          template_id,
          split,
          pdf_password,
          folder_id,
          cleanup,
        });
        const payload = toBatchResultPayload(result);
        return toolResult(summarizeBatch(payload), payload);
      } catch (error) {
        return toolErrorWithSecret(error, pdf_password);
      } finally {
        await client?.close();
      }
    },
  );

  server.registerTool(
    "list_templates",
    {
      title: "List Templates",
      description:
        "List extraction templates for choosing an extraction template. Summary view is the default; use full view only when schema, prompt, or validation details are needed. Agents must use team_templates for processing. System templates are discovery-only in MCP: if a matching system template exists but no matching team template exists, ask the user to add that system template to their templates in the Suparse UI before processing. If no matching team or system template exists, ask the user to create a custom extraction schema for that document type in the Suparse UI.",
      inputSchema: {
        include_system: z
          .boolean()
          .optional()
          .describe(
            "Include discovery-only system templates in addition to team templates. System templates returned here are not directly usable for extraction through MCP until the user adds them to their templates in the Suparse UI.",
          ),
        view: z
          .enum(["summary", "full"])
          .optional()
          .default("summary")
          .describe(
            "Template response view. Summary is compact and recommended for normal template selection; full includes schema, prompts, validation rules, and creator metadata.",
          ),
        ...clientOptionsSchema,
      },
      outputSchema: {
        templates: z.array(z.union([templateSummarySchema, templateDetailSchema])),
        team_templates: z.array(z.union([templateSummarySchema, templateDetailSchema])),
        system_templates: z.array(z.union([templateSummarySchema, templateDetailSchema])),
        agent_guidance: z.string(),
      },
    },
    async ({ include_system, view, api_url }) => {
      let client: SuparseNodeClient | undefined;
      try {
        client = createClient(api_url);
        const templates =
          view === "full"
            ? await client.listTemplates({ includeSystem: include_system, view: "full" })
            : await client.listTemplates({ includeSystem: include_system, view: "summary" });
        const mappedTemplates = templates.map(mapTemplate);
        const teamTemplates = mappedTemplates.filter((template) => !template.is_system_template);
        const systemTemplates = mappedTemplates.filter((template) => template.is_system_template);
        const payload: TemplatesPayload = {
          templates: mappedTemplates,
          team_templates: teamTemplates,
          system_templates: systemTemplates,
          agent_guidance: TEMPLATE_AGENT_GUIDANCE,
        };
        return toolResult(
          JSON.stringify(
            {
              found: payload.templates.length,
              team_templates: payload.team_templates.length,
              system_templates: payload.system_templates.length,
              agent_guidance: payload.agent_guidance,
            },
            null,
            2,
          ),
          payload,
        );
      } catch (error) {
        return toolError(error);
      } finally {
        await client?.close();
      }
    },
  );

  server.registerTool(
    "start_quick_schema_creation",
    {
      title: "Start Quick Schema Creation",
      description:
        "Start automatic schema creation for one local document. Returns a normalized run_id and the SDK result. Use get_quick_schema_creation or wait_for_quick_schema_creation to follow the run. Supply upload_batch_id and source_upload_id only when an external batched-upload workflow provides them.",
      inputSchema: {
        file_path: z.string().min(1).describe("Local path to a supported document file."),
        pdf_password: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe("Optional encrypted-PDF password. Treat this as a secret."),
        folder_id: z
          .string()
          .min(1)
          .optional()
          .describe("Optional remote Suparse folder ID to assign to the source document."),
        upload_batch_id: z
          .string()
          .min(1)
          .optional()
          .describe("Optional existing upload batch ID from an external batch workflow."),
        source_upload_id: z
          .string()
          .min(1)
          .optional()
          .describe("Optional source upload ID from an external batch workflow."),
        ...clientOptionsSchema,
      },
      outputSchema: {
        run_id: z.string(),
        result: quickSchemaStartResultSchema,
      },
    },
    async ({
      file_path,
      pdf_password,
      folder_id,
      upload_batch_id,
      source_upload_id,
      api_url,
    }) => {
      let client: SuparseNodeClient | undefined;
      try {
        client = createClient(api_url);
        const result = await client.startQuickSchemaCreation(
          file_path,
          buildQuickSchemaOptions(pdf_password, folder_id, upload_batch_id, source_upload_id),
        );
        const payload: QuickSchemaStartPayload = {
          run_id: getQuickSchemaRunId(result),
          result,
        };
        return toolResult(JSON.stringify(payload, null, 2), payload);
      } catch (error) {
        return toolErrorWithSecret(error, pdf_password);
      } finally {
        await client?.close();
      }
    },
  );

  server.registerTool(
    "get_quick_schema_creation",
    {
      title: "Get Quick Schema Creation",
      description:
        "Fetch the current automatic schema creation status for a run ID. Returns the raw typed SDK result together with the requested run_id.",
      inputSchema: {
        run_id: z.string().min(1).describe("Quick schema creation run ID."),
        ...clientOptionsSchema,
      },
      outputSchema: {
        run_id: z.string(),
        result: quickSchemaStatusResultSchema,
      },
    },
    async ({ run_id, api_url }) => {
      let client: SuparseNodeClient | undefined;
      try {
        client = createClient(api_url);
        const result = await client.getQuickSchemaCreation(run_id);
        const payload: QuickSchemaStatusPayload = { run_id, result };
        return toolResult(JSON.stringify(payload, null, 2), payload);
      } catch (error) {
        return toolError(error);
      } finally {
        await client?.close();
      }
    },
  );

  server.registerTool(
    "wait_for_quick_schema_creation",
    {
      title: "Wait for Quick Schema Creation",
      description:
        "Poll an automatic schema creation run until it reaches completed, completed_with_errors, or failed. The terminal result preserves generated template IDs, saved documents, failed-document details, and retryability.",
      inputSchema: {
        run_id: z.string().min(1).describe("Quick schema creation run ID."),
        poll_interval: z
          .number()
          .nonnegative()
          .optional()
          .describe("Seconds between status requests. Defaults to the SDK client setting."),
        max_poll_attempts: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum status requests before timing out. Defaults to the SDK client setting."),
        ...clientOptionsSchema,
      },
      outputSchema: {
        run_id: z.string(),
        result: quickSchemaTerminalResultSchema,
      },
    },
    async ({ run_id, poll_interval, max_poll_attempts, api_url }) => {
      let client: SuparseNodeClient | undefined;
      try {
        client = createClient(api_url);
        const result = await client.waitForQuickSchemaCreation(run_id, {
          pollInterval: poll_interval,
          maxPollAttempts: max_poll_attempts,
        });
        const payload: QuickSchemaTerminalPayload = { run_id, result };
        return toolResult(JSON.stringify(payload, null, 2), payload);
      } catch (error) {
        return toolError(error);
      } finally {
        await client?.close();
      }
    },
  );

  server.registerTool(
    "fetch_json_results",
    {
      title: "Fetch JSON Results",
      description:
        "Fetch JSON extraction results for one or more Suparse document IDs directly in the MCP response. This can be large; use only when you need the full JSON in context. For CSV, XLSX, Google Sheets, or saved JSON files, use download_results. If you need cleanup after fetching, call delete_documents after this tool succeeds.",
      inputSchema: {
        document_ids: z.array(z.string().min(1)).min(1).describe("Suparse document IDs to export."),
        ...exportOptionsSchema,
        ...clientOptionsSchema,
      },
      outputSchema: {
        format: z.literal("json"),
        export_type: z.enum(["original", "unified"]),
        results: z.array(taskExportSchema),
      },
    },
    async ({ document_ids, export_type, api_url }) => {
      let client: SuparseNodeClient | undefined;
      try {
        client = createClient(api_url);
        const exportType = export_type ?? "unified";
        const exportResult = await client.fetchResults(document_ids, {
          format: "json",
          export_type: exportType,
        });
        const payload: FetchResultsPayload = {
          format: "json",
          export_type: exportType,
          results: exportResult,
        };
        return toolResult(JSON.stringify(payload, null, 2), payload);
      } catch (error) {
        return toolError(error);
      } finally {
        await client?.close();
      }
    },
  );

  server.registerTool(
    "fetch_document_result",
    {
      title: "Fetch Document Result",
      description:
        "Fetch the structured JSON result for one processed Suparse document using the direct single-document result endpoint. Use fetch_json_results when fetching multiple document IDs or an export selection.",
      inputSchema: {
        document_id: z.string().min(1).describe("Suparse document ID to fetch."),
        ...clientOptionsSchema,
      },
      outputSchema: {
        task_id: z.string(),
        original_file: z.string(),
        total_documents_extracted: z.number(),
        documents: z.array(documentExtractionItemSchema),
      },
    },
    async ({ document_id, api_url }) => {
      let client: SuparseNodeClient | undefined;
      try {
        client = createClient(api_url);
        const result = await client.getDocumentResult(document_id);
        const payload: DocumentResultPayload = {
          task_id: result.task_id,
          original_file: result.original_file,
          total_documents_extracted: result.total_documents_extracted,
          documents: result.documents,
        };
        return toolResult(JSON.stringify(payload, null, 2), payload);
      } catch (error) {
        return toolError(error);
      } finally {
        await client?.close();
      }
    },
  );

  server.registerTool(
    "download_results",
    {
      title: "Download Results",
      description:
        "Fetch an export for one or more Suparse document IDs and write it directly to local disk. Use this for CSV, XLSX, Google Sheets, and saved JSON files. Do not call fetch_json_results unless you intentionally need full JSON in the MCP response. If output_path is a directory, the API-provided filename is used inside that directory. If cleanup is needed, call delete_documents after this tool succeeds.",
      inputSchema: {
        document_ids: z.array(z.string().min(1)).min(1).describe("Suparse document IDs to export."),
        output_path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Optional local output file path or existing directory. When omitted, writes to the current working directory using the API-provided or generated filename.",
          ),
        ...downloadOptionsSchema,
        ...clientOptionsSchema,
      },
      outputSchema: {
        format: z.enum(["json", "csv", "xlsx", "google_sheets"]),
        export_type: z.enum(["original", "unified"]),
        xlsx_layout: z.enum(["standard", "flat"]).optional(),
        output_path: z.string(),
        document_ids: z.array(z.string()),
      },
    },
    async ({ document_ids, output_path, format, export_type, xlsx_layout, api_url }) => {
      let client: SuparseNodeClient | undefined;
      try {
        client = createClient(api_url);
        const exportType = export_type ?? "unified";
        const outputPath = await client.downloadResults(
          document_ids,
          output_path,
          buildExportOptions(format, exportType, xlsx_layout),
        );
        const payload: DownloadResultsPayload = {
          format,
          export_type: exportType,
          output_path: outputPath,
          document_ids,
        };
        if (xlsx_layout !== undefined) payload.xlsx_layout = xlsx_layout;
        return toolResult(JSON.stringify(payload, null, 2), payload);
      } catch (error) {
        return toolError(error);
      } finally {
        await client?.close();
      }
    },
  );

  server.registerTool(
    "delete_documents",
    {
      title: "Delete Documents",
      description: "Delete one or more documents from Suparse by document ID.",
      inputSchema: {
        document_ids: z.array(z.string().min(1)).min(1).describe("Suparse document IDs to delete."),
        ...clientOptionsSchema,
      },
      outputSchema: {
        deleted: z.boolean(),
        document_ids: z.array(z.string()),
      },
    },
    async ({ document_ids, api_url }) => {
      let client: SuparseNodeClient | undefined;
      try {
        client = createClient(api_url);
        const payload: DeleteDocumentsPayload = {
          deleted: await client.deleteDocuments(document_ids),
          document_ids,
        };
        return toolResult(JSON.stringify(payload, null, 2), payload);
      } catch (error) {
        return toolError(error);
      } finally {
        await client?.close();
      }
    },
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  const server = createSuparseMcpServer();
  await server.connect(new StdioServerTransport());
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
}

if (isDirectRun()) {
  runMcpServer().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
