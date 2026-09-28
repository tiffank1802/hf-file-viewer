package reader

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode"
)

const (
	maxChunkLineBytes  = 8 << 20
	fallbackChunkRunes = 2400
)

func DecodeCatalog(payload []byte) (*Catalog, error) {
	var value Catalog
	if err := json.Unmarshal(payload, &value); err != nil {
		return nil, fmt.Errorf("catalogue Docling invalide: %w", err)
	}
	if value.Documents == nil {
		return nil, errors.New("catalogue Docling sans documents")
	}
	return &value, nil
}

func DecodeManifest(payload []byte) (*Manifest, error) {
	var value Manifest
	if err := json.Unmarshal(payload, &value); err != nil {
		return nil, fmt.Errorf("manifest Docling invalide: %w", err)
	}
	if value.Status != "ready" || value.ArtifactID == "" || value.SourcePath == "" {
		return nil, errors.New("manifest Docling incomplet")
	}
	return &value, nil
}

func DecodeChunks(payload []byte) ([]RawChunk, error) {
	scanner := bufio.NewScanner(bytes.NewReader(payload))
	scanner.Buffer(make([]byte, 64<<10), maxChunkLineBytes)
	chunks := make([]RawChunk, 0, 32)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var chunk RawChunk
		if err := json.Unmarshal(line, &chunk); err != nil {
			return nil, fmt.Errorf("chunk Docling invalide: %w", err)
		}
		if strings.TrimSpace(chunk.Text) == "" {
			continue
		}
		chunks = append(chunks, chunk)
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("lecture des chunks Docling: %w", err)
	}
	return chunks, nil
}

