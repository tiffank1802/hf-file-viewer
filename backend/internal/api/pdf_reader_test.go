package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"enise-docs/backend/internal/appwrite"
	"enise-docs/backend/internal/catalog"
	"enise-docs/backend/internal/config"
	"enise-docs/backend/internal/reader"
)

// A single fake supplies the source PDF and Appwrite. No Docling endpoint is
// available: tests fail if the PDF flow accidentally asks for an artifact.
type pdfReaderFixture struct {
	mu            sync.Mutex
	etag          string
	pdf           []byte
	stored        map[string]any
	permissions   []any
	artifactCalls int
}

func (f *pdfReaderFixture) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if strings.Contains(r.URL.Path, "reader/v1/") {
		f.artifactCalls++
		http.Error(w, "Docling indisponible", http.StatusServiceUnavailable)
		return
	}
	if strings.HasSuffix(r.URL.Path, "/resolve/GM/cours.pdf") {
		if f.etag != "" {
			w.Header().Set("ETag", f.etag)
		}
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Accept-Ranges", "bytes")
		if r.Method == http.MethodHead {
			w.Header().Set("Content-Length", fmt.Sprint(len(f.pdf)))
			return
		}
		if h := r.Header.Get("Range"); h != "" {
			start, end, ok := parseRange(h, len(f.pdf))
			if !ok {
				w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
				return
			}
			w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(f.pdf)))
			w.WriteHeader(http.StatusPartialContent)
			_, _ = w.Write(f.pdf[start : end+1])
			return
		}
		_, _ = w.Write(f.pdf)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/account" {
		id := "user-1"
		if r.Header.Get("X-Appwrite-Session") == "other-session" {
			id = "user-2"
		}
		_, _ = fmt.Fprintf(w, `{"$id":%q,"email":"student@example.test"}`, id)
		return
	}
	base := "/tablesdb/db/tables/"
	if r.URL.Path == base+"annotations/rows" && r.Method == http.MethodGet {
		legacy := map[string]any{"$id": "old-note", "userId": "user-1", "sourcePath": "GM/cours.pdf", "documentKey": appwrite.DocumentKey("GM/cours.pdf"), "artifactId": "legacy-artifact", "kind": "note", "body": "ancienne note", "anchorJson": `{"page":1,"quote":"ancien passage"}`}
		_ = json.NewEncoder(w).Encode(map[string]any{"rows": []any{legacy}, "total": 1})
		return
	}
	if r.URL.Path == base+"pdf_annotations_v2/rows" {
		switch r.Method {
		case http.MethodPost:
			var payload struct {
				Data        map[string]any `json:"data"`
				Permissions []any          `json:"permissions"`
			}
			_ = json.NewDecoder(r.Body).Decode(&payload)
			f.stored, f.permissions = payload.Data, payload.Permissions
			_ = json.NewEncoder(w).Encode(map[string]any{"$id": "new-note", "data": f.stored})
			return
		case http.MethodGet:
			rows := []any{}
			if f.stored != nil {
				rows = append(rows, map[string]any{"$id": "new-note", "data": f.stored})
			}
			// Deliberately leak a different user's row from this fake to exercise
			// the API's defence-in-depth ownership check.
			rows = append(rows, map[string]any{"$id": "foreign-note", "userId": "user-3", "documentKey": appwrite.DocumentKey("GM/cours.pdf"), "sourcePath": "GM/cours.pdf"})
			_ = json.NewEncoder(w).Encode(map[string]any{"rows": rows, "total": len(rows)})
			return
		}
	}
	if r.URL.Path == base+"pdf_annotations_v2/rows/new-note" {
		if f.stored == nil || (r.Header.Get("X-Appwrite-Session") == "other-session") {
			http.Error(w, `{"message":"not found"}`, http.StatusNotFound)
			return
		}
		switch r.Method {
		case http.MethodGet:
			_ = json.NewEncoder(w).Encode(map[string]any{"$id": "new-note", "data": f.stored})
		case http.MethodPatch:
			var payload struct {
				Data map[string]any `json:"data"`
			}
			_ = json.NewDecoder(r.Body).Decode(&payload)
			for k, v := range payload.Data {
				f.stored[k] = v
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"$id": "new-note", "data": f.stored})
		case http.MethodDelete:
			f.stored = nil
			w.WriteHeader(http.StatusNoContent)
		}
		return
	}
	http.NotFound(w, r)
}

