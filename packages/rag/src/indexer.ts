import { promises as fs } from "node:fs";
import path from "node:path";
import { chunkFile, type ChunkOptions } from "./chunking/chunker";
import type { EmbeddingProvider } from "./embeddings/provider";
import { TfidfEmbeddingProvider } from "./embeddings/tfidf";
import { walkRepository, type SkippedFile, type WalkOptions } from "./ingest/walker";
import { Bm25Index } from "./retrieval/bm25";
import { HybridRetriever, type RetrievalResult, type SearchOptions } from "./retrieval/hybrid";
import { InMemoryVectorStore, type VectorStore } from "./store/vectorStore";
import { tokenize } from "./text/tokenize";
import type { Chunk, IndexedFile } from "./types";

export const INDEX_FORMAT_VERSION = 1;
export const DEFAULT_INDEX_DIR = ".copilot-index";
export const DEFAULT_INDEX_FILE = "index.json";

export interface BuildOptions extends WalkOptions, ChunkOptions {
  embeddings?: EmbeddingProvider;
}

interface SparseVector {
  i: number[];
  v: number[];
}

interface IndexFileFormat {
  formatVersion: number;
  createdAt: string;
  embedding: { id: string; dimensions: number; state?: unknown };
  files: IndexedFile[];
  skipped: SkippedFile[];
  chunks: Chunk[];
  vectors: SparseVector[];
}

/** Text that is actually indexed: path and symbol names carry strong retrieval signal. */
export function indexedText(chunk: Chunk): string {
  const names = [chunk.container, chunk.symbol].filter(Boolean).join(" ");
  return `${chunk.filePath}\n${names}\n${chunk.text}`;
}

function toSparse(vector: readonly number[]): SparseVector {
  const i: number[] = [];
  const v: number[] = [];
  vector.forEach((value, index) => {
    if (value !== 0) {
      i.push(index);
      v.push(Math.round(value * 1e6) / 1e6);
    }
  });
  return { i, v };
}

function fromSparse(sparse: SparseVector, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  sparse.i.forEach((index, n) => {
    vector[index] = sparse.v[n] as number;
  });
  return vector;
}

/** A searchable, persistable index of one repository. */
export class CodebaseIndex {
  readonly bm25 = new Bm25Index();
  readonly vectors: VectorStore = new InMemoryVectorStore();
  private readonly chunkById = new Map<string, Chunk>();
  private readonly termsById = new Map<string, Set<string>>();
  private readonly fileByPath = new Map<string, IndexedFile>();
  private readonly retriever: HybridRetriever;

  private constructor(
    readonly root: string,
    readonly files: IndexedFile[],
    readonly chunks: Chunk[],
    readonly skipped: SkippedFile[],
    readonly embedder: EmbeddingProvider,
    vectors: number[][],
  ) {
    chunks.forEach((chunk, n) => {
      const tokens = tokenize(indexedText(chunk));
      this.chunkById.set(chunk.id, chunk);
      this.termsById.set(chunk.id, new Set(tokens));
      this.bm25.add(chunk.id, tokens);
      this.vectors.add([{ id: chunk.id, vector: vectors[n] as number[] }]);
    });
    for (const file of files) this.fileByPath.set(file.path, file);
    this.retriever = new HybridRetriever({
      chunks: this.chunkById,
      chunkTerms: this.termsById,
      bm25: this.bm25,
      vectors: this.vectors,
      embedder,
      tokenize,
    });
  }

  static async build(root: string, options: BuildOptions = {}): Promise<CodebaseIndex> {
    const absoluteRoot = path.resolve(root);
    const embedder = options.embeddings ?? new TfidfEmbeddingProvider();
    const { files, skipped } = await walkRepository(absoluteRoot, options);
    const chunks = files.flatMap((file) => chunkFile(file, options));
    const texts = chunks.map(indexedText);
    embedder.fit?.(texts);
    const vectors = await embedder.embedDocuments(texts);
    const indexed: IndexedFile[] = files.map((f) => ({
      path: f.path,
      language: f.language,
      bytes: f.bytes,
      lines: f.content.split("\n").length,
      sha1: f.sha1,
    }));
    return new CodebaseIndex(absoluteRoot, indexed, chunks, skipped, embedder, vectors);
  }

  static async load(
    indexPath: string,
    root: string,
    embedder: EmbeddingProvider = new TfidfEmbeddingProvider(),
  ): Promise<CodebaseIndex> {
    const data = JSON.parse(await fs.readFile(indexPath, "utf8")) as IndexFileFormat;
    if (data.formatVersion !== INDEX_FORMAT_VERSION) {
      throw new Error(`Unsupported index format ${data.formatVersion}; rebuild the index`);
    }
    if (data.embedding.state !== undefined) embedder.importState?.(data.embedding.state);
    if (data.embedding.id !== embedder.id) {
      throw new Error(
        `Index was built with embeddings "${data.embedding.id}" but "${embedder.id}" is configured; rebuild the index`,
      );
    }
    if (data.vectors.length !== data.chunks.length) {
      throw new Error("Corrupt index: vector count does not match chunk count");
    }
    const vectors = data.vectors.map((v) => fromSparse(v, data.embedding.dimensions));
    return new CodebaseIndex(
      path.resolve(root),
      data.files,
      data.chunks,
      data.skipped ?? [],
      embedder,
      vectors,
    );
  }

  async save(indexPath: string): Promise<void> {
    const records = this.vectors.records();
    const dimensions = records[0]?.vector.length ?? 0;
    const byId = new Map(records.map((r) => [r.id, r.vector]));
    const data: IndexFileFormat = {
      formatVersion: INDEX_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      embedding: { id: this.embedder.id, dimensions, state: this.embedder.exportState?.() },
      files: this.files,
      skipped: this.skipped,
      chunks: this.chunks,
      vectors: this.chunks.map((c) => toSparse(byId.get(c.id) ?? [])),
    };
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, JSON.stringify(data));
  }

  search(query: string, options?: SearchOptions): Promise<RetrievalResult> {
    return this.retriever.search(query, options);
  }

  getChunk(id: string): Chunk | undefined {
    return this.chunkById.get(id);
  }

  getFile(filePath: string): IndexedFile | undefined {
    return this.fileByPath.get(filePath);
  }

  chunksForFile(filePath: string): Chunk[] {
    return this.chunks.filter((c) => c.filePath === filePath);
  }

  /** True when files were added, removed or changed since the index was built. */
  async isStale(options: WalkOptions = {}): Promise<boolean> {
    const { files } = await walkRepository(this.root, options);
    if (files.length !== this.files.length) return true;
    return files.some((f) => this.fileByPath.get(f.path)?.sha1 !== f.sha1);
  }
}

/** Loads a saved index when it exists and is fresh; otherwise builds (and optionally saves) one. */
export async function openIndex(
  root: string,
  options: BuildOptions & { indexPath?: string; persist?: boolean } = {},
): Promise<{ index: CodebaseIndex; source: "loaded" | "built" }> {
  const indexPath = options.indexPath ?? path.join(root, DEFAULT_INDEX_DIR, DEFAULT_INDEX_FILE);
  try {
    const index = await CodebaseIndex.load(indexPath, root, options.embeddings);
    if (!(await index.isStale(options))) return { index, source: "loaded" };
  } catch {
    // Missing, incompatible or corrupt index: fall through and rebuild.
  }
  const index = await CodebaseIndex.build(root, options);
  if (options.persist) await index.save(indexPath);
  return { index, source: "built" };
}