// Normalize relie les métadonnées du HybridChunker aux blockId stables.
func Normalize(sourcePath string, documentJSON, chunksJSON []byte) (*Document, error) {
	var raw RawDocument
	if err := json.Unmarshal(documentJSON, &raw); err != nil {
		return nil, fmt.Errorf("document Docling invalide: %w", err)
	}
	if raw.ArtifactID == "" || len(raw.Blocks) == 0 {
		return nil, errors.New("document Docling vide")
	}
	rawChunks, err := DecodeChunks(chunksJSON)
	if err != nil {
		return nil, err
	}

	document := &Document{
		SourcePath:      sourcePath,
		ArtifactID:      raw.ArtifactID,
		PipelineVersion: raw.PipelineVersion,
		Title:           strings.TrimSpace(raw.Title),
		Blocks:          make([]Block, 0, len(raw.Blocks)),
	}
	if document.Title == "" {
		document.Title = baseName(sourcePath)
	}
	assetIDs := make(map[string]struct{}, len(raw.Assets))
	for _, item := range raw.Assets {
		id := strings.TrimSpace(item.ID)
		assetPath := strings.Trim(strings.TrimSpace(item.Path), "/")
		if id == "" || assetPath == "" {
			continue
		}
		if _, duplicate := assetIDs[id]; duplicate {
			continue
		}
		assetIDs[id] = struct{}{}
		width, height := item.Width, item.Height
		if width < 0 {
			width = 0
		}
		if height < 0 {
			height = 0
		}
		document.Assets = append(document.Assets, Asset{
			ID:      id,
			Kind:    strings.ToLower(strings.TrimSpace(item.Kind)),
			Path:    assetPath,
			Width:   width,
			Height:  height,
			BlockID: strings.TrimSpace(item.BlockID),
			Caption: strings.TrimSpace(item.Caption),
		})
	}

	byID := make(map[string]*Block, len(raw.Blocks))
	byRef := make(map[string]string, len(raw.Blocks))
	headings := make([]heading, 0, 8)
	outlineSeen := map[string]struct{}{}
	for _, item := range raw.Blocks {
		text := strings.TrimSpace(item.Text)
		kind := strings.ToLower(strings.TrimSpace(item.Type))
		if isHeading(kind) && text != "" {
			level := item.Level
			if level <= 0 {
				level = 1
			}
			for len(headings) > 0 && headings[len(headings)-1].level >= level {
				headings = headings[:len(headings)-1]
			}
			headings = append(headings, heading{level: level, text: text})
			if _, ok := outlineSeen[text]; !ok {
				document.Outline = append(document.Outline, text)
				outlineSeen[text] = struct{}{}
			}
		}
		path := make([]string, 0, len(headings))
		for _, parent := range headings {
			path = append(path, parent.text)
		}
		page, bbox := firstLocation(item.Provenance)
		block := Block{
			ID:          item.ID,
			Ordinal:     item.Ordinal,
			Level:       item.Level,
			Type:        kind,
			Text:        text,
			SelfRef:     item.SelfRef,
			Caption:     strings.TrimSpace(item.Caption),
			Markdown:    strings.TrimSpace(item.Markdown),
			AssetID:     item.AssetID,
			HeadingPath: path,
			Page:        page,
			BBox:        bbox,
		}
		document.Blocks = append(document.Blocks, block)
		if block.SelfRef != "" {
			byRef[block.SelfRef] = block.ID
		}
	}
	// Construire les pointeurs après le remplissage de la slice : un append
	// peut déplacer son tableau sous-jacent et invalider des pointeurs anciens.
	for index := range document.Blocks {
		if document.Blocks[index].ID != "" {
			byID[document.Blocks[index].ID] = &document.Blocks[index]
		}
	}

	mapped := 0
	for index, item := range rawChunks {
		blockIDs := validBlockIDs(item.BlockIDs, byID)
		metaHeadings := []string(nil)
		if len(item.Meta) > 0 && string(item.Meta) != "null" {
			var meta hybridMeta
			if json.Unmarshal(item.Meta, &meta) == nil {
				metaHeadings = cleanStrings(meta.Headings)
				for _, docItem := range meta.DocItems {
					if id := byRef[docItem.SelfRef]; id != "" && !contains(blockIDs, id) {
						blockIDs = append(blockIDs, id)
					}
				}
			}
		}
		if len(blockIDs) == 0 {
			blockIDs = inferBlockIDs(item.Text, document.Blocks)
		}
		if len(blockIDs) > 0 {
			mapped++
		}
		headingPath := metaHeadings
		if len(headingPath) == 0 {
			headingPath = firstHeadingPath(blockIDs, byID)
		}
		document.Chunks = append(document.Chunks, Chunk{
			ID:          firstNonEmpty(item.ID, fmt.Sprintf("c-%06d", index+1)),
			Text:        enrichChunkText(item.Text, blockIDs, byID),
			BlockIDs:    blockIDs,
			HeadingPath: headingPath,
			Pages:       pagesFor(blockIDs, byID),
		})
	}

	// Un format de métadonnées inconnu ne doit pas casser les citations : les
	// blocs déjà extraits permettent de recréer les chunks sans relancer Docling.
	if len(document.Chunks) == 0 || mapped == 0 {
		document.Chunks = deterministicChunks(document.Blocks)
	}
	if len(document.Chunks) == 0 {
		return nil, errors.New("document Docling sans contenu textuel")
	}
	return document, nil
}

type heading struct {
	level int
	text  string
}

type hybridMeta struct {
	DocItems []struct {
		SelfRef string `json:"self_ref"`
	} `json:"doc_items"`
	Headings []string `json:"headings"`
}

func isHeading(kind string) bool {
	return kind == "title" || kind == "section_header" || kind == "heading"
}

func firstLocation(items []Provenance) (int, *BBox) {
	for _, item := range items {
		if item.PageNo > 0 || item.BBox != nil {
			return item.PageNo, item.BBox
		}
	}
	return 0, nil
}

func validBlockIDs(values []string, blocks map[string]*Block) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || blocks[value] == nil || contains(out, value) {
			continue
		}
		out = append(out, value)
	}
	return out
}

