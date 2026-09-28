package api

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"enise-docs/backend/internal/catalog"
	"enise-docs/backend/internal/reader"
)

const (
	readerBlockLimit       = 60
	readerBlockTextMax     = 32_000
	readerBlockMarkdownMax = 128_000
	readerBlockBudget      = 512_000
	readerAssetMax         = 24 << 20
)

var readerExtensions = map[string]string{
	".pdf":  "pdf",
	".docx": "document", ".odt": "document",
	".pptx": "presentation", ".odp": "presentation",
	".xlsx": "spreadsheet", ".ods": "spreadsheet", ".csv": "spreadsheet",
	".html": "text", ".htm": "text", ".md": "text", ".txt": "text",
	".adoc": "text", ".asciidoc": "text", ".tex": "text", ".vtt": "text",
	".epub": "ebook", ".eml": "message", ".msg": "message",
	".png": "image", ".jpg": "image", ".jpeg": "image", ".tif": "image",
	".tiff": "image", ".webp": "image", ".bmp": "image",
}

var readerAssetTypes = map[string]string{
	".webp": "image/webp",
	".png":  "image/png",
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
}

type readerOutlineItem struct {
	BlockID string `json:"blockId"`
	Label   string `json:"label"`
	Level   int    `json:"level"`
	Page    int    `json:"page,omitempty"`
	Ordinal int    `json:"ordinal,omitempty"`
}

type readerAssetDTO struct {
	ID      string `json:"id"`
	Kind    string `json:"kind,omitempty"`
	Width   int    `json:"width,omitempty"`
	Height  int    `json:"height,omitempty"`
	Caption string `json:"caption,omitempty"`
}

