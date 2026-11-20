package api

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"enise-docs/backend/internal/catalog"

	"enise-docs/backend/internal/config"
)

func TestPDFDoclingSameRevisionAndPageScope(t *testing.T) {
	for _, state := range []string{"sha256", "strong-etag", "stale-artifact", "different-get-etag", "no-page-text"} {
		t.Run(state, func(t *testing.T) {
			data := []byte("%PDF-1.7\nsource")
			digest := fmt.Sprintf("%x", sha256.Sum256(data))
			manifestDigest := digest
			if state == "stale-artifact" {
				manifestDigest = strings.Repeat("f", 64)
			}
			const source = "GM/cours.pdf"
			const prefix = "reader/v1/a"
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch {
				case strings.HasSuffix(r.URL.Path, "/resolve/"+source):
					etag := `"identity"`
					if r.Method == http.MethodGet && state == "different-get-etag" {
						etag = `"other"`
					}
					w.Header().Set("ETag", etag)
					_, _ = w.Write(data)
				case strings.HasSuffix(r.URL.Path, "/"+readerCatalogPath):
					_, _ = fmt.Fprintf(w, `{"documents":{"%s":{"status":"ready","artifactId":"a","artifactPrefix":"%s","manifestPath":"%s/manifest.json"}}}`, source, prefix, prefix)
				case strings.HasSuffix(r.URL.Path, "/manifest.json"):
					_, _ = fmt.Fprintf(w, `{"sourcePath":"%s","artifactId":"a","status":"ready","sourceSha256":"%s","files":{"document":"document.json","chunks":"chunks.jsonl"}}`, source, manifestDigest)
				case strings.HasSuffix(r.URL.Path, "/document.json"):
					_, _ = fmt.Fprint(w, `{"artifactId":"a","blocks":[{"id":"p1","type":"section_header","text":"Secret autre page","provenance":[{"page_no":1}]},{"id":"p2","type":"paragraph","text":"Texte Docling page deux","provenance":[{"page_no":2}]},{"id":"p3","type":"paragraph","text":"Secret autre page dans un bloc multipage","provenance":[{"page_no":2},{"page_no":3}]}]}`)
				case strings.HasSuffix(r.URL.Path, "/chunks.jsonl"):
					_, _ = fmt.Fprintln(w, `{"id":"cross","text":"Secret autre page et deuxième page","blockIds":["p1","p2"],"pages":[1,2]}`)
				default:
					http.NotFound(w, r)
				}
			}))
			defer upstream.Close()
			s := New(config.Config{BucketID: "source", DerivedBucketID: "derived", HFOrigin: upstream.URL, CacheDir: t.TempDir()})
			revision := strongETagRevision(`"identity"`)
			if state == "sha256" {
				revision = "sha256:" + digest
			}
			s.cache.SetIndex(&catalog.IndexDocument{BucketID: "source", Complete: true, Items: []catalog.BucketItem{{Type: "file", Path: source}}}, time.Hour, time.Hour)
			query := url.Values{"path": {source}, "sourceRevision": {revision}}
			response := pdfTestRequest(s, http.MethodGet, "/api/reader/document?"+query.Encode(), nil, "")
			var meta struct {
				SourceRevision string
				Outline        []readerOutlineItem
			}
			if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &meta) != nil {
				t.Fatalf("metadata request failed: %d %s", response.Code, response.Body)
			}
			if state == "stale-artifact" || state == "different-get-etag" {
				if meta.SourceRevision != "" || len(meta.Outline) != 0 {
					t.Fatalf("stale outline exposed: %+v", meta)
				}
			} else if meta.SourceRevision != revision || len(meta.Outline) != 1 || meta.Outline[0].Page != 1 {
				t.Fatalf("matched outline missing: %+v", meta)
			}
			scope := chatScope{SourcePath: source, SourceRevision: revision, Page: 2}
			if state == "stale-artifact" || state == "different-get-etag" {
				scope.PDFContext = &pdfChatContext{TotalPages: 2, IndexedPages: 2, Passages: []pdfChatPassage{{Page: 2, Text: "Texte PDF.js"}}}
			}
			if state == "no-page-text" {
				scope.Page = 3
			}
			study, err := s.prepareDocumentStudy(context.Background(), scope, "Résume", "summary")
			if state == "no-page-text" {
				if err == nil {
					t.Fatal("missing scan/no evidence warning")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			citations := study.publicCitations()
			if len(citations) != 1 || citations[0].Page != 2 || citations[0].SourceRevision != revision || citations[0].Verified == nil || citations[0].BBox != nil {
				t.Fatalf("unexpected citations: %+v", citations)
			}
			if state == "sha256" || state == "strong-etag" {
				if !*citations[0].Verified || citations[0].Origin != "docling" || citations[0].Text != "Texte Docling page deux" || study.Retrieval.Coverage.Kind != "docling-extracts" {
					t.Fatalf("unexpected Docling citation: %+v", citations[0])
				}
			} else if *citations[0].Verified || citations[0].Text != "Texte PDF.js" {
				t.Fatalf("stale artifact trusted: %+v", citations[0])
			}
			if strings.Contains(studyDocumentPrompt("Résume", study), "Secret autre page") {
				t.Fatal("page scope escaped")
			}
			if state == "strong-etag" {
				scope.Page = 0
				full, err := s.prepareDocumentStudy(context.Background(), scope, "Résume tout le document", "summary")
				if err != nil || full.KnowledgeSource != "docling" || full.Retrieval.Coverage.Kind == "whole-document" || !strings.Contains(studyDocumentPrompt("Résume", full), "Secret autre page") {
					t.Fatalf("document-wide Docling coverage is invalid: %+v %v", full, err)
				}
			}
		})
	}
}

func TestPrivatePDFGeometry(t *testing.T) {
	s, _ := newPDFReaderTestServer(t)
	revision := strongETagRevision(`"revision-a"`)
	anchor := chatAnchor{SchemaVersion: pdfGeometrySchema, SourceRevision: revision, Page: 1, Geometry: &pdfGeometry{Shape: "rect", PageView: []float64{0, 0, 600, 700}, Points: [][]float64{{20, 20}, {30, 50}}}}
	if err := validatePDFAnnotationAnchor(&anchor, revision); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"sourcePath": "GM/cours.pdf", "sourceRevision": revision, "kind": "highlight", "anchor": anchor}
	w := pdfTestRequest(s, http.MethodPost, "/api/annotations", body, "session")
	if w.Code != http.StatusCreated {
		t.Fatalf("geometry write %d %s", w.Code, w.Body)
	}
	var saved struct {
		Item struct {
			Anchor chatAnchor
			Status string
		}
	}
	if err := json.Unmarshal(w.Body.Bytes(), &saved); err != nil || saved.Item.Status != "active" || saved.Item.Anchor.Geometry == nil {
		t.Fatalf("bad round trip: %+v %v", saved, err)
	}
	if _, err := s.prepareDocumentStudy(context.Background(), chatScope{SourcePath: "GM/cours.pdf", SourceRevision: revision, Anchor: &anchor}, "Analyse", "explain"); err == nil {
		t.Fatal("geometry accepted as AI context")
	}
	oversized := anchor
	oversized.Geometry = &pdfGeometry{Shape: "ink", PageView: anchor.Geometry.PageView, Points: make([][]float64, 161)}
	if validatePDFAnnotationAnchor(&oversized, revision) == nil {
		t.Fatal("oversized ink accepted")
	}
	anchor.Geometry.Points[1][0] = 800
	if validatePDFAnnotationAnchor(&anchor, revision) == nil {
		t.Fatal("out-of-page geometry accepted")
	}
}
