package com.example.orders.service;

import com.example.orders.exception.OrderNotFoundException;
import com.example.orders.model.Order;
import com.example.orders.model.OrderItem;
import com.example.orders.model.OrderStatus;
import com.example.orders.repository.OrderRepository;
import java.math.BigDecimal;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Application service that coordinates inventory, pricing and payment for orders. */
@Service
public class OrderService {

    private final OrderRepository orderRepository;
    private final InventoryService inventoryService;
    private final PaymentService paymentService;
    private final DiscountPolicy discountPolicy;

    public OrderService(
            OrderRepository orderRepository,
            InventoryService inventoryService,
            PaymentService paymentService,
            DiscountPolicy discountPolicy) {
        this.orderRepository = orderRepository;
        this.inventoryService = inventoryService;
        this.paymentService = paymentService;
        this.discountPolicy = discountPolicy;
    }

    /**
     * Places an order: reserves stock for every item, prices the order, charges the
     * customer and persists it as PAID.
     */
    @Transactional
    public Order placeOrder(String customerId, List<OrderItem> items, boolean loyalCustomer) {
        if (items == null || items.isEmpty()) {
            throw new IllegalArgumentException("an order needs at least one item");
        }
        Order order = new Order(customerId);
        for (OrderItem item : items) {
            inventoryService.reserve(item.getSku(), item.getQuantity());
            order.addItem(item);
        }
        order.setTotal(calculateTotal(order, loyalCustomer));
        Order saved = orderRepository.save(order);
        paymentService.chargeOrder(saved);
        saved.setStatus(OrderStatus.PAID);
        return orderRepository.save(saved);
    }

    /** Sums line totals and applies the loyalty discount. */
    public BigDecimal calculateTotal(Order order, boolean loyalCustomer) {
        BigDecimal subtotal = BigDecimal.ZERO;
        for (OrderItem item : order.getItems()) {
            subtotal = subtotal.add(item.lineTotal());
        }
        return discountPolicy.applyLoyaltyDiscount(subtotal, loyalCustomer);
    }

    /**
     * Cancels an order, releases its stock and refunds the payment.
     *
     * @throws OrderNotFoundException when no order has the given id
     */
    @Transactional
    public Order cancelOrder(Long orderId) {
        Order order = orderRepository.findById(orderId)
                .orElseThrow(() -> new OrderNotFoundException(orderId));
        for (OrderItem item : order.getItems()) {
            inventoryService.release(item.getSku(), item.getQuantity());
        }
        paymentService.refundOrder(order);
        order.setStatus(OrderStatus.CANCELLED);
        return orderRepository.save(order);
    }

    public Order getOrder(Long orderId) {
        return orderRepository.findById(orderId)
                .orElseThrow(() -> new OrderNotFoundException(orderId));
    }

    public List<Order> ordersForCustomer(String customerId) {
        return orderRepository.findByCustomerId(customerId);
    }
}