type readerBlockDTO struct {
	ID          string          `json:"id"`
	Ordinal     int             `json:"ordinal"`
	Level       int             `json:"level,omitempty"`
	Type        string          `json:"type"`
	Text        string          `json:"text,omitempty"`
	Caption     string          `json:"caption,omitempty"`
	Markdown    string          `json:"markdown,omitempty"`
	AssetID     string          `json:"assetId,omitempty"`
	Asset       *readerAssetDTO `json:"asset,omitempty"`
	HeadingPath []string        `json:"headingPath,omitempty"`
	Page        int             `json:"page,omitempty"`
	BBox        *reader.BBox    `json:"bbox,omitempty"`
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
	blockCount := 0
	assetCount := 0
	if study.Document != nil {
		blockCount = len(study.Document.Blocks)
		assetCount = len(study.Document.Assets)
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
				Label:   readerDTOText(block.Text, 500),
				Level:   level,
				Page:    block.Page,
				Ordinal: block.Ordinal,
			})
		}
	}
	ready := study.ready()
	kind := readerDocumentKind(sourcePath)
	writeJSON(w, r, http.StatusOK, map[string]any{
		"schemaVersion":   "reader-ui/v1",
		"sourcePath":      study.SourcePath,
		"artifactId":      study.ArtifactID,
		"pipelineVersion": study.PipelineVersion,
		"title":           study.Title,
		"kind":            kind,
		"status":          study.Status,
		"knowledgeSource": study.KnowledgeSource,
		"pageCount":       pageCount,
		"blockCount":      blockCount,
		"assetCount":      assetCount,
		"outline":         outline,
		"capabilities": map[string]bool{
			"pdf":         kind == "pdf",
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
	pageNumber, err := strconv.Atoi(strings.TrimSpace(r.URL.Query().Get("page")))
	if err != nil || pageNumber <= 0 || pageNumber > 100000 {
		return catalog.Error(http.StatusBadRequest, "Le numéro de page est invalide.")
	}
	study, err := s.readerReadyStudy(r, sourcePath)
	if err != nil {
		return err
	}
	assets := readerAssetsByID(study.Document)
	blocks := make([]readerBlockDTO, 0, 16)
	budget := 0
	for _, block := range study.Document.Blocks {
		if block.Page != pageNumber {
			continue
		}
		dto := readerBlockFrom(block, assets)
		cost := len([]rune(dto.Text)) + len([]rune(dto.Markdown)) + len([]rune(dto.Caption))
		if len(blocks) > 0 && (len(blocks) >= 200 || budget+cost > readerBlockBudget) {
			break
		}
		blocks = append(blocks, dto)
		budget += cost
	}
	sort.SliceStable(blocks, func(i, j int) bool { return blocks[i].Ordinal < blocks[j].Ordinal })
	writeJSON(w, r, http.StatusOK, map[string]any{
		"schemaVersion": "reader-ui/v1",
		"sourcePath":    study.SourcePath,
		"artifactId":    study.ArtifactID,
		"page":          pageNumber,
		"blocks":        blocks,
	}, "private, max-age=300", nil)
	return nil
}

func (s *Server) handleReaderBlocks(w http.ResponseWriter, r *http.Request) error {
	sourcePath, err := s.readerSourcePath(r)
	if err != nil {
		return err
	}
	from := 1
	if raw := strings.TrimSpace(r.URL.Query().Get("from")); raw != "" {
		from, err = strconv.Atoi(raw)
		if err != nil || from < 1 || from > 100000000 {
			return catalog.Error(http.StatusBadRequest, "Le premier bloc demandé est invalide.")
		}
	}
	limit := 40
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > readerBlockLimit {
			return catalog.Error(http.StatusBadRequest, "La taille de page des blocs est invalide.")
		}
	}
	study, err := s.readerReadyStudy(r, sourcePath)
	if err != nil {
		return err
	}
	targetBlockID := strings.TrimSpace(r.URL.Query().Get("blockId"))
	if len([]rune(targetBlockID)) > 160 {
		return catalog.Error(http.StatusBadRequest, "L’identifiant du bloc demandé est invalide.")
	}
	if targetBlockID != "" {
		found := false
		for _, block := range study.Document.Blocks {
			if block.ID == targetBlockID {
				from = block.Ordinal - 2
				if from < 1 {
					from = 1
				}
				found = true
				break
			}
		}
		if !found {
			return catalog.Error(http.StatusNotFound, "Ce bloc n’appartient pas à l’artefact courant.")
		}
	}
	blocks, nextFrom := readerBlockWindow(study.Document, from, limit)
	writeJSON(w, r, http.StatusOK, map[string]any{
		"schemaVersion": "reader-ui/v1",
		"sourcePath":    study.SourcePath,
		"artifactId":    study.ArtifactID,
		"from":          from,
		"limit":         limit,
		"total":         len(study.Document.Blocks),
		"nextFrom":      nextFrom,
		"targetBlockId": targetBlockID,
		"blocks":        blocks,
	}, "private, max-age=300", nil)
	return nil
}

func (s *Server) handleReaderAsset(w http.ResponseWriter, r *http.Request) error {
	sourcePath, err := s.readerSourcePath(r)
	if err != nil {
		return err
	}
	assetID := strings.TrimSpace(r.URL.Query().Get("asset"))
	if assetID == "" || len([]rune(assetID)) > 160 {
		return catalog.Error(http.StatusBadRequest, "L’identifiant de l’illustration est invalide.")
	}
	study, err := s.readerReadyStudy(r, sourcePath)
	if err != nil {
		return err
	}
	var asset *reader.Asset
	for index := range study.Document.Assets {
		if study.Document.Assets[index].ID == assetID {
			asset = &study.Document.Assets[index]
			break
		}
	}
	if asset == nil || asset.Path == "" {
		return catalog.Error(http.StatusNotFound, "Cette illustration n’appartient pas à l’artefact courant.")
	}
	contentType := readerAssetTypes[strings.ToLower(path.Ext(asset.Path))]
	if contentType == "" {
		return catalog.Error(http.StatusUnsupportedMediaType, "Le format de cette illustration n’est pas autorisé.")
	}
	assetPath, err := artifactFile(study.ArtifactPrefix, asset.Path)
	if err != nil {
		return catalog.Error(http.StatusNotFound, "Chemin d’illustration invalide.")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	payload, err := s.downloadReaderAsset(ctx, assetPath)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Content-Disposition", "inline")
	http.ServeContent(w, r, path.Base(asset.Path), time.Time{}, bytes.NewReader(payload))
	return nil
}

func (s *Server) readerReadyStudy(r *http.Request, sourcePath string) (*documentStudy, error) {
	artifactID := strings.TrimSpace(r.URL.Query().Get("artifactId"))
	if artifactID == "" || len([]rune(artifactID)) > 160 {
		return nil, catalog.Error(http.StatusBadRequest, "La révision Docling est requise.")
	}
	study, err := s.readerStudy(r.Context(), sourcePath, artifactID)
	if err != nil {
		return nil, err
	}
	if !study.ready() || study.Document == nil {
		return nil, catalog.Error(http.StatusConflict, "La structure Docling de ce document n’est pas encore disponible.")
	}
	return study, nil
}

func (s *Server) downloadReaderAsset(ctx context.Context, assetPath string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, catalog.BuildHfFileURL(s.cfg.HFOrigin, s.cfg.DerivedBucketID, assetPath), nil)
	if err != nil {
		return nil, catalog.Error(http.StatusBadGateway, "Connexion au stockage des illustrations impossible.")
	}
	request.Header = s.hfHeaders("image/webp, image/png, image/jpeg")
	response, err := s.do(request)
	if err != nil {
		return nil, catalog.Error(http.StatusBadGateway, "Connexion au stockage des illustrations impossible.")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, catalog.Error(http.StatusNotFound, "Illustration structurée introuvable.")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, catalog.Error(http.StatusBadGateway, "Le stockage des illustrations est indisponible.")
	}
	if response.ContentLength > readerAssetMax {
		return nil, catalog.Error(http.StatusRequestEntityTooLarge, "Cette illustration est trop volumineuse.")
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, readerAssetMax+1))
	if err != nil {
		return nil, catalog.Error(http.StatusBadGateway, "Lecture de l’illustration interrompue.")
	}
	if len(payload) == 0 || len(payload) > readerAssetMax {
		return nil, catalog.Error(http.StatusBadGateway, "Taille d’illustration invalide.")
	}
	return payload, nil
}

