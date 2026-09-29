import path from "node:path";
import { CodebaseIndex } from "@codebase-copilot/rag";
import { parseUnifiedDiff, targetFromDiff, targetFromPaths } from "../src/review/targets";

const SAMPLE_REPO = path.resolve(__dirname, "../../../sample-repo");

const DIFF = `diff --git a/src/main/java/com/example/orders/service/OrderService.java b/src/main/java/com/example/orders/service/OrderService.java
index 1111111..2222222 100644
--- a/src/main/java/com/example/orders/service/OrderService.java
+++ b/src/main/java/com/example/orders/service/OrderService.java
@@ -66,6 +66,9 @@ public class OrderService {
     public Order cancelOrder(Long orderId) {
         Order order = orderRepository.findById(orderId)
                 .orElseThrow(() -> new OrderNotFoundException(orderId));
+        if (order.getStatus() == OrderStatus.SHIPPED) {
+            throw new IllegalStateException("shipped orders cannot be cancelled");
+        }
         for (OrderItem item : order.getItems()) {
-            inventoryService.release(item.getSku(), item.getQuantity());
+            inventoryService.release(item.getSku(), item.getQuantity() );
         }
diff --git a/old/Removed.java b/old/Removed.java
deleted file mode 100644
--- a/old/Removed.java
+++ /dev/null
@@ -1,1 +0,0 @@
-class Removed {}
`;

describe("parseUnifiedDiff", () => {
  it("annotates added and context lines with new-file line numbers and skips deleted files", () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files.map((f) => f.path)).toEqual([
      "src/main/java/com/example/orders/service/OrderService.java",
    ]);
    const [file] = files;
    expect(file?.addedLines).toEqual([69, 70, 71, 73]);
    expect(file?.rendered).toContain(
      "   69 +         if (order.getStatus() == OrderStatus.SHIPPED) {",
    );
    expect(file?.rendered).toContain("   66       public Order cancelOrder(Long orderId) {");
    expect(file?.rendered).toContain(
      "      -             inventoryService.release(item.getSku(), item.getQuantity());",
    );
    expect(file?.rendered).toMatch(/^@@ new line 66 public class OrderService \{/);
  });
});

describe("review targets", () => {
  let index: CodebaseIndex;
  beforeAll(async () => {
    index = await CodebaseIndex.build(SAMPLE_REPO);
  });

  it("builds a numbered target from a file or a directory", async () => {
    const single = await targetFromPaths(
      index,
      ["src/main/java/com/example/orders/service/PaymentService.java"],
      {
        cwd: SAMPLE_REPO,
      },
    );
    expect(single.description).toBe(
      "the file src/main/java/com/example/orders/service/PaymentService.java",
    );
    expect(single.content).toContain(
      "=== src/main/java/com/example/orders/service/PaymentService.java (41 lines) ===",
    );
    expect(single.content).toContain("17|     public PaymentService(PaymentGateway gateway) {");

    const dir = await targetFromPaths(index, ["src/main/java/com/example/orders/repository"], {
      cwd: SAMPLE_REPO,
    });
    expect(dir.files.map((f) => path.posix.basename(f.path))).toEqual([
      "JdbcOrderSearchRepository.java",
      "OrderRepository.java",
      "OrderRowMapper.java",
    ]);
  });

  it("accepts paths relative to the current directory or to the root", async () => {
    const payment = "src/main/java/com/example/orders/service/PaymentService.java";
    const fromParent = await targetFromPaths(index, [`sample-repo/${payment}`], {
      cwd: path.dirname(SAMPLE_REPO),
    });
    const rootRelative = await targetFromPaths(index, [payment], {
      cwd: path.dirname(SAMPLE_REPO),
    });
    expect(fromParent.files).toEqual(rootRelative.files);
    expect(rootRelative.files[0]?.path).toBe(payment);
  });

  it("rejects paths outside the root, unknown paths and oversized selections", async () => {
    await expect(targetFromPaths(index, ["../package.json"], { cwd: SAMPLE_REPO })).rejects.toThrow(
      /outside/,
    );
    await expect(targetFromPaths(index, ["src/nope"], { cwd: SAMPLE_REPO })).rejects.toThrow(
      /does not match/,
    );
    await expect(
      targetFromPaths(index, ["src"], {
        cwd: SAMPLE_REPO,
        limits: { maxFiles: 2, maxBytes: 1_000_000 },
      }),
    ).rejects.toThrow(/limit is 2/);
  });

  it("builds a target from a diff and refuses diffs that escape the root", async () => {
    const t = await targetFromDiff(index, DIFF, "my.patch");
    expect(t).toMatchObject({ kind: "diff", description: "the changes in my.patch" });
    expect(t.files[0]?.lines).toBeGreaterThan(80);
    const evil = DIFF.replace(/b\/src\/main/g, "b/../../src/main");
    await expect(targetFromDiff(index, evil, "evil.patch")).rejects.toThrow(
      /outside the repository/,
    );
    await expect(targetFromDiff(index, "not a diff", "x")).rejects.toThrow(/no changed files/);
  });
});
