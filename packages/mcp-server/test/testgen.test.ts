import {
  javaSampleValue,
  parseJavaSignature,
  parseTsSignature,
  splitTopLevel,
  tsSampleValue,
} from "../src/testgen";
import { parseSymbol } from "../src/symbols";

describe("signature parsing", () => {
  it("parses Java methods with generics, annotations and modifiers", () => {
    expect(
      parseJavaSignature(
        "@Transactional public static <T> Map<String, List<T>> group(final @NonNull List<T> items, Function<T, String> key)",
      ),
    ).toEqual({
      name: "group",
      returnType: "Map<String, List<T>>",
      params: [
        { type: "List<T>", name: "items" },
        { type: "Function<T, String>", name: "key" },
      ],
      isStatic: true,
      isAsync: false,
    });
  });

  it("parses Java constructors and no-arg methods", () => {
    expect(parseJavaSignature("public OrderService()")).toMatchObject({
      name: "OrderService",
      params: [],
    });
    expect(parseJavaSignature("void run()")).toMatchObject({ name: "run", returnType: "void" });
  });

  it("parses TypeScript methods, functions and constructors", () => {
    expect(
      parseTsSignature(
        "async placeOrder(customerId: string, items: OrderItemDto[]): Promise<OrderDto>",
      ),
    ).toEqual({
      name: "placeOrder",
      returnType: "Promise<OrderDto>",
      params: [
        { name: "customerId", type: "string" },
        { name: "items", type: "OrderItemDto[]" },
      ],
      isStatic: false,
      isAsync: true,
    });
    expect(parseTsSignature("export function formatTotal(order: OrderDto): string")).toMatchObject({
      name: "formatTotal",
      returnType: "string",
    });
    expect(parseTsSignature("constructor(private readonly baseUrl: string)").params).toEqual([
      { name: "baseUrl", type: "string" },
    ]);
    expect(
      parseTsSignature("function f(opts: { a: number } = { a: 1 }, flag?: boolean)").params,
    ).toEqual([
      { name: "opts", type: "{ a: number }" },
      { name: "flag", type: "boolean" },
    ]);
  });

  it("splits only on top-level commas", () => {
    expect(splitTopLevel("Map<A, B> m, int x, f(a, b)")).toEqual([
      "Map<A, B> m",
      "int x",
      "f(a, b)",
    ]);
  });
});

describe("sample values", () => {
  it("maps common Java types to compilable literals", () => {
    expect(javaSampleValue("long", "id")).toBe("1L");
    expect(javaSampleValue("String", "customerId")).toBe('"customerId"');
    expect(javaSampleValue("BigDecimal", "amount")).toBe('new BigDecimal("10.00")');
    expect(javaSampleValue("List<OrderItem>", "items")).toBe("List.of()");
    expect(javaSampleValue("Order", "order")).toBe("mock(Order.class)");
  });

  it("maps common TypeScript types", () => {
    expect(tsSampleValue("number", "n")).toBe("1");
    expect(tsSampleValue("Item[]", "items")).toBe("[]");
    expect(tsSampleValue("OrderDto", "order")).toBe("{} as OrderDto");
  });
});

describe("parseSymbol", () => {
  it("accepts method, Class.method, Class#method and trailing parens", () => {
    expect(parseSymbol("cancelOrder")).toEqual({ name: "cancelOrder" });
    expect(parseSymbol("OrderService.cancelOrder()")).toEqual({
      container: "OrderService",
      name: "cancelOrder",
    });
    expect(parseSymbol("com.acme.OrderService#cancelOrder")).toEqual({
      container: "OrderService",
      name: "cancelOrder",
    });
  });
});
