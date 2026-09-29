package com.example.orders.repository;

import com.example.orders.model.Order;
import com.example.orders.model.OrderStatus;
import java.sql.ResultSet;
import java.sql.SQLException;
import org.springframework.jdbc.core.RowMapper;

class OrderRowMapper implements RowMapper<Order> {

    @Override
    public Order mapRow(ResultSet rs, int rowNum) throws SQLException {
        Order order = new Order(rs.getString("customer_id"));
        order.setId(rs.getLong("id"));
        order.setStatus(OrderStatus.valueOf(rs.getString("status")));
        order.setTotal(rs.getBigDecimal("total"));
        return order;
    }
}
