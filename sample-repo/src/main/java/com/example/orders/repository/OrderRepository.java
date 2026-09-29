package com.example.orders.repository;

import com.example.orders.model.Order;
import com.example.orders.model.OrderStatus;
import java.util.List;
import java.util.Optional;

public interface OrderRepository {

    Optional<Order> findById(Long id);

    List<Order> findByCustomerId(String customerId);

    List<Order> findByStatus(OrderStatus status);

    Order save(Order order);
}
