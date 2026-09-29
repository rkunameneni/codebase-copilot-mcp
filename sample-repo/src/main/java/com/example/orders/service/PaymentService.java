package com.example.orders.service;

import com.example.orders.exception.PaymentDeclinedException;
import com.example.orders.model.Order;
import java.math.BigDecimal;
import java.util.HashMap;
import java.util.Map;
import org.springframework.stereotype.Service;

/** Charges and refunds orders through the configured {@link PaymentGateway}. */
@Service
public class PaymentService {

    private final PaymentGateway gateway;
    private final Map<Long, String> transactionsByOrder = new HashMap<>();

    public PaymentService(PaymentGateway gateway) {
        this.gateway = gateway;
    }

    /**
     * Charges the order total and remembers the transaction id for refunds.
     *
     * @throws PaymentDeclinedException when the order total is not positive
     */
    public String chargeOrder(Order order) {
        if (order.getTotal().compareTo(BigDecimal.ZERO) <= 0) {
            throw new PaymentDeclinedException("order total must be positive");
        }
        String transactionId = gateway.charge(order.getCustomerId(), order.getTotal());
        transactionsByOrder.put(order.getId(), transactionId);
        return transactionId;
    }

    /** Refunds the full amount of a previously charged order. */
    public void refundOrder(Order order) {
        String transactionId = transactionsByOrder.get(order.getId());
        gateway.refund(transactionId, order.getTotal());
    }
}
