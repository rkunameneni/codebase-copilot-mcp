import { createHash } from "node:crypto";
import path from "node:path";
import type { Language, SourceFile } from "../src/types";

export const SAMPLE_REPO = path.resolve(__dirname, "../../../sample-repo");

export function sourceFile(filePath: string, content: string, language: Language): SourceFile {
  return {
    path: filePath,
    absolutePath: `/virtual/${filePath}`,
    language,
    content,
    bytes: Buffer.byteLength(content),
    sha1: createHash("sha1").update(content).digest("hex"),
  };
}
