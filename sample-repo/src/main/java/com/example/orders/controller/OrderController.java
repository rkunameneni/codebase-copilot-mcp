package com.example.orders.controller;

import com.example.orders.model.Order;
import com.example.orders.model.OrderItem;
import com.example.orders.repository.JdbcOrderSearchRepository;
import com.example.orders.service.OrderService;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    private final OrderService orderService;
    private final JdbcOrderSearchRepository searchRepository;

    public OrderController(OrderService orderService, JdbcOrderSearchRepository searchRepository) {
        this.orderService = orderService;
        this.searchRepository = searchRepository;
    }

    public record PlaceOrderRequest(String customerId, List<OrderItem> items, boolean loyalCustomer) {}

    @PostMapping
    public ResponseEntity<Order> placeOrder(@RequestBody PlaceOrderRequest request) {
        Order order = orderService.placeOrder(
                request.customerId(), request.items(), request.loyalCustomer());
        return ResponseEntity.ok(order);
    }

    @GetMapping("/{id}")
    public Order getOrder(@PathVariable Long id) {
        return orderService.getOrder(id);
    }

    @PostMapping("/{id}/cancel")
    public Order cancelOrder(@PathVariable Long id) {
        return orderService.cancelOrder(id);
    }

    @GetMapping("/search")
    public List<Order> search(@RequestParam("q") String query) {
        return searchRepository.searchByCustomer(query);
    }
}
