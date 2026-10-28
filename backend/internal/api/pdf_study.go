package api

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"path"
	"strings"

	"enise-docs/backend/internal/catalog"
	"enise-docs/backend/internal/reader"
)

const pdfAnchorSchema = "pdf-anchor/v1"

// The server validates the shape, source revision and access; it deliberately
// does not claim the browser-supplied text or geometry was extracted by Go.
func validatePDFAnchor(anchor *chatAnchor, revision string) error {
	if anchor == nil || anchor.SchemaVersion != pdfAnchorSchema || anchor.SourceRevision != revision || !validPDFRevision(revision) {
		return catalog.Error(http.StatusBadRequest, "La version ou le format de l’ancre PDF est invalide.")
	}
	if anchor.Origin != "pdf-text" && anchor.Origin != "ocr" {
		return catalog.Error(http.StatusBadRequest, "L’origine du texte PDF est invalide.")
	}
	if err := validateAnnotationAnchor(anchor, false); err != nil {
		return err
	}
	if len(anchor.Segments) == 0 || len(anchor.Segments) > 8 || anchor.Page != anchor.Segments[0].Page {
		return catalog.Error(http.StatusBadRequest, "Les pages de la sélection PDF sont invalides.")
	}
	zones := 0
	previousPage := 0
	for _, segment := range anchor.Segments {
		if segment.Page < 1 || segment.Page > 100000 || segment.Page <= previousPage || len(segment.PageView) != 4 || len(segment.Quads) == 0 {
			return catalog.Error(http.StatusBadRequest, "La géométrie de sélection PDF est invalide.")
		}
		previousPage = segment.Page
		for _, value := range segment.PageView {
			if math.IsNaN(value) || math.IsInf(value, 0) || math.Abs(value) > 1_000_000 {
				return catalog.Error(http.StatusBadRequest, "Le cadre de la page PDF est invalide.")
			}
		}
		x0, y0, x1, y1 := segment.PageView[0], segment.PageView[1], segment.PageView[2], segment.PageView[3]
		if x1 <= x0 || y1 <= y0 {
			return catalog.Error(http.StatusBadRequest, "Le cadre de la page PDF est vide.")
		}
		zones += len(segment.Quads)
		for _, quad := range segment.Quads {
			if len(quad) != 8 {
				return catalog.Error(http.StatusBadRequest, "Un quadrilatère PDF est invalide.")
			}
			minX, minY, maxX, maxY := math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)
			for i := 0; i < 8; i += 2 {
				x, y := quad[i], quad[i+1]
				if math.IsNaN(x) || math.IsNaN(y) || math.IsInf(x, 0) || math.IsInf(y, 0) || x < x0-0.1 || x > x1+0.1 || y < y0-0.1 || y > y1+0.1 {
					return catalog.Error(http.StatusBadRequest, "Une zone de sélection déborde de la page PDF.")
				}
				minX, minY = math.Min(minX, x), math.Min(minY, y)
				maxX, maxY = math.Max(maxX, x), math.Max(maxY, y)
			}
			if maxX-minX < 0.01 || maxY-minY < 0.01 {
				return catalog.Error(http.StatusBadRequest, "Une zone de sélection PDF est vide.")
			}
		}
	}
	if zones > 32 {
		return catalog.Error(http.StatusBadRequest, "La sélection contient plus de 32 zones. Sélectionne un passage plus court.")
	}
	return nil
}

func (s *Server) preparePDFStudy(ctx context.Context, scope chatScope) (*documentStudy, error) {
	if err := s.verifyPDFRevision(ctx, scope.SourcePath, scope.SourceRevision); err != nil {
		return nil, err
	}
	if scope.Anchor != nil {
		if err := validatePDFAnchor(scope.Anchor, scope.SourceRevision); err != nil {
			return nil, err
		}
	}
	study := &documentStudy{
		SourcePath: scope.SourcePath, SourceRevision: scope.SourceRevision,
		KnowledgeSource: "pdf-reader", Status: "pdf-ready", Title: path.Base(scope.SourcePath),
		Anchor: scope.Anchor, AnchorVerified: false,
	}
	verified := false
	evidence := make([]reader.Evidence, 0, 9)
	if scope.Anchor != nil {
		text := strings.TrimSpace(scope.Anchor.Prefix + " " + scope.Anchor.Quote + " " + scope.Anchor.Suffix)
		evidence = append(evidence, reader.Evidence{
			CitationID: "S1", SourcePath: scope.SourcePath, SourceRevision: scope.SourceRevision,
			Page: scope.Anchor.Page, Segments: scope.Anchor.Segments, Kind: "selection",
			Origin: scope.Anchor.Origin, Verified: &verified, Text: text,
		})
	}
	ctxData := scope.PDFContext
	if ctxData != nil {
		if ctxData.TotalPages < 1 || ctxData.TotalPages > 100000 || ctxData.IndexedPages < 0 || ctxData.IndexedPages > ctxData.TotalPages || len(ctxData.Passages) > 8 {
			return nil, catalog.Error(http.StatusBadRequest, "La couverture de l’index PDF est invalide.")
		}
		budget := 0
		for _, passage := range ctxData.Passages {
			text := strings.TrimSpace(passage.Text)
			length := len([]rune(text))
			budget += length
			if passage.Page < 1 || passage.Page > ctxData.TotalPages || length == 0 || length > 2000 || budget > 16000 || (passage.Origin != "" && passage.Origin != "pdf-text" && passage.Origin != "ocr") {
				return nil, catalog.Error(http.StatusBadRequest, "Un passage de l’index PDF est invalide ou trop volumineux.")
			}
			origin := passage.Origin
			if origin == "" {
				origin = "pdf-text"
			}
			evidence = append(evidence, reader.Evidence{
				CitationID: fmt.Sprintf("S%d", len(evidence)+1), SourcePath: scope.SourcePath,
				SourceRevision: scope.SourceRevision, Page: passage.Page, Kind: "page",
				Origin: origin, Verified: &verified, Text: text,
			})
		}
		study.Retrieval.Coverage.IndexedPages = ctxData.IndexedPages
		study.Retrieval.Coverage.TotalPages = ctxData.TotalPages
		// An indexed page is not necessarily entirely included in this prompt.
		// Never call this an exhaustive summary merely because indexing finished.
		study.Retrieval.Coverage.Complete = ctxData.Complete && ctxData.IndexedPages == ctxData.TotalPages
	}
	if len(evidence) == 0 {
		return nil, catalog.Error(http.StatusBadRequest, "Sélectionne du texte ou attends qu’une page du PDF soit indexée.")
	}
	study.Retrieval.Evidence = evidence
	study.Retrieval.Coverage.Kind = "partial-pdf-reader"
	study.Retrieval.Coverage.SelectedChunks = len(evidence)
	study.Retrieval.Coverage.TotalChunks = study.Retrieval.Coverage.TotalPages
	return study, nil
}