func inferBlockIDs(text string, blocks []Block) []string {
	needle := comparable(text)
	if len([]rune(needle)) < 12 {
		return nil
	}
	out := make([]string, 0, 4)
	for _, block := range blocks {
		candidate := comparable(blockContent(block))
		if len([]rune(candidate)) < 12 {
			continue
		}
		if strings.Contains(needle, candidate) || strings.Contains(candidate, needle) {
			out = append(out, block.ID)
			if len(out) >= 8 {
				break
			}
		}
	}
	return out
}

func comparable(value string) string {
	var b strings.Builder
	space := false
	for _, r := range strings.ToLower(value) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
			space = false
			continue
		}
		if !space {
			b.WriteByte(' ')
			space = true
		}
	}
	return strings.TrimSpace(b.String())
}

func firstHeadingPath(ids []string, blocks map[string]*Block) []string {
	for _, id := range ids {
		if block := blocks[id]; block != nil && len(block.HeadingPath) > 0 {
			return append([]string(nil), block.HeadingPath...)
		}
	}
	return nil
}

func pagesFor(ids []string, blocks map[string]*Block) []int {
	seen := map[int]struct{}{}
	pages := make([]int, 0, 2)
	for _, id := range ids {
		block := blocks[id]
		if block == nil || block.Page <= 0 {
			continue
		}
		if _, ok := seen[block.Page]; ok {
			continue
		}
		seen[block.Page] = struct{}{}
		pages = append(pages, block.Page)
	}
	sort.Ints(pages)
	return pages
}

func deterministicChunks(blocks []Block) []Chunk {
	chunks := make([]Chunk, 0, len(blocks)/4+1)
	texts := make([]string, 0, 8)
	ids := make([]string, 0, 8)
	runes := 0
	flush := func() {
		if len(texts) == 0 {
			return
		}
		byID := make(map[string]*Block, len(blocks))
		for index := range blocks {
			byID[blocks[index].ID] = &blocks[index]
		}
		chunks = append(chunks, Chunk{
			ID:          fmt.Sprintf("c-%06d", len(chunks)+1),
			Text:        strings.Join(texts, "\n\n"),
			BlockIDs:    append([]string(nil), ids...),
			HeadingPath: firstHeadingPath(ids, byID),
			Pages:       pagesFor(ids, byID),
		})
		texts, ids, runes = texts[:0], ids[:0], 0
	}
	for _, block := range blocks {
		text := strings.TrimSpace(blockContent(block))
		if text == "" {
			continue
		}
		size := len([]rune(text))
		if len(texts) > 0 && runes+size > fallbackChunkRunes {
			flush()
		}
		texts = append(texts, text)
		ids = append(ids, block.ID)
		runes += size
	}
	flush()
	return chunks
}

func enrichChunkText(value string, ids []string, blocks map[string]*Block) string {
	text := strings.TrimSpace(value)
	for _, id := range ids {
		block := blocks[id]
		if block == nil {
			continue
		}
		for _, extra := range []string{block.Markdown, block.Caption} {
			extra = strings.TrimSpace(extra)
			if extra == "" || strings.Contains(text, extra) {
				continue
			}
			if block.Caption == extra {
				extra = "Légende : " + extra
			}
			if text != "" {
				text += "\n"
			}
			text += extra
		}
	}
	return text
}

func blockContent(block Block) string {
	parts := make([]string, 0, 3)
	if block.Text != "" {
		parts = append(parts, block.Text)
	}
	if block.Markdown != "" && block.Markdown != block.Text {
		parts = append(parts, block.Markdown)
	}
	if block.Caption != "" && !strings.Contains(strings.Join(parts, " "), block.Caption) {
		parts = append(parts, "Légende : "+block.Caption)
	}
	return strings.Join(parts, "\n")
}

func cleanStrings(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !contains(out, value) {
			out = append(out, value)
		}
	}
	return out
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func baseName(value string) string {
	value = strings.TrimRight(value, "/")
	if index := strings.LastIndex(value, "/"); index >= 0 {
		return value[index+1:]
	}
	return value
}
