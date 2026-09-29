package com.example.orders.model;

/** Lifecycle of an order. Only PENDING and PAID orders may be cancelled. */
public enum OrderStatus {
    PENDING,
    PAID,
    SHIPPED,
    DELIVERED,
    CANCELLED
}
