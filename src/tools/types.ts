import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Schema, Static } from "@earendil-works/pi-schema";
import type { TimeWindow } from "../utils/timewindow.ts";

export interface ToolOutput {
  content: (TextContent | ImageContent)[];
  isError?: boolean;
}

export interface SreTool<P extends Schema = Schema> {
  name: string;
  description: string;
  parameters: P;
  /** Exempt from the turn budget, and named in the prompt.ts FREE list. */
  cheap: boolean;
  /** Does a network round-trip, so resolveTools wraps it in withRetry. */
  retry: boolean;
  execute(args: Static<P>, tw: TimeWindow): Promise<ToolOutput>;
}

export function sreTool<P extends Schema>(tool: SreTool<P>): SreTool<P> {
  return tool;
}
