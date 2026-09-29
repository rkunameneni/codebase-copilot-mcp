package com.example.orders.config;

import java.time.Duration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Token-bucket settings for the public order API. */
@Configuration
public class RateLimitConfig {

    public static final int REQUESTS_PER_MINUTE = 120;

    @Bean
    public Duration rateLimitWindow() {
        return Duration.ofMinutes(1);
    }
}