func newPDFReaderTestServer(t *testing.T) (*Server, *pdfReaderFixture) {
	t.Helper()
	f := &pdfReaderFixture{etag: `"revision-a"`, pdf: []byte("%PDF-1.4\nexample reader content\n%%EOF")}
	upstream := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(upstream.Close)
	server := New(config.Config{BucketID: "bucket", HFOrigin: upstream.URL, HFToken: "token", AppwriteEnabled: true, AppwriteEndpoint: upstream.URL, AppwriteProjectID: "project", AppwriteDatabaseID: "db", AppwriteAnnotationsTable: "annotations", AppwritePDFAnnotationsTable: "pdf_annotations_v2", CacheDir: t.TempDir()})
	server.cache.SetIndex(&catalog.IndexDocument{BucketID: "bucket", Complete: true, Items: []catalog.BucketItem{{Type: "file", Path: "GM/cours.pdf"}}}, time.Hour, time.Hour)
	return server, f
}

func pdfTestRequest(s *Server, method, path string, body any, session string) *httptest.ResponseRecorder {
	var input io.Reader
	if body != nil {
		payload, _ := json.Marshal(body)
		input = bytes.NewReader(payload)
	}
	r := httptest.NewRequest(method, path, input)
	if session != "" {
		r.AddCookie(&http.Cookie{Name: "enise_session", Value: session})
	}
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func testPDFAnchor(revision string) chatAnchor {
	return chatAnchor{SchemaVersion: pdfAnchorSchema, SourceRevision: revision, Origin: "pdf-text", Page: 1, Quote: "Energie cinetique", Start: 0, End: 17, Segments: []reader.PDFSegment{{Page: 1, PageView: []float64{0, 0, 612, 792}, Quads: [][]float64{{70, 700, 220, 700, 220, 720, 70, 720}}}}}
}

func TestPDFRevisionRangeAndFallback(t *testing.T) {
	s, f := newPDFReaderTestServer(t)
	path := "/api/reader/pdf-revision?path=" + url.QueryEscape("GM/cours.pdf")
	w := pdfTestRequest(s, http.MethodGet, path, nil, "")
	if w.Code != http.StatusOK {
		t.Fatalf("revision %d: %s", w.Code, w.Body.String())
	}
	var rev struct {
		Revision string `json:"revision"`
		Strategy string `json:"strategy"`
		Size     int64  `json:"size"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &rev); err != nil {
		t.Fatal(err)
	}
	want := strongETagRevision(`"revision-a"`)
	if rev.Revision != want || rev.Strategy != "strong-etag" || rev.Size != int64(len(f.pdf)) {
		t.Fatalf("unexpected revision: %+v", rev)
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("revision is cacheable")
	}

	r := httptest.NewRequest(http.MethodGet, "/api/file?path=GM%2Fcours.pdf&reader=1&revision="+url.QueryEscape(rev.Revision), nil)
	r.Header.Set("Range", "bytes=1-4")
	part := httptest.NewRecorder()
	s.ServeHTTP(part, r)
	if part.Code != http.StatusPartialContent || part.Body.String() != string(f.pdf[1:5]) || part.Header().Get("Content-Range") != fmt.Sprintf("bytes 1-4/%d", len(f.pdf)) || part.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("range %d %q %v", part.Code, part.Body.String(), part.Header())
	}

	f.mu.Lock()
	f.etag = `"revision-b"`
	f.mu.Unlock()
	changed := pdfTestRequest(s, http.MethodGet, "/api/file?path=GM%2Fcours.pdf&reader=1&revision="+url.QueryEscape(rev.Revision), nil, "")
	if changed.Code != http.StatusConflict {
		t.Fatalf("stale ETag accepted: %d %s", changed.Code, changed.Body.String())
	}
	f.mu.Lock()
	f.etag = `W/"weak"`
	f.mu.Unlock()
	w = pdfTestRequest(s, http.MethodGet, path, nil, "")
	_ = json.Unmarshal(w.Body.Bytes(), &rev)
	if rev.Strategy != "sha256" || rev.Revision != "" {
		t.Fatalf("weak ETag accepted: %+v", rev)
	}
	hash := sha256.Sum256(f.pdf)
	revision := "sha256:" + hex.EncodeToString(hash[:])
	if err := s.verifyPDFRevision(r.Context(), "GM/cours.pdf", revision); err != nil {
		t.Fatalf("fallback hash: %v", err)
	}
	if err := s.verifyPDFRevision(r.Context(), "GM/cours.pdf", "sha256:"+strings.Repeat("0", 64)); err == nil {
		t.Fatal("incorrect digest accepted")
	}
	if strongETagRevision(`W/"revision-a"`) != "" {
		t.Fatal("weak ETag accepted")
	}
}

func TestPDFAnnotationsPrivateVersionedAndNoDocling(t *testing.T) {
	s, f := newPDFReaderTestServer(t)
	rev := strongETagRevision(`"revision-a"`)
	anchor := testPDFAnchor(rev)
	create := map[string]any{"sourcePath": "GM/cours.pdf", "sourceRevision": rev, "kind": "note", "body": "ma note", "anchor": anchor}
	if w := pdfTestRequest(s, http.MethodPost, "/api/annotations", create, ""); w.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous create: %d", w.Code)
	}
	w := pdfTestRequest(s, http.MethodPost, "/api/annotations", create, "session")
	if w.Code != http.StatusCreated {
		t.Fatalf("create %d: %s", w.Code, w.Body.String())
	}
	var made struct {
		Annotation struct {
			ID     string     `json:"id"`
			Status string     `json:"status"`
			Anchor chatAnchor `json:"anchor"`
		} `json:"item"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &made); err != nil {
		t.Fatal(err)
	}
	if made.Annotation.ID != "pdfv2:new-note" || made.Annotation.Status != "active" || made.Annotation.Anchor.SchemaVersion != pdfAnchorSchema {
		t.Fatalf("created: %+v", made.Annotation)
	}
	f.mu.Lock()
	perms, stored := fmt.Sprint(f.permissions), f.stored
	f.mu.Unlock()
	if stored["userId"] != "user-1" || stored["sourceRevision"] != rev || !strings.Contains(perms, `read("user:user-1")`) || !strings.Contains(perms, `delete("user:user-1")`) {
		t.Fatalf("privacy: %v %v", stored, perms)
	}

	list := "/api/annotations?path=GM%2Fcours.pdf&sourceRevision=" + url.QueryEscape(rev)
	w = pdfTestRequest(s, http.MethodGet, list, nil, "session")
	var response struct {
		Annotations []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if w.Code != 200 || len(response.Annotations) != 2 {
		t.Fatalf("listing %d: %s", w.Code, w.Body.String())
	}
	statusByID := map[string]string{}
	for _, item := range response.Annotations {
		statusByID[item.ID] = item.Status
	}
	if statusByID["pdfv2:new-note"] != "active" || statusByID["old-note"] != "needs-review" {
		t.Fatalf("incorrect annotation statuses: %s", w.Body.String())
	}
	if w := pdfTestRequest(s, http.MethodPatch, "/api/annotations/pdfv2:new-note", map[string]string{"body": "tentative"}, "other-session"); w.Code != http.StatusNotFound {
		t.Fatalf("foreign update: %d", w.Code)
	}
	if w := pdfTestRequest(s, http.MethodPatch, "/api/annotations/pdfv2:new-note", map[string]string{"body": "note modifiée"}, "session"); w.Code != http.StatusOK {
		t.Fatalf("own update: %d %s", w.Code, w.Body.String())
	}

	f.mu.Lock()
	f.etag = `"revision-b"`
	f.mu.Unlock()
	newRev := strongETagRevision(`"revision-b"`)
	w = pdfTestRequest(s, http.MethodGet, "/api/annotations?path=GM%2Fcours.pdf&sourceRevision="+url.QueryEscape(newRev), nil, "session")
	response.Annotations = nil
	_ = json.Unmarshal(w.Body.Bytes(), &response)
	if w.Code != 200 || len(response.Annotations) != 2 || response.Annotations[0].Status != "needs-review" || response.Annotations[1].Status != "needs-review" {
		t.Fatalf("revision changed: %d %s", w.Code, w.Body.String())
	}
	if w := pdfTestRequest(s, http.MethodPost, "/api/annotations", create, "session"); w.Code != http.StatusConflict {
		t.Fatalf("stale annotation accepted: %d", w.Code)
	}
	if w := pdfTestRequest(s, http.MethodDelete, "/api/annotations/pdfv2:new-note", nil, "session"); w.Code != http.StatusOK {
		t.Fatalf("delete %d", w.Code)
	}
	f.mu.Lock()
	calls := f.artifactCalls
	f.mu.Unlock()
	if calls != 0 {
		t.Fatalf("PDF flow requested Docling %d times", calls)
	}
}

func TestPDFAnchorValidationAndAssistantProvenance(t *testing.T) {
	s, f := newPDFReaderTestServer(t)
	rev := strongETagRevision(`"revision-a"`)
	valid := testPDFAnchor(rev)
	if err := validatePDFAnchor(&valid, rev); err != nil {
		t.Fatal(err)
	}
	bad := testPDFAnchor(rev)
	bad.Segments[0].Quads[0][0] = 10000
	if validatePDFAnchor(&bad, rev) == nil {
		t.Fatal("out-of-page quad accepted")
	}
	bad = testPDFAnchor(rev)
	bad.Segments[0].Quads = make([][]float64, 33)
	if validatePDFAnchor(&bad, rev) == nil {
		t.Fatal("too many quads accepted")
	}
	bad = testPDFAnchor(rev)
	bad.SourceRevision = "sha256:" + strings.Repeat("1", 64)
	if validatePDFAnchor(&bad, rev) == nil {
		t.Fatal("anchor version mismatch accepted")
	}

	scope := chatScope{Type: "document", SourcePath: "GM/cours.pdf", SourceRevision: rev, Anchor: &valid, PDFContext: &pdfChatContext{IndexedPages: 1, TotalPages: 1, Complete: true, Passages: []pdfChatPassage{{Page: 1, Text: "Energie cinetique dans le PDF.", Origin: "pdf-text"}}}}
	body := map[string]any{"message": "Explique cette sélection", "intent": "explain-selection", "scope": scope}
	w := pdfTestRequest(s, http.MethodPost, "/api/chat", body, "")
	if w.Code != http.StatusOK || !strings.Contains(w.Header().Get("Content-Type"), "text/event-stream") {
		t.Fatalf("chat %d: %s", w.Code, w.Body.String())
	}
	for _, expected := range []string{`event: citations`, `"sourceRevision":"` + rev + `"`, `"verified":false`, `"segments"`, `event: done`} {
		if !strings.Contains(w.Body.String(), expected) {
			t.Fatalf("missing %s in %s", expected, w.Body.String())
		}
	}
	f.mu.Lock()
	calls := f.artifactCalls
	f.mu.Unlock()
	if calls != 0 {
		t.Fatalf("assistant requested Docling %d times", calls)
	}
}

func TestPDFStudyStreamsProviderWithUnverifiedEvidenceAndSanitizedCitations(t *testing.T) {
	s, f := newPDFReaderTestServer(t)
	var prompt strings.Builder
	llm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Messages []nvidiaMessage `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
			return
		}
		for _, message := range payload.Messages {
			prompt.WriteString(message.Content)
			prompt.WriteByte('\n')
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"Une explication [S1] et une source inventée [S99].\"}}]}\n\ndata: [DONE]\n\n"))
	}))
	defer llm.Close()
	s.cfg.NvidiaAPIKey = "test-key"
	s.cfg.NvidiaAPIBase = llm.URL + "/v1"
	s.cfg.NvidiaModel = "meta/llama-3.1-8b-instruct"
	rev := strongETagRevision(`"revision-a"`)
	anchor := testPDFAnchor(rev)
	body := map[string]any{"message": "Explique la sélection", "intent": "explain-selection", "scope": chatScope{Type: "document", SourcePath: "GM/cours.pdf", SourceRevision: rev, Anchor: &anchor}}
	w := pdfTestRequest(s, http.MethodPost, "/api/chat", body, "")
	if w.Code != http.StatusOK {
		t.Fatalf("chat %d: %s", w.Code, w.Body.String())
	}
	events := parseSSE(t, w.Body.String())
	done := eventObject(t, events, "done")
	answer, _ := done["answer"].(string)
	if !strings.Contains(answer, "[S1]") || strings.Contains(answer, "[S99]") || !strings.Contains(answer, "[citation non vérifiée]") {
		t.Fatalf("citations: %s", answer)
	}
	if !strings.Contains(prompt.String(), "Texte fourni par le lecteur et non vérifié côté serveur") || !strings.Contains(prompt.String(), "Energie cinetique") || !strings.Contains(prompt.String(), "<PREUVES>") {
		t.Fatalf("prompt: %s", prompt.String())
	}
	f.mu.Lock()
	calls := f.artifactCalls
	f.mu.Unlock()
	if calls != 0 {
		t.Fatalf("provider flow requested Docling %d times", calls)
	}
}
