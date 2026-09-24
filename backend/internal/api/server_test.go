package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"enise-docs/backend/internal/config"
)

func TestIndexFeedsTreeWithoutAnotherUpstreamCall(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if !strings.Contains(r.URL.Path, "/tree") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
			{"type":"directory","path":"GM"},
			{"type":"file","path":"GM/3A GM/poly.pdf","size":12},
			{"type":"file","path":"TOEIC/audio.mp3","size":4}
		]`))
	}))
	defer upstream.Close()

	server := New(config.Config{
		HFOrigin: upstream.URL,
		BucketID: "ktongue/ENISE-SITE",
		IndexTTL: config.Load("").IndexTTL,
		TreeTTL:  config.Load("").TreeTTL,
		FileTTL:  config.Load("").FileTTL,
	})

	index := httptest.NewRecorder()
	indexReq := httptest.NewRequest(http.MethodGet, "/api/index", nil)
	server.ServeHTTP(index, indexReq)
	if index.Code != 200 {
		t.Fatalf("index status %d body %s", index.Code, index.Body.String())
	}
	if index.Header().Get("X-Cache-Status") != "MISS" {
		t.Fatalf("index cache %s", index.Header().Get("X-Cache-Status"))
	}
	if !strings.Contains(index.Body.String(), `"totalFiles":2`) {
		t.Fatalf("index body %s", index.Body.String())
	}

	before := calls.Load()
	tree := httptest.NewRecorder()
	server.ServeHTTP(tree, httptest.NewRequest(http.MethodGet, "/api/tree?prefix=GM", nil))
	if tree.Code != 200 {
		t.Fatalf("tree status %d %s", tree.Code, tree.Body.String())
	}
	if tree.Header().Get("X-Cache-Status") != "INDEX" {
		t.Fatalf("tree cache %s", tree.Header().Get("X-Cache-Status"))
	}
	if !strings.Contains(tree.Body.String(), `"path":"GM/3A GM"`) {
		t.Fatalf("tree body %s", tree.Body.String())
	}
	if calls.Load() != before {
		t.Fatalf("tree recalled Hugging Face: %d -> %d", before, calls.Load())
	}

	second := httptest.NewRecorder()
	server.ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/api/index", nil))
	if second.Header().Get("X-Cache-Status") != "HIT" {
		t.Fatalf("second index cache %s", second.Header().Get("X-Cache-Status"))
	}
	if calls.Load() != before {
		t.Fatal("index was fetched again")
	}
}

func TestFileProxyCachesAndRejectsTraversal(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Length", "4")
		_, _ = w.Write([]byte("%PDF"))
	}))
	defer upstream.Close()
	server := New(config.Config{
		HFOrigin:              upstream.URL,
		BucketID:              "ktongue/ENISE-SITE",
		MaxCacheableFileBytes: 1024,
		FileTTL:               config.Load("").FileTTL,
	})

	first := httptest.NewRecorder()
	server.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/api/file?path=GM/poly.pdf", nil))
	if first.Code != 200 || first.Body.String() != "%PDF" {
		t.Fatalf("first %d %s", first.Code, first.Body.String())
	}
	if first.Header().Get("X-Cache-Status") != "MISS" {
		t.Fatalf("cache %s", first.Header().Get("X-Cache-Status"))
	}

	second := httptest.NewRecorder()
	server.ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/api/file/GM/poly.pdf", nil))
	if second.Body.String() != "%PDF" || second.Header().Get("X-Cache-Status") != "HIT" {
		t.Fatalf("second %d %s %s", second.Code, second.Header().Get("X-Cache-Status"), second.Body.String())
	}
	if calls.Load() != 1 {
		t.Fatalf("upstream calls %d", calls.Load())
	}

	ranged := httptest.NewRecorder()
	rangeReq := httptest.NewRequest(http.MethodGet, "/api/file?path=GM/poly.pdf", nil)
	rangeReq.Header.Set("Range", "bytes=1-2")
	server.ServeHTTP(ranged, rangeReq)
	if ranged.Code != http.StatusPartialContent || ranged.Body.String() != "PD" {
		t.Fatalf("range %d %s", ranged.Code, ranged.Body.String())
	}

	bad := httptest.NewRecorder()
	server.ServeHTTP(bad, httptest.NewRequest(http.MethodGet, "/api/file?path=../secret", nil))
	if bad.Code != 400 {
		t.Fatalf("traversal %d", bad.Code)
	}
}

func TestOfficePDFAndLinkGuards(t *testing.T) {
	var conversions atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/resolve/"):
			_, _ = w.Write([]byte("office-bytes"))
		case r.URL.Path == "/api/convert-office":
			conversions.Add(1)
			if _, err := io.ReadAll(r.Body); err != nil {
				t.Error(err)
			}
			w.Header().Set("Content-Type", "application/pdf")
			_, _ = w.Write([]byte("%PDF-1.7"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	server := New(config.Config{
		HFOrigin:         upstream.URL,
		BucketID:         "ktongue/ENISE-SITE",
		OfficeConvertURL: upstream.URL,
		MaxOfficeBytes:   1024,
		OfficePDFTTL:     config.Load("").IndexTTL,
	})

	status := httptest.NewRecorder()
	server.ServeHTTP(status, httptest.NewRequest(http.MethodGet, "/api/office/status", nil))
	if !strings.Contains(status.Body.String(), `"ready"`) {
		t.Fatalf("status %s", status.Body.String())
	}

	first := httptest.NewRecorder()
	server.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/api/office/pdf?path=GM/cours.docx", nil))
	if first.Code != 200 || !strings.HasPrefix(first.Body.String(), "%PDF-") {
		t.Fatalf("pdf %d %s", first.Code, first.Body.String())
	}
	second := httptest.NewRecorder()
	server.ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/api/office/pdf?path=GM/cours.docx", nil))
	if second.Header().Get("X-Cache-Status") != "HIT" || conversions.Load() != 1 {
		t.Fatalf("cache %s conversions %d", second.Header().Get("X-Cache-Status"), conversions.Load())
	}

	blocked := httptest.NewRecorder()
	server.ServeHTTP(blocked, httptest.NewRequest(http.MethodGet, "/api/link/preview?url=http://127.0.0.1/secret", nil))
	if blocked.Code != 400 {
		t.Fatalf("link %d %s", blocked.Code, blocked.Body.String())
	}

	aps := httptest.NewRecorder()
	server.ServeHTTP(aps, httptest.NewRequest(http.MethodGet, "/api/aps/token", nil))
	if aps.Code != http.StatusNotImplemented {
		t.Fatalf("aps %d", aps.Code)
	}
}

func TestSolidworksReusesLocalStep(t *testing.T) {
	source := []byte("local-solidworks-source")
	sum := sha256Hex(source)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.EscapedPath(), "/GM/piece.step.json") && !strings.Contains(r.URL.EscapedPath(), "/derived/") {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"sourceSha256":"` + sum + `","dependencies":[],"size":456}`))
			return
		}
		if strings.Contains(r.URL.EscapedPath(), "/derived/") {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(source)
	}))
	defer upstream.Close()
	server := New(config.Config{
		HFOrigin:           upstream.URL,
		BucketID:           "ktongue/ENISE-SITE",
		MaxSolidworksBytes: 1_000_000,
	})
	response := httptest.NewRecorder()
	server.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/solidworks/step?path=GM/piece.sldprt", nil))
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"cached":true`) || !strings.Contains(response.Body.String(), `"stepPath":"GM/piece.step"`) {
		t.Fatalf("solidworks %d %s", response.Code, response.Body.String())
	}
}

func TestHealthAndMethod(t *testing.T) {
	server := New(config.Config{BucketID: "ktongue/ENISE-SITE", HFOrigin: "http://127.0.0.1:1"})
	health := httptest.NewRecorder()
	server.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if health.Code != 200 || !strings.Contains(health.Body.String(), `"backend":"go"`) {
		t.Fatalf("health %d %s", health.Code, health.Body.String())
	}
	post := httptest.NewRecorder()
	server.ServeHTTP(post, httptest.NewRequest(http.MethodPost, "/api/tree", nil))
	if post.Code != http.StatusMethodNotAllowed {
		t.Fatalf("method %d", post.Code)
	}
}
