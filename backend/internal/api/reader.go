package api

import (
	"context"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"enise-docs/backend/internal/catalog"
	"enise-docs/backend/internal/reader"
)

type readerOutlineItem struct {
	BlockID string `json:"blockId"`
	Label   string `json:"label"`
	Level   int    `json:"level"`
	Page    int    `json:"page,omitempty"`
}

type readerBlockDTO struct {
	ID          string       `json:"id"`
	Ordinal     int          `json:"ordinal"`
	Level       int          `json:"level,omitempty"`
	Type        string       `json:"type"`
	Text        string       `json:"text,omitempty"`
	Caption     string       `json:"caption,omitempty"`
	Markdown    string       `json:"markdown,omitempty"`
	AssetID     string       `json:"assetId,omitempty"`
	HeadingPath []string     `json:"headingPath,omitempty"`
	Page        int          `json:"page,omitempty"`
	BBox        *reader.BBox `json:"bbox,omitempty"`
}

func (s *Server) handleReaderDocument(w http.ResponseWriter, r *http.Request) error {
	sourcePath, err := s.readerSourcePath(r)
	if err != nil {
		return err
	}
	artifactID := strings.TrimSpace(r.URL.Query().Get("artifactId"))
	study, err := s.readerStudy(r.Context(), sourcePath, artifactID)
	if err != nil {
		return err
	}
	outline := make([]readerOutlineItem, 0, len(study.Outline))
	pageCount := 0
	if study.Document != nil {
		for _, block := range study.Document.Blocks {
			if block.Page > pageCount {
				pageCount = block.Page
			}
			if !readerHeading(block.Type) || strings.TrimSpace(block.Text) == "" {
				continue
			}
			level := block.Level
			if level <= 0 {
				level = 1
			}
			outline = append(outline, readerOutlineItem{
				BlockID: block.ID,
				Label:   block.Text,
				Level:   level,
				Page:    block.Page,
			})
		}
	}
	ready := study.ready()
	writeJSON(w, r, http.StatusOK, map[string]any{
		"schemaVersion":   "reader-ui/v1",
		"sourcePath":      study.SourcePath,
		"artifactId":      study.ArtifactID,
		"pipelineVersion": study.PipelineVersion,
		"title":           study.Title,
		"kind":            "pdf",
		"status":          study.Status,
		"knowledgeSource": study.KnowledgeSource,
		"pageCount":       pageCount,
		"outline":         outline,
		"capabilities": map[string]bool{
			"pdf":         true,
			"structured":  ready,
			"selectionAI": ready,
			"annotations": ready && s.authReady() && s.appwrite().HasAnnotations(),
		},
	}, "no-store", nil)
	return nil
}

func (s *Server) handleReaderPage(w http.ResponseWriter, r *http.Request) error {
	sourcePath, err := s.readerSourcePath(r)
	if err != nil {
		return err
	}
	page, err := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("page")))
	if err != nil || page <= 0 || page > 100000 {
		return catalog.Error(http.StatusBadRequest, "Le numéro de page est invalide.")
	}
	artifactID := strings.TrimSpace(r.URL.Query().Get("artifactId"))
	study, err := s.readerStudy(r.Context(), sourcePath, artifactID)
	if err != nil {
		return err
	}
	if !study.ready() || study.Document == nil {
		return catalog.Error(http.StatusConflict, "La structure Docling de ce document n’est pas encore disponible.")
	}
	blocks := make([]readerBlockDTO, 0, 16)
	for _, block := range study.Document.Blocks {
		if block.Page != page {
			continue
		}
		blocks = append(blocks, readerBlockDTO{
			ID:          block.ID,
			Ordinal:     block.Ordinal,
			Level:       block.Level,
			Type:        block.Type,
			Text:        block.Text,
			Caption:     block.Caption,
			Markdown:    block.Markdown,
			AssetID:     block.AssetID,
			HeadingPath: append([]string(nil), block.HeadingPath...),
			Page:        block.Page,
			BBox:        block.BBox,
		})
	}
	sort.SliceStable(blocks, func(i, j int) bool { return blocks[i].Ordinal < blocks[j].Ordinal })
	writeJSON(w, r, http.StatusOK, map[string]any{
		"schemaVersion": "reader-ui/v1",
		"sourcePath":    study.SourcePath,
		"artifactId":    study.ArtifactID,
		"page":          page,
		"blocks":        blocks,
	}, "private, max-age=300", nil)
	return nil
}

func (s *Server) readerSourcePath(r *http.Request) (string, error) {
	sourcePath, err := catalog.NormalizeFilePath(r.URL.Query().Get("path"))
	if err != nil {
		return "", err
	}
	if !strings.EqualFold(path.Ext(sourcePath), ".pdf") {
		return "", catalog.Error(http.StatusBadRequest, "Le lecteur interactif accepte uniquement les documents PDF.")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	result, err := s.loadIndex(ctx, false)
	if err != nil {
		return "", err
	}
	for _, item := range result.doc.Items {
		if item.Type == "file" && item.Path == sourcePath {
			return sourcePath, nil
		}
	}
	return "", catalog.Error(http.StatusNotFound, "Ce document n’existe pas dans la bibliothèque indexée.")
}

func (s *Server) readerStudy(ctx context.Context, sourcePath, artifactID string) (*documentStudy, error) {
	resolveCtx, cancel := context.WithTimeout(ctx, chatExcerptWait)
	defer cancel()
	return s.prepareDocumentStudy(resolveCtx, chatScope{
		Type:       "document",
		SourcePath: sourcePath,
		ArtifactID: artifactID,
	}, "Plan du document", "outline")
}

func readerHeading(kind string) bool {
	switch strings.ToLower(strings.TrimSpace(kind)) {
	case "title", "section_header", "heading":
		return true
	default:
		return false
	}
}
