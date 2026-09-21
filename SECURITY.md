# Security Policy

## Reporting Vulnerabilities

Report suspected vulnerabilities privately by emailing support@suparse.com. Do not open a public GitHub issue for security reports.

Please include:

- Affected package name and version
- A clear description of the issue and impact
- Reproduction steps or proof-of-concept details
- Any relevant MCP client, operating system, and Node.js version details

We will acknowledge reports as soon as practical and coordinate fixes before public disclosure.

## Security Boundary

`@suparse/mcp` is a local stdio MCP server. Connected MCP clients can ask it to read local document paths and write export files wherever the server process has permission. Only connect this server to MCP clients and workspaces you trust.

The server requires a Suparse API key. Treat `SUPARSE_API_KEY` and `~/.config/suparse/config.json` as secrets:

- Do not commit API keys to source control.
- Prefer environment variables or a local config file with user-only permissions.
- Avoid running the server in workspaces where untrusted prompts or files can direct local file reads/writes.
- Review requested `file_path`, `folder_path`, and `output_path` values before allowing an MCP client to process sensitive documents.
- Treat `pdf_password` as a document secret. Do not place it in prompts, logs, saved MCP arguments, issue reports, or source control; the server redacts it from API error details.

## Supported Versions

Security fixes are provided for the latest published version of `@suparse/mcp`.
