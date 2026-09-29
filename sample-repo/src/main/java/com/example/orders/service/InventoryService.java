package com.example.orders.service;

import com.example.orders.exception.InsufficientStockException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Service;

/** Tracks available stock per SKU and reserves it when orders are placed. */
@Service
public class InventoryService {

    private final Map<String, Integer> stockBySku = new ConcurrentHashMap<>();

    public int availableStock(String sku) {
        return stockBySku.getOrDefault(sku, 0);
    }

    public void restock(String sku, int quantity) {
        stockBySku.merge(sku, quantity, Integer::sum);
    }

    /**
     * Reserves stock for a SKU.
     *
     * @throws InsufficientStockException when fewer units are available than requested
     */
    public void reserve(String sku, int quantity) {
        int available = availableStock(sku);
        if (available < quantity) {
            throw new InsufficientStockException(sku, quantity, available);
        }
        stockBySku.put(sku, available - quantity);
    }

    /** Returns previously reserved units to stock, e.g. when an order is cancelled. */
    public void release(String sku, int quantity) {
        restock(sku, quantity);
    }
}
