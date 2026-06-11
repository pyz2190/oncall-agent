package org.example.service;

import com.fasterxml.jackson.annotation.JsonIgnore;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

@Service
public class AutomationGateService {

    private final Map<String, PendingAction> pendingActions = new ConcurrentHashMap<>();

    public PendingAction createAction(String automationMode, String toolName, String riskLevel, String description) {
        PendingAction action = new PendingAction();
        action.setId("action-" + UUID.randomUUID());
        action.setAutomationMode(normalizeMode(automationMode));
        action.setToolName(toolName);
        action.setRiskLevel(riskLevel);
        action.setDescription(description);
        action.setStatus("pending");
        action.setCreatedAt(System.currentTimeMillis());
        pendingActions.put(action.getId(), action);
        return action;
    }

    public PendingAction approveAutomatically(PendingAction action) {
        action.approve("auto");
        pendingActions.remove(action.getId());
        return action;
    }

    public PendingAction waitForDecision(PendingAction action, Duration timeout) throws InterruptedException {
        boolean decided = action.await(timeout);
        if (!decided) {
            action.reject("timeout");
        }
        pendingActions.remove(action.getId());
        return action;
    }

    public Optional<PendingAction> decide(String actionId, boolean approved, String operator) {
        PendingAction action = pendingActions.get(actionId);
        if (action == null) {
            return Optional.empty();
        }

        if (approved) {
            action.approve(operator);
        } else {
            action.reject(operator);
        }
        return Optional.of(action);
    }

    private String normalizeMode(String mode) {
        if ("manual".equalsIgnoreCase(mode) || "auto".equalsIgnoreCase(mode)) {
            return mode.toLowerCase();
        }
        return "confirm";
    }

    public static class PendingAction {
        private String id;
        private String automationMode;
        private String toolName;
        private String riskLevel;
        private String description;
        private String status;
        private boolean approved;
        private String operator;
        private long createdAt;
        private long decidedAt;

        @JsonIgnore
        private final CountDownLatch latch = new CountDownLatch(1);

        private boolean await(Duration timeout) throws InterruptedException {
            return latch.await(timeout.toMillis(), TimeUnit.MILLISECONDS);
        }

        private void approve(String operator) {
            this.approved = true;
            this.status = "approved";
            this.operator = operator;
            this.decidedAt = System.currentTimeMillis();
            this.latch.countDown();
        }

        private void reject(String operator) {
            this.approved = false;
            this.status = "rejected";
            this.operator = operator;
            this.decidedAt = System.currentTimeMillis();
            this.latch.countDown();
        }

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }

        public String getAutomationMode() {
            return automationMode;
        }

        public void setAutomationMode(String automationMode) {
            this.automationMode = automationMode;
        }

        public String getToolName() {
            return toolName;
        }

        public void setToolName(String toolName) {
            this.toolName = toolName;
        }

        public String getRiskLevel() {
            return riskLevel;
        }

        public void setRiskLevel(String riskLevel) {
            this.riskLevel = riskLevel;
        }

        public String getDescription() {
            return description;
        }

        public void setDescription(String description) {
            this.description = description;
        }

        public String getStatus() {
            return status;
        }

        public void setStatus(String status) {
            this.status = status;
        }

        public boolean isApproved() {
            return approved;
        }

        public void setApproved(boolean approved) {
            this.approved = approved;
        }

        public String getOperator() {
            return operator;
        }

        public void setOperator(String operator) {
            this.operator = operator;
        }

        public long getCreatedAt() {
            return createdAt;
        }

        public void setCreatedAt(long createdAt) {
            this.createdAt = createdAt;
        }

        public long getDecidedAt() {
            return decidedAt;
        }

        public void setDecidedAt(long decidedAt) {
            this.decidedAt = decidedAt;
        }
    }
}
