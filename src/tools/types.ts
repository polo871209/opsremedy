import type { ImageContent, Static, TextContent, TSchema } from "@earendil-works/pi-ai";
import type { TimeWindow } from "../utils/timewindow.ts";

export interface ToolOutput {
  content: (TextContent | ImageContent)[];
  isError?: boolean;
}

export interface SreTool<P extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: P;
  /** Exempt from the turn budget, and named in the prompt.ts FREE list. */
  cheap: boolean;
  /** Does a network round-trip, so resolveTools wraps it in withRetry. */
  retry: boolean;
  execute(args: Static<P>, tw: TimeWindow): Promise<ToolOutput>;
}
