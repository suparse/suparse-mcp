# @suparse/mcp

## 1.2.0

### Minor Changes

- Change MCP extraction to defer by default, add `download_results`, rename direct JSON fetching to `fetch_json_results`, and return compact template summaries from the SDK.

### Patch Changes

- Updated dependencies
  - @suparse/sdk@1.2.0

## 1.1.0

### Minor Changes

- Add MCP server support and expanded export formats.

  The SDK now supports JSON, CSV, XLSX, and Google Sheets exports with export type options, plus Node helpers for writing file exports to disk. The CLI adds MCP server startup, config-file API key lookup, and export format flags. A new @suparse/mcp package exposes Suparse document processing as MCP stdio tools.

### Patch Changes

- Updated dependencies
  - @suparse/sdk@1.1.0
