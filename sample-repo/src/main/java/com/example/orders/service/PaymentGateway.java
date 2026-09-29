package com.example.orders.service;

import java.math.BigDecimal;

/** Port for the external card processor. */
public interface PaymentGateway {

    /** Charges the customer and returns a processor transaction id. */
    String charge(String customerId, BigDecimal amount);

    void refund(String transactionId, BigDecimal amount);
}
