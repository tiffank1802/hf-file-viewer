package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strings"
	"time"

	"enise-docs/backend/internal/appwrite"
	"enise-docs/backend/internal/catalog"
)

func (s *Server) handlePDFAnnotationList(w http.ResponseWriter, r *http.Request, user appwrite.User, secret, revision string) error {
	sourcePath, err := s.readerSourcePath(r)
	if err != nil {
		return err
	}
	if len([]rune(sourcePath)) > 1024 {
		return catalog.Error(http.StatusBadRequest, "Le chemin du document est trop long pour les annotations.")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	if err := s.verifyPDFRevision(ctx, sourcePath, revision); err != nil {
		return err
	}
	key := appwrite.DocumentKey(sourcePath)
	legacy, err := s.appwrite().ListAnnotations(ctx, secret, user.ID, key)
	if err != nil {
		return s.annotationFail(err)
	}
	pdfItems, pdfErr := s.appwrite().PDFAnnotations().ListAnnotations(ctx, secret, user.ID, key)
	if pdfErr != nil && !appwrite.IsMissingTable(pdfErr) {
		return s.annotationFail(pdfErr)
	}
	items := make([]map[string]any, 0, len(legacy)+len(pdfItems))
	for _, entry := range legacy {
		item := publicAnnotation(entry, "")
		// A Docling artefact identifies a pipeline version, not the source PDF.
		// Do not silently put its old rectangles on the current page.
		if item["status"] == "active" {
			item["status"] = "needs-review"
		}
		item["legacy"] = true
		items = append(items, item)
	}
	for _, entry := range pdfItems {
		items = append(items, publicPDFAnnotation(entry, revision))
	}
	sort.SliceStable(items, func(i, j int) bool {
		a, _ := items[i]["updatedAt"].(string)
		b, _ := items[j]["updatedAt"].(string)
		return a > b
	})
	payload := map[string]any{"ok": true, "enabled": true, "sourceRevision": revision, "items": items}
	if pdfErr != nil {
		payload["storageAvailable"] = false
		payload["warning"] = "La table des annotations PDF n’est pas encore provisionnée. Contacte l’administrateur pour vérifier le stockage."
	} else {
		payload["storageAvailable"] = true
	}
	writeJSON(w, r, http.StatusOK, payload, "no-store", nil)
	return nil
}

func (s *Server) handlePDFAnnotationCreate(w http.ResponseWriter, r *http.Request, user appwrite.User, secret string, body annotationCreateRequest) error {
	sourcePath, err := catalog.NormalizeFilePath(body.SourcePath)
	if err != nil {
		return err
	}
	if len([]rune(sourcePath)) > 1024 {
		return catalog.Error(http.StatusBadRequest, "Le chemin du document est trop long pour les annotations.")
	}
	query := r.Clone(r.Context())
	params := query.URL.Query()
	params.Set("path", sourcePath)
	query.URL.RawQuery = params.Encode()
	if _, err := s.readerSourcePath(query); err != nil {
		return err
	}
	if err := validatePDFAnchor(&body.Anchor, body.SourceRevision); err != nil {
		return err
	}
	kind, color, note, err := normalizeAnnotationFields(body.Kind, body.Color, body.Body)
	if err != nil {
		return err
	}
	anchorJSON, err := json.Marshal(body.Anchor)
	if err != nil || len(anchorJSON) > 16000 {
		return catalog.Error(http.StatusBadRequest, "L’ancre de sélection est trop volumineuse.")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	if err := s.verifyPDFRevision(ctx, sourcePath, body.SourceRevision); err != nil {
		return err
	}
	created, err := s.appwrite().PDFAnnotations().CreateAnnotation(ctx, secret, user.ID, appwrite.Annotation{
		DocumentKey: appwrite.DocumentKey(sourcePath), SourcePath: sourcePath,
		SourceRevision: body.SourceRevision, Page: body.Anchor.Page, AnchorJSON: string(anchorJSON),
		Kind: kind, Color: color, Body: note, Status: "active",
	})
	if err != nil {
		return s.annotationFail(err)
	}
	writeJSON(w, r, http.StatusCreated, map[string]any{"ok": true, "item": publicPDFAnnotation(created, body.SourceRevision)}, "no-store", nil)
	return nil
}

func publicPDFAnnotation(item appwrite.Annotation, currentRevision string) map[string]any {
	out := publicAnnotation(item, "")
	out["id"] = pdfAnnotationIDPrefix + item.RowID
	out["sourceRevision"] = item.SourceRevision
	anchor, ok := out["anchor"].(chatAnchor)
	if !ok || anchor.SchemaVersion != pdfAnchorSchema || anchor.SourceRevision != item.SourceRevision ||
		strings.TrimSpace(item.SourceRevision) == "" || validatePDFAnchor(&anchor, item.SourceRevision) != nil ||
		(currentRevision != "" && item.SourceRevision != currentRevision) {
		if out["status"] == "active" {
			out["status"] = "needs-review"
		}
	}
	return out
}
