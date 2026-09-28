package appwrite

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestDocumentKeyIsStableFullSHA256(t *testing.T) {
	key := DocumentKey("GM/cours.pdf")
	if len(key) != 64 || key != DocumentKey("GM/cours.pdf") || key == DocumentKey("GM/autre.pdf") {
		t.Fatalf("clé documentaire = %q", key)
	}
}

func TestAnnotationListPathUsesDocumentRevisionQueries(t *testing.T) {
	path := AnnotationListPath("/tablesdb/db/tables/annotations/rows", strings.Repeat("a", 64))
	parsed, err := url.Parse(path)
	if err != nil {
		t.Fatal(err)
	}
	queries := parsed.Query()["queries[]"]
	if len(queries) != 3 {
		t.Fatalf("queries = %#v", queries)
	}
	if !strings.Contains(queries[0], `"attribute":"documentKey"`) ||
		!strings.Contains(queries[1], `"method":"orderDesc"`) ||
		!strings.Contains(queries[2], `"method":"limit"`) {
		t.Fatalf("queries = %#v", queries)
	}
}

func TestCreateAnnotationUsesOwnerPermissions(t *testing.T) {
	var received map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/tablesdb/db/tables/annotations/rows" {
			t.Fatalf("requête = %s %s", r.Method, r.URL.Path)
		}
		payload, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(payload, &received); err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(`{"$id":"ann-1","data":{"userId":"user-1","documentKey":"` + strings.Repeat("a", 64) + `","sourcePath":"GM/cours.pdf","artifactId":"artifact-1","blockId":"b-1","page":2,"anchorJson":"{}","kind":"note","color":"blue","body":"À relire","status":"active"}}`))
	}))
	defer server.Close()
	client := annotationTestClient(server.URL)
	created, err := client.CreateAnnotation(context.Background(), "session", "user-1", Annotation{
		DocumentKey: strings.Repeat("a", 64), SourcePath: "GM/cours.pdf", ArtifactID: "artifact-1",
		BlockID: "b-1", Page: 2, AnchorJSON: `{}`, Kind: "note", Color: "blue", Body: "À relire", Status: "active",
	})
	if err != nil {
		t.Fatal(err)
	}
	permissions, _ := received["permissions"].([]any)
	if len(permissions) != 3 || permissions[0] != `read("user:user-1")` {
		t.Fatalf("permissions = %#v", received["permissions"])
	}
	if created.RowID != "ann-1" || created.Body != "À relire" || created.Page != 2 {
		t.Fatalf("annotation = %#v", created)
	}
}

func TestListAnnotationsFiltersOwnerAndDocument(t *testing.T) {
	key := strings.Repeat("b", 64)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"rows":[
			{"$id":"mine","data":{"userId":"user-1","documentKey":"` + key + `","sourcePath":"GM/cours.pdf","artifactId":"a1","anchorJson":"{}"}},
			{"$id":"other","data":{"userId":"user-2","documentKey":"` + key + `","sourcePath":"GM/cours.pdf","artifactId":"a1","anchorJson":"{}"}},
			{"$id":"other-doc","data":{"userId":"user-1","documentKey":"` + strings.Repeat("c", 64) + `","sourcePath":"GM/autre.pdf","artifactId":"a1","anchorJson":"{}"}}
		]}`))
	}))
	defer server.Close()
	items, err := annotationTestClient(server.URL).ListAnnotations(context.Background(), "session", "user-1", key)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].RowID != "mine" {
		t.Fatalf("annotations = %#v", items)
	}
}

func TestUpdateAnnotationRejectsDifferentOwner(t *testing.T) {
	var patches int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			patches++
		}
		_, _ = w.Write([]byte(`{"$id":"ann-1","data":{"userId":"user-2","documentKey":"` + strings.Repeat("d", 64) + `","sourcePath":"GM/cours.pdf","artifactId":"a1","anchorJson":"{}"}}`))
	}))
	defer server.Close()
	body := "secret"
	_, err := annotationTestClient(server.URL).UpdateAnnotation(context.Background(), "session", "user-1", "ann-1", AnnotationPatch{Body: &body})
	if err == nil || patches != 0 {
		t.Fatalf("err=%v patches=%d", err, patches)
	}
}

func annotationTestClient(endpoint string) *Client {
	return &Client{
		Endpoint: endpoint, ProjectID: "project", DatabaseID: "db", ProfileTable: "profiles",
		AnnotationsTable: "annotations", Flavor: "tablesdb",
	}
}
