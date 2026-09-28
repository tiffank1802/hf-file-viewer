package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"enise-docs/backend/internal/appwrite"
	"enise-docs/backend/internal/catalog"
	"enise-docs/backend/internal/config"
)

func TestNormalizeAnnotationFieldsBoundsPrivateNote(t *testing.T) {
	kind, color, body, err := normalizeAnnotationFields("note", "blue", "  À relire  ")
	if err != nil || kind != "note" || color != "blue" || body != "À relire" {
		t.Fatalf("résultat = %q %q %q err=%v", kind, color, body, err)
	}
	if _, _, _, err := normalizeAnnotationFields("public-comment", "yellow", "texte"); err == nil {
		t.Fatal("type public accepté")
	}
	if _, _, _, err := normalizeAnnotationFields("note", "yellow", strings.Repeat("x", maxAnnotationBody+1)); err == nil {
		t.Fatal("note démesurée acceptée")
	}
}

func TestValidateAnnotationAnchorBoundsOffsetsAndRectangles(t *testing.T) {
	valid := chatAnchor{
		Quote: "passage vérifié", Prefix: "avant", Suffix: "après", Start: 10, End: 26, Page: 2,
		Rects: []chatAnchorRect{{X: 0.1, Y: 0.2, W: 0.4, H: 0.05}},
	}
	if err := validateAnnotationAnchor(&valid); err != nil {
		t.Fatalf("ancre valide refusée: %v", err)
	}
	invalid := valid
	invalid.Rects = []chatAnchorRect{{X: 0.8, Y: 0.2, W: 0.4, H: 0.05}}
	if err := validateAnnotationAnchor(&invalid); err == nil {
		t.Fatal("rectangle hors page accepté")
	}
	invalid = valid
	invalid.End = invalid.Start
	if err := validateAnnotationAnchor(&invalid); err == nil {
		t.Fatal("offsets vides acceptés")
	}
}

func TestPublicAnnotationMarksOldArtifactForReview(t *testing.T) {
	item := appwrite.Annotation{
		RowID: "ann-1", SourcePath: "GM/cours.pdf", ArtifactID: "old", BlockID: "b-1", Page: 3,
		AnchorJSON: `{"blockId":"b-1","quote":"passage vérifié","page":3,"rects":[{"x":0.1,"y":0.2,"w":0.3,"h":0.04}]}`,
		Kind:       "highlight", Color: "yellow", Status: "active",
	}
	public := publicAnnotation(item, "current")
	if public["status"] != "needs-review" {
		t.Fatalf("annotation = %#v", public)
	}
	anchor, _ := public["anchor"].(chatAnchor)
	if anchor.Quote != "passage vérifié" || anchor.Page != 3 {
		t.Fatalf("ancre = %#v", anchor)
	}
}

func TestAnnotationsRequireSession(t *testing.T) {
	server := New(config.Config{
		AppwriteEnabled:          true,
		AppwriteEndpoint:         "https://cloud.appwrite.test/v1",
		AppwriteProjectID:        "project",
		AppwriteDatabaseID:       "db",
		AppwriteProfileTable:     "profiles",
		AppwriteAnnotationsTable: "annotations",
		CacheDir:                 t.TempDir(),
	})
	request := httptest.NewRequest(http.MethodGet, "/api/annotations?path=GM%2Fcours.pdf&artifactId=a1", nil)
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("statut = %d corps=%s", response.Code, response.Body.String())
	}
}

func TestCreateAnnotationValidatesAnchorAndStoresPrivateRow(t *testing.T) {
	const sourcePath = "GM/cours.pdf"
	const prefix = "reader/v1/documents/cours/artifact-1"
	var saved map[string]any
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/account":
			_, _ = w.Write([]byte(`{"$id":"user-1","email":"ada@enise.fr","name":"Ada"}`))
		case strings.HasSuffix(r.URL.Path, "/reader/v1/catalog.json"):
			_, _ = w.Write([]byte(`{"schemaVersion":"enise-reader/v1","documents":{"GM/cours.pdf":{"sourcePath":"GM/cours.pdf","pipelineVersion":"test","artifactId":"artifact-1","artifactPrefix":"` + prefix + `","manifestPath":"` + prefix + `/manifest.json","status":"ready"}}}`))
		case strings.HasSuffix(r.URL.Path, "/manifest.json"):
			_, _ = w.Write([]byte(`{"schemaVersion":"enise-reader/v1","sourcePath":"GM/cours.pdf","artifactId":"artifact-1","artifactPrefix":"` + prefix + `","pipelineVersion":"test","status":"ready","files":{"document":"document.json","chunks":"chunks.jsonl"}}`))
		case strings.HasSuffix(r.URL.Path, "/document.json"):
			_, _ = w.Write([]byte(`{"schemaVersion":"enise-reader/v1","artifactId":"artifact-1","pipelineVersion":"test","title":"Cours","blocks":[{"id":"b-1","ordinal":1,"type":"text","text":"L'énergie cinétique dépend de la masse.","selfRef":"#/texts/0","provenance":[{"page_no":2}]}]}`))
		case strings.HasSuffix(r.URL.Path, "/chunks.jsonl"):
			_, _ = w.Write([]byte("{\"id\":\"c-1\",\"text\":\"L'énergie cinétique dépend de la masse.\",\"meta\":{\"doc_items\":[{\"self_ref\":\"#/texts/0\"}]}}\n"))
		case r.Method == http.MethodPost && r.URL.Path == "/tablesdb/db/tables/annotations/rows":
			var request map[string]any
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
			}
			saved, _ = request["data"].(map[string]any)
			response := map[string]any{"$id": "ann-1", "data": saved}
			_ = json.NewEncoder(w).Encode(response)
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()

	server := New(config.Config{
		HFOrigin:                 upstream.URL,
		BucketID:                 "ktongue/ENISE-SITE",
		DerivedBucketID:          "ktongue/ENISE-SITE-DERIVED",
		AppwriteEnabled:          true,
		AppwriteEndpoint:         upstream.URL,
		AppwriteProjectID:        "project",
		AppwriteDatabaseID:       "db",
		AppwriteProfileTable:     "profiles",
		AppwriteAnnotationsTable: "annotations",
		CacheDir:                 t.TempDir(),
	})
	size := int64(100)
	server.cache.SetIndex(&catalog.IndexDocument{
		BucketID: "ktongue/ENISE-SITE", Complete: true,
		Items: []catalog.BucketItem{{Type: "file", Path: sourcePath, Size: &size}},
	}, time.Hour, time.Hour)

	request := httptest.NewRequest(http.MethodPost, "/api/annotations", strings.NewReader(`{
		"sourcePath":"GM/cours.pdf","artifactId":"artifact-1","kind":"note","color":"green","body":"À retenir",
		"anchor":{"blockId":"b-1","quote":"énergie cinétique dépend de la masse","page":2,"start":2,"end":39,"rects":[{"x":0.1,"y":0.2,"w":0.5,"h":0.04}]}
	}`))
	request.AddCookie(&http.Cookie{Name: sessionCookie, Value: "session-secret"})
	response := httptest.NewRecorder()
	server.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("statut=%d corps=%s", response.Code, response.Body.String())
	}
	if saved["userId"] != "user-1" || saved["artifactId"] != "artifact-1" || saved["blockId"] != "b-1" || saved["body"] != "À retenir" {
		t.Fatalf("ligne = %#v", saved)
	}
	if !strings.Contains(response.Body.String(), `"status":"active"`) || !strings.Contains(response.Body.String(), `"quote":"énergie cinétique`) {
		t.Fatalf("réponse = %s", response.Body.String())
	}
}
