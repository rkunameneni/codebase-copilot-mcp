package com.example.orders.exception;

public class PaymentDeclinedException extends RuntimeException {

    public PaymentDeclinedException(String reason) {
        super("Payment declined: " + reason);
    }
}
