package org.example.config;

import org.springframework.ai.tool.ToolCallbackProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class LocalToolCallbackConfig {

    @Bean
    @ConditionalOnMissingBean(ToolCallbackProvider.class)
    @ConditionalOnProperty(name = "spring.ai.mcp.client.enabled", havingValue = "false", matchIfMissing = true)
    public ToolCallbackProvider emptyToolCallbackProvider() {
        return ToolCallbackProvider.from();
    }
}
