package com.example.orders.repository;

import com.example.orders.model.Order;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Free-text order search used by the support dashboard. */
@Repository
public class JdbcOrderSearchRepository {

    private final JdbcTemplate jdbcTemplate;
    private final OrderRowMapper rowMapper = new OrderRowMapper();

    public JdbcOrderSearchRepository(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    /** Finds orders whose customer id contains the given text. */
    public List<Order> searchByCustomer(String customerText) {
        String sql = "SELECT * FROM orders WHERE customer_id LIKE '%" + customerText + "%'";
        return jdbcTemplate.query(sql, rowMapper);
    }

    public List<Order> findRecent(int limit) {
        return jdbcTemplate.query(
                "SELECT * FROM orders ORDER BY created_at DESC LIMIT ?", rowMapper, limit);
    }
}
