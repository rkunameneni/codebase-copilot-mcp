package com.example.orders.service;

import java.math.BigDecimal;
import java.math.RoundingMode;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Loyalty discount applied to order subtotals. */
@Component
public class DiscountPolicy {

    private final int loyaltyPercent;

    public DiscountPolicy(@Value("${orders.discount.loyalty-percent}") int loyaltyPercent) {
        this.loyaltyPercent = loyaltyPercent;
    }

    /** Returns the discounted amount, rounded half-up to cents. */
    public BigDecimal applyLoyaltyDiscount(BigDecimal subtotal, boolean loyalCustomer) {
        if (!loyalCustomer) {
            return subtotal;
        }
        BigDecimal factor = BigDecimal.valueOf(100 - loyaltyPercent).divide(BigDecimal.valueOf(100));
        return subtotal.multiply(factor).setScale(2, RoundingMode.HALF_UP);
    }

    /** Legacy helper kept for the reporting job. Uses floating point arithmetic. */
    public double legacyDiscountedTotal(double subtotal) {
        return subtotal * (100 - loyaltyPercent) / 100;
    }
}
