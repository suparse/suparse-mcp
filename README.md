# @suparse/mcp

MCP stdio server for the [Suparse](https://suparse.com) Document Processing API.

Use this package to connect Suparse document extraction to local MCP clients such as Claude Code and Codex.

MCP Registry name: `io.github.suparse/suparse-mcp`

## Security Boundary

This is a local stdio MCP server. Connected MCP clients can ask it to read local document paths and write export files wherever the server process has permission. Only connect it to MCP clients and workspaces you trust.

## Requirements

- Node.js 20+
- A Suparse API key
- ESM runtime support. The package executable is available as `suparse-mcp`; programmatic imports use ESM.

## Authentication

The MCP server reads credentials from:

1. `SUPARSE_API_KEY`
2. `~/.config/suparse/config.json`

You can optionally override the API base URL with `SUPARSE_API_URL`, or pass `api_url` to individual MCP tools.

## Claude Code

```bash
claude mcp add suparse -e SUPARSE_API_KEY=your_api_key -- npx -y @suparse/mcp
```

## Claude Desktop
Open your config file at `~/Library/Application Support/Claude/claude_desktop_config.json`
on Mac or `%APPDATA%\Claude\claude_desktop_config.json` on Windows. Add Suparse to
the `mcpServers` section:

```json
{
  "mcpServers": {
    "suparse": {
      "command": "npx",
      "args": ["-y", "@suparse/mcp"],
      "env": {
        "SUPARSE_API_KEY": "your_api_key"
      }
    }
  }
}
```

## Codex

Add this to `~/.codex/config.toml` or a project-scoped `.codex/config.toml`:

```toml
[mcp_servers.suparse]
command = "npx"
args = ["-y", "@suparse/mcp"]

[mcp_servers.suparse.env]
SUPARSE_API_KEY = "your_api_key"
```

## Tools

- `extract_file`: Process one local document. Defaults to `result_mode: "defer"`, returning compact `task_id`/`document_ids` metadata for later `download_results`. Use `result_mode: "return_json"` only when the full JSON extraction is needed in the MCP response.
- `extract_folder`: Process supported files in one local folder. Defaults to `result_mode: "defer"`, returning compact `task_id`/`document_ids` metadata for later `download_results`. Use `result_mode: "return_json"` only when full JSON extractions are needed in the MCP response.
- `list_templates`: List summary metadata for templates, grouped into directly usable `team_templates` and discovery-only `system_templates`.
- `fetch_json_results`: Fetch JSON extraction results by document ID directly in the MCP response. Use only when full JSON is needed in context.
- `download_results`: Fetch an export by document ID and write it directly to local disk. Use this for `json`, `csv`, `xlsx`, and `google_sheets`.
- `delete_documents`: Delete documents by ID.

### Export Formats

`fetch_json_results` accepts:

| Input         | Values                | Default   |
| ------------- | --------------------- | --------- |
| `export_type` | `original`, `unified` | `unified` |

JSON exports are returned as structured `results`.

`download_results` accepts `json`, `csv`, `xlsx`, and `google_sheets`, plus an optional `output_path` local file path or existing directory. It writes the export directly to disk and returns the saved `output_path`. MCP clients should use `download_results` for CSV, XLSX, Google Sheets, and saved JSON files; they should not fetch base64 data and decode it with shell or Python.

`result_mode` controls whether extraction results in JSON format are returned directly. Use `return_json` only when you need the full JSON extraction in the MCP response. In all other cases you can retrieve the results in the format of your choice using `download_results`.

Important: `cleanup` on `extract_file` and `extract_folder` is only valid with `result_mode: "return_json"`. It fetches JSON and then deletes the processed Suparse documents, so later exports cannot be fetched from those document IDs. For CSV/XLSX/Google Sheets or saved JSON files, run `extract_file` or `extract_folder` with `result_mode: "defer"`, call `download_results`, then call `delete_documents`.

## Template Selection for MCP Agents

MCP agents should use only `team_templates` when passing `template_id` to `extract_file` or `extract_folder`.

When a user asks to process a document type such as a receipt:

1. Check `team_templates` first and use the matching team template if present.
2. If no matching team template exists, call `list_templates` with `include_system: true` and check `system_templates`.
3. If a matching system template exists, ask the user to add that system template to their templates in the Suparse UI before processing. Do not pass the system template ID directly to extraction.
4. If no matching team or system template exists, ask the user to create a custom extraction schema for that document type in the Suparse UI.

## Development

Build the package:

```bash
pnpm build
```

Test with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node dist/index.mjs
```

The MCP server uses stdout for JSON-RPC protocol messages. Do not add `console.log` output to the server path; use stderr or MCP tool responses.