func readerBlockWindow(document *reader.Document, from, limit int) ([]readerBlockDTO, int) {
	if document == nil {
		return []readerBlockDTO{}, 0
	}
	ordered := append([]reader.Block(nil), document.Blocks...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].Ordinal < ordered[j].Ordinal })
	assets := readerAssetsByID(document)
	blocks := make([]readerBlockDTO, 0, limit)
	budget := 0
	nextFrom := 0
	for index, block := range ordered {
		if block.Ordinal < from {
			continue
		}
		dto := readerBlockFrom(block, assets)
		cost := len([]rune(dto.Text)) + len([]rune(dto.Markdown)) + len([]rune(dto.Caption))
		if len(blocks) > 0 && (len(blocks) >= limit || budget+cost > readerBlockBudget) {
			nextFrom = block.Ordinal
			break
		}
		blocks = append(blocks, dto)
		budget += cost
		if len(blocks) >= limit && index < len(ordered)-1 {
			nextFrom = block.Ordinal + 1
			break
		}
	}
	return blocks, nextFrom
}

func readerBlockFrom(block reader.Block, assets map[string]reader.Asset) readerBlockDTO {
	dto := readerBlockDTO{
		ID:          readerDTOText(block.ID, 160),
		Ordinal:     block.Ordinal,
		Level:       block.Level,
		Type:        readerDTOText(block.Type, 64),
		Text:        readerDTOText(block.Text, readerBlockTextMax),
		Caption:     readerDTOText(block.Caption, 4000),
		Markdown:    readerDTOText(block.Markdown, readerBlockMarkdownMax),
		AssetID:     readerDTOText(block.AssetID, 160),
		HeadingPath: readerDTOHeadingPath(block.HeadingPath),
		Page:        block.Page,
		BBox:        block.BBox,
	}
	if asset, ok := assets[block.AssetID]; ok {
		dto.Asset = &readerAssetDTO{
			ID:      readerDTOText(asset.ID, 160),
			Kind:    readerDTOText(asset.Kind, 64),
			Width:   asset.Width,
			Height:  asset.Height,
			Caption: readerDTOText(asset.Caption, 4000),
		}
	}
	return dto
}

func readerAssetsByID(document *reader.Document) map[string]reader.Asset {
	items := make(map[string]reader.Asset)
	if document == nil {
		return items
	}
	for _, asset := range document.Assets {
		if asset.ID != "" {
			items[asset.ID] = asset
		}
	}
	return items
}

func readerDTOHeadingPath(values []string) []string {
	limit := len(values)
	if limit > 16 {
		limit = 16
	}
	out := make([]string, 0, limit)
	for _, value := range values[:limit] {
		if value = readerDTOText(value, 500); value != "" {
			out = append(out, value)
		}
	}
	return out
}

func readerDTOText(value string, limit int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}

func (s *Server) readerSourcePath(r *http.Request) (string, error) {
	sourcePath, err := catalog.NormalizeFilePath(r.URL.Query().Get("path"))
	if err != nil {
		return "", err
	}
	if readerDocumentKind(sourcePath) == "" {
		return "", catalog.Error(http.StatusBadRequest, "Ce format n’est pas pris en charge par le lecteur structuré.")
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

func readerDocumentKind(sourcePath string) string {
	return readerExtensions[strings.ToLower(path.Ext(sourcePath))]
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
