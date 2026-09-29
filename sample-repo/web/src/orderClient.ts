export interface OrderItemDto {
  sku: string;
  quantity: number;
  unitPrice: string;
}

export interface OrderDto {
  id: number;
  customerId: string;
  status: "PENDING" | "PAID" | "SHIPPED" | "DELIVERED" | "CANCELLED";
  total: string;
}

/** Thin browser client for the order REST API. */
export class OrderClient {
  constructor(private readonly baseUrl: string) {}

  async placeOrder(customerId: string, items: OrderItemDto[]): Promise<OrderDto> {
    const response = await fetch(`${this.baseUrl}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId, items, loyalCustomer: false }),
    });
    if (!response.ok) {
      throw new Error(`placeOrder failed with HTTP ${response.status}`);
    }
    return (await response.json()) as OrderDto;
  }

  async cancelOrder(orderId: number): Promise<OrderDto> {
    const response = await fetch(`${this.baseUrl}/api/orders/${orderId}/cancel`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`cancelOrder failed with HTTP ${response.status}`);
    }
    return (await response.json()) as OrderDto;
  }
}

export function formatTotal(order: OrderDto): string {
  return `$${Number(order.total).toFixed(2)}`;
}
