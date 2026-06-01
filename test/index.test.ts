import { describe, expect, it } from "vitest";

import { createSuparseMcpServer } from "../src/index";

interface RegisteredTool {
  outputSchema?: unknown;
}

describe("createSuparseMcpServer", () => {
  it("registers the public Suparse tool surface with output schemas", () => {
    const server = createSuparseMcpServer();
    const tools = (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
      ._registeredTools;

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
});
