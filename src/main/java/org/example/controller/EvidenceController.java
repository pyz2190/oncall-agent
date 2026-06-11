package org.example.controller;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.example.service.VectorSearchService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/evidence")
public class EvidenceController {

    private static final int DEFAULT_TOP_K = 3;
    private static final int MAX_TOP_K = 6;
    private static final int SNIPPET_LIMIT = 360;
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    @Autowired
    private VectorSearchService vectorSearchService;

    @PostMapping("/search")
    public ResponseEntity<ApiResponse<List<EvidenceItem>>> search(@RequestBody EvidenceRequest request) {
        String query = request == null ? "" : normalize(request.getQuery());
        if (query.isBlank()) {
            return ResponseEntity.ok(ApiResponse.success(Collections.emptyList()));
        }

        int topK = request.getTopK() == null ? DEFAULT_TOP_K : request.getTopK();
        topK = Math.max(1, Math.min(topK, MAX_TOP_K));

        try {
            List<VectorSearchService.SearchResult> results = vectorSearchService.searchSimilarDocuments(query, topK);
            List<EvidenceItem> items = new ArrayList<>();
            for (int i = 0; i < results.size(); i += 1) {
                items.add(toEvidenceItem(i + 1, results.get(i)));
            }
            return ResponseEntity.ok(ApiResponse.success(items));
        } catch (Exception e) {
            ApiResponse<List<EvidenceItem>> response = ApiResponse.error("证据检索失败：" + e.getMessage());
            response.setData(Collections.emptyList());
            return ResponseEntity.ok(response);
        }
    }

    private EvidenceItem toEvidenceItem(int index, VectorSearchService.SearchResult result) {
        EvidenceItem item = new EvidenceItem();
        item.setIndex(index);
        item.setId(result.getId());
        item.setTitle(resolveTitle(result));
        item.setSnippet(makeSnippet(result.getContent()));
        item.setScore(result.getScore());
        item.setMetadata(result.getMetadata());
        return item;
    }

    private String resolveTitle(VectorSearchService.SearchResult result) {
        Map<String, Object> metadata = readMetadata(result.getMetadata());
        for (String key : List.of("fileName", "filename", "source", "path", "title")) {
            Object value = metadata.get(key);
            if (value != null && !normalize(value.toString()).isBlank()) {
                return normalize(value.toString());
            }
        }

        String id = normalize(result.getId());
        return id.isBlank() ? "知识库片段" : id;
    }

    private Map<String, Object> readMetadata(String metadata) {
        if (metadata == null || metadata.isBlank()) {
            return Collections.emptyMap();
        }

        try {
            return OBJECT_MAPPER.readValue(metadata, new TypeReference<>() {});
        } catch (Exception ignored) {
            return Collections.emptyMap();
        }
    }

    private String makeSnippet(String content) {
        String value = normalize(content);
        if (value.length() <= SNIPPET_LIMIT) {
            return value;
        }
        return value.substring(0, SNIPPET_LIMIT) + "...";
    }

    private String normalize(String value) {
        return value == null ? "" : value.replaceAll("\\s+", " ").trim();
    }

    public static class EvidenceRequest {
        private String query;
        private Integer topK;

        public String getQuery() {
            return query;
        }

        public void setQuery(String query) {
            this.query = query;
        }

        public Integer getTopK() {
            return topK;
        }

        public void setTopK(Integer topK) {
            this.topK = topK;
        }
    }

    public static class EvidenceItem {
        private int index;
        private String id;
        private String title;
        private String snippet;
        private float score;
        private String metadata;

        public int getIndex() {
            return index;
        }

        public void setIndex(int index) {
            this.index = index;
        }

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }

        public String getTitle() {
            return title;
        }

        public void setTitle(String title) {
            this.title = title;
        }

        public String getSnippet() {
            return snippet;
        }

        public void setSnippet(String snippet) {
            this.snippet = snippet;
        }

        public float getScore() {
            return score;
        }

        public void setScore(float score) {
            this.score = score;
        }

        public String getMetadata() {
            return metadata;
        }

        public void setMetadata(String metadata) {
            this.metadata = metadata;
        }
    }

    public static class ApiResponse<T> {
        private int code;
        private String message;
        private T data;

        public int getCode() {
            return code;
        }

        public void setCode(int code) {
            this.code = code;
        }

        public String getMessage() {
            return message;
        }

        public void setMessage(String message) {
            this.message = message;
        }

        public T getData() {
            return data;
        }

        public void setData(T data) {
            this.data = data;
        }

        public static <T> ApiResponse<T> success(T data) {
            ApiResponse<T> response = new ApiResponse<>();
            response.setCode(200);
            response.setMessage("success");
            response.setData(data);
            return response;
        }

        public static <T> ApiResponse<T> error(String message) {
            ApiResponse<T> response = new ApiResponse<>();
            response.setCode(500);
            response.setMessage(message);
            return response;
        }
    }
}
