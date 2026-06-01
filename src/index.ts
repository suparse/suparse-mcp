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
  type ExportFormat,
  type ExportType,
  type FailedResult,
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
};

const templateSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  template_language: z.string(),
  version: z.number(),
  is_active: z.boolean(),
  is_system_template: z.boolean(),
  created_at: z.string(),
});

type TemplateSummary = z.infer<typeof templateSummarySchema>;

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
  templates: TemplateSummary[];
  team_templates: TemplateSummary[];
  system_templates: TemplateSummary[];
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
  output_path: string;
  document_ids: string[];
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

function createClient(apiUrl?: string): SuparseNodeClient {
  const options: SuparseNodeClientOptions = { apiKey: getApiKey() };
  if (apiUrl) options.baseUrl = apiUrl;
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
} {
  let message = error instanceof Error ? error.message : String(error);

  if (error instanceof SuparseAuthError) {
    message = `Permission denied (${error.statusCode}): ${error.message}. Check SUPARSE_API_KEY.`;
  } else if (error instanceof SuparseAPIError) {
    message = `API error (${error.statusCode}): ${error.message}`;
  } else if (error instanceof SuparseError) {
    message = `Suparse error: ${error.message}`;
  }

  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
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
    async ({ file_path, template_id, split, cleanup, result_mode, api_url }) => {
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
                  error: error instanceof Error ? error.message : String(error),
                },
              ],
            };
            return toolResult(summarizeDeferredBatch(payload), payload);
          }
        }

        const result = await client.extract(file_path, {
          template_id,
          split,
          cleanup,
        });
        const payload = toBatchResultPayload(result);
        return toolResult(summarizeBatch(payload), payload);
      } catch (error) {
        return toolError(error);
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
    async ({ folder_path, template_id, split, cleanup, result_mode, api_url }) => {
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
              error: item.error.message,
            })),
          };
          return toolResult(summarizeDeferredBatch(payload), payload);
        }

        const result = await client.extractFolder(folder_path, {
          template_id,
          split,
          cleanup,
        });
        const payload = toBatchResultPayload(result);
        return toolResult(summarizeBatch(payload), payload);
      } catch (error) {
        return toolError(error);
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
        "List extraction templates for choosing an extraction template. Agents must use team_templates for processing. System templates are discovery-only in MCP: if a matching system template exists but no matching team template exists, ask the user to add that system template to their templates in the Suparse UI before processing. If no matching team or system template exists, ask the user to create a custom extraction schema for that document type in the Suparse UI.",
      inputSchema: {
        include_system: z
          .boolean()
          .optional()
          .describe(
            "Include discovery-only system templates in addition to team templates. System templates returned here are not directly usable for extraction through MCP until the user adds them to their templates in the Suparse UI.",
          ),
        ...clientOptionsSchema,
      },
      outputSchema: {
        templates: z.array(templateSummarySchema),
        team_templates: z.array(templateSummarySchema),
        system_templates: z.array(templateSummarySchema),
        agent_guidance: z.string(),
      },
    },
    async ({ include_system, api_url }) => {
      let client: SuparseNodeClient | undefined;
      try {
        client = createClient(api_url);
        const templates = await client.listTemplates({ includeSystem: include_system });
        const mappedTemplates = templates.map(
          ({
            id,
            name,
            description,
            template_language,
            version,
            is_active,
            is_system_template,
            created_at,
          }) => ({
            id,
            name,
            description,
            template_language,
            version,
            is_active,
            is_system_template,
            created_at,
          }),
        );
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
        output_path: z.string(),
        document_ids: z.array(z.string()),
      },
    },
    async ({ document_ids, output_path, format, export_type, api_url }) => {
      let client: SuparseNodeClient | undefined;
      try {
        client = createClient(api_url);
        const exportType = export_type ?? "unified";
        const outputPath = await client.downloadResults(document_ids, output_path, {
          format,
          export_type: exportType,
        });
        const payload: DownloadResultsPayload = {
          format,
          export_type: exportType,
          output_path: outputPath,
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
