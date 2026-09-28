package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"enise-docs/backend/internal/catalog"
	"enise-docs/backend/internal/config"
	"enise-docs/backend/internal/reader"
)

func TestDocumentScopedChatUsesDoclingAndEmitsCitations(t *testing.T) {
	const sourcePath = "GM/3A/cours.pdf"
	const prefix = "reader/v1/documents/cours-test/artifact-1"
	var sourceReads atomic.Int32
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/reader/v1/catalog.json"):
			_, _ = w.Write([]byte(`{"schemaVersion":"enise-reader/v1","derivedBucket":"ktongue/ENISE-SITE-DERIVED","documents":{"GM/3A/cours.pdf":{"sourcePath":"GM/3A/cours.pdf","sourcePresent":true,"pipelineVersion":"docling-test","artifactId":"artifact-1","artifactPrefix":"` + prefix + `","manifestPath":"` + prefix + `/manifest.json","status":"ready","blockCount":2,"chunkCount":1}}}`))
		case strings.HasSuffix(r.URL.Path, "/manifest.json"):
			_, _ = w.Write([]byte(`{"schemaVersion":"enise-reader/v1","sourcePath":"GM/3A/cours.pdf","artifactId":"artifact-1","artifactPrefix":"` + prefix + `","pipelineVersion":"docling-test","status":"ready","files":{"document":"document.json","chunks":"chunks.jsonl"}}`))
		case strings.HasSuffix(r.URL.Path, "/document.json"):
			_, _ = w.Write([]byte(`{"schemaVersion":"enise-reader/v1","artifactId":"artifact-1","pipelineVersion":"docling-test","title":"Cours de mécanique","blocks":[{"id":"b-title","ordinal":1,"level":1,"type":"section_header","text":"Énergie","selfRef":"#/texts/0","provenance":[{"page_no":4}]},{"id":"b-energy","ordinal":2,"level":1,"type":"text","text":"L'énergie cinétique dépend de la masse et de la vitesse.","selfRef":"#/texts/1","provenance":[{"page_no":4,"bbox":{"l":1,"t":8,"r":7,"b":2,"coord_origin":"BOTTOMLEFT"}}]}]}`))
		case strings.HasSuffix(r.URL.Path, "/chunks.jsonl"):
			_, _ = w.Write([]byte("{\"id\":\"c-000001\",\"text\":\"L'énergie cinétique dépend de la masse et de la vitesse.\",\"meta\":{\"doc_items\":[{\"self_ref\":\"#/texts/1\"}],\"headings\":[\"Énergie\"]}}\n"))
		case strings.Contains(r.URL.Path, "/resolve/GM/3A/cours.pdf"):
			sourceReads.Add(1)
			_, _ = w.Write([]byte("raw pdf should not be read"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer storage.Close()

	var prompt strings.Builder
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, _ := io.ReadAll(r.Body)
		prompt.Write(payload)
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"La vitesse intervient dans l'énergie cinétique [S1].\"}}]}\n\ndata: [DONE]\n\n"))
	}))
	defer llm.Close()

	server := New(config.Config{
		HFOrigin:        storage.URL,
		BucketID:        "ktongue/ENISE-SITE",
		DerivedBucketID: "ktongue/ENISE-SITE-DERIVED",
		NvidiaAPIKey:    "test-key",
		NvidiaAPIBase:   llm.URL + "/v1",
		NvidiaModel:     "meta/llama-3.1-8b-instruct",
		CacheDir:        t.TempDir(),
	})
	size := int64(123)
	server.cache.SetIndex(&catalog.IndexDocument{
		BucketID: "ktongue/ENISE-SITE",
		Complete: true,
		Items:    []catalog.BucketItem{{Type: "file", Path: sourcePath, Size: &size}},
	}, time.Hour, time.Hour)

	response := postChat(t, server, `{"message":"De quoi dépend l'énergie cinétique ?","intent":"explain","scope":{"type":"document","sourcePath":"GM/3A/cours.pdf"}}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status %d %s", response.Code, response.Body.String())
	}
	events := parseSSE(t, response.Body.String())
	scope := eventObject(t, events, "scope")
	if scope["knowledgeSource"] != "docling" || scope["status"] != "structured-ready" || scope["artifactId"] != "artifact-1" {
		t.Fatalf("scope = %#v", scope)
	}
	citations := eventObject(t, events, "citations")
	items, _ := citations["citations"].([]any)
	if len(items) != 1 {
		t.Fatalf("citations = %#v", citations)
	}
	citation, _ := items[0].(map[string]any)
	if citation["citationId"] != "S1" || citation["page"] != float64(4) {
		t.Fatalf("citation = %#v", citation)
	}
	done := eventObject(t, events, "done")
	if done["knowledgeSource"] != "docling" || !strings.Contains(done["answer"].(string), "[S1]") {
		t.Fatalf("done = %#v", done)
	}
	if sourceReads.Load() != 0 {
		t.Fatalf("le PDF original a été relu %d fois", sourceReads.Load())
	}
	if !strings.Contains(prompt.String(), "<PREUVES>") || !strings.Contains(prompt.String(), "page=4") || !strings.Contains(prompt.String(), "[S1]") {
		t.Fatalf("prompt non structuré: %s", prompt.String())
	}

	metadataRequest := httptest.NewRequest(http.MethodGet, "/api/reader/document?path=GM%2F3A%2Fcours.pdf", nil)
	metadataResponse := httptest.NewRecorder()
	server.ServeHTTP(metadataResponse, metadataRequest)
	if metadataResponse.Code != http.StatusOK {
		t.Fatalf("reader metadata: %d %s", metadataResponse.Code, metadataResponse.Body.String())
	}
	var metadata map[string]any
	if err := json.Unmarshal(metadataResponse.Body.Bytes(), &metadata); err != nil {
		t.Fatal(err)
	}
	outline, _ := metadata["outline"].([]any)
	if metadata["artifactId"] != "artifact-1" || metadata["status"] != "structured-ready" || len(outline) != 1 {
		t.Fatalf("reader metadata = %#v", metadata)
	}

	pageRequest := httptest.NewRequest(http.MethodGet, "/api/reader/page?path=GM%2F3A%2Fcours.pdf&artifactId=artifact-1&page=4", nil)
	pageResponse := httptest.NewRecorder()
	server.ServeHTTP(pageResponse, pageRequest)
	if pageResponse.Code != http.StatusOK || !strings.Contains(pageResponse.Body.String(), "b-energy") {
		t.Fatalf("reader page: %d %s", pageResponse.Code, pageResponse.Body.String())
	}

	anchored := postChat(t, server, `{"message":"Explique cette sélection","intent":"explain-selection","scope":{"type":"document","sourcePath":"GM/3A/cours.pdf","artifactId":"artifact-1","anchor":{"blockId":"b-energy","quote":"L'énergie cinétique dépend de la masse","page":4,"start":0,"end":40,"rects":[{"x":0.1,"y":0.2,"w":0.5,"h":0.04}]}}}`)
	anchoredDone := eventObject(t, parseSSE(t, anchored.Body.String()), "done")
	anchoredScope, _ := anchoredDone["scope"].(map[string]any)
	anchoredAnchor, _ := anchoredScope["anchor"].(map[string]any)
	if anchoredAnchor["blockId"] != "b-energy" || anchoredAnchor["verified"] != true {
		t.Fatalf("ancre = %#v", anchoredAnchor)
	}

	invalidAnchor := postChat(t, server, `{"message":"Explique","intent":"explain-selection","scope":{"type":"document","sourcePath":"GM/3A/cours.pdf","artifactId":"artifact-1","anchor":{"quote":"passage inventé absent du document","page":4}}}`)
	if invalidAnchor.Code != http.StatusBadRequest {
		t.Fatalf("ancre inventée: status=%d body=%s", invalidAnchor.Code, invalidAnchor.Body.String())
	}

	conflict := postChat(t, server, `{"message":"Continue","intent":"explain","scope":{"type":"document","sourcePath":"GM/3A/cours.pdf","artifactId":"ancienne-revision"}}`)
	if conflict.Code != http.StatusConflict || !strings.Contains(conflict.Body.String(), "nouvelle version") {
		t.Fatalf("révision obsolète: status=%d body=%s", conflict.Code, conflict.Body.String())
	}
}

func TestLocalStudyAnswerKeepsVerifiedCitations(t *testing.T) {
	study := &documentStudy{
		Title:           "Cours de mécanique",
		KnowledgeSource: "docling",
		Retrieval: reader.Retrieval{
			Evidence: []reader.Evidence{{
				CitationID:  "S1",
				HeadingPath: []string{"Énergie"},
				Text:        "L'énergie cinétique dépend de la masse et de la vitesse.",
			}},
			Coverage: reader.Coverage{
				Kind:             "representative-summary",
				SelectedChunks:   1,
				TotalChunks:      3,
				SelectedSections: 1,
				TotalSections:    2,
			},
		},
	}
	answer := localStudyAnswer(study, "Moteur indisponible.")
	for _, expected := range []string{"[S1]", "Énergie", "sélection représentative", "Moteur indisponible"} {
		if !strings.Contains(answer, expected) {
			t.Fatalf("réponse locale sans %q: %s", expected, answer)
		}
	}
	filtered := sanitizeStudyCitations("Information vérifiée [S1], référence inventée [S99].", study)
	if !strings.Contains(filtered, "[S1]") || !strings.Contains(filtered, "[citation non vérifiée]") || strings.Contains(filtered, "[S99]") {
		t.Fatalf("citations non filtrées: %s", filtered)
	}
}

func TestDocumentScopedChatFallsBackBeforeConversion(t *testing.T) {
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/reader/v1/catalog.json"):
			_, _ = w.Write([]byte(`{"schemaVersion":"enise-reader/v1","documents":{}}`))
		case strings.Contains(r.URL.Path, "/resolve/GM/note.txt"):
			_, _ = w.Write([]byte("Contenu original lisible avant la conversion Docling."))
		default:
			http.NotFound(w, r)
		}
	}))
	defer storage.Close()
	server := New(config.Config{
		HFOrigin:        storage.URL,
		BucketID:        "ktongue/ENISE-SITE",
		DerivedBucketID: "ktongue/ENISE-SITE-DERIVED",
		CacheDir:        t.TempDir(),
	})
	size := int64(60)
	server.cache.SetIndex(&catalog.IndexDocument{
		BucketID: "ktongue/ENISE-SITE",
		Complete: true,
		Items:    []catalog.BucketItem{{Type: "file", Path: "GM/note.txt", Size: &size}},
	}, time.Hour, time.Hour)

	response := postChat(t, server, `{"message":"Résume ce document","intent":"summary","scope":{"type":"document","sourcePath":"GM/note.txt"}}`)
	events := parseSSE(t, response.Body.String())
	scope := eventObject(t, events, "scope")
	if scope["knowledgeSource"] != "source-fallback" || scope["status"] != "conversion-pending" {
		t.Fatalf("scope = %#v", scope)
	}
	documents := eventDocuments(t, events, "done")
	if len(documents) != 1 || documents[0]["read"] != true {
		t.Fatalf("documents = %#v", documents)
	}
}
