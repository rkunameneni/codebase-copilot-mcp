package com.example.orders.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.example.orders.exception.InsufficientStockException;
import org.junit.jupiter.api.Test;

class InventoryServiceTest {

    @Test
    void reserveDecrementsStock() {
        InventoryService inventory = new InventoryService();
        inventory.restock("SKU-1", 5);
        inventory.reserve("SKU-1", 3);
        assertEquals(2, inventory.availableStock("SKU-1"));
    }

    @Test
    void reserveThrowsWhenStockIsInsufficient() {
        InventoryService inventory = new InventoryService();
        assertThrows(InsufficientStockException.class, () -> inventory.reserve("SKU-1", 1));
    }
}
