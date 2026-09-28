package reader

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"unicode"
)

const (
	defaultMaxChunks = 12
	defaultMaxRunes  = 24000
)

var retrievalStopwords = map[string]struct{}{
	"a": {}, "au": {}, "aux": {}, "avec": {}, "ce": {}, "ces": {}, "cette": {},
	"dans": {}, "de": {}, "des": {}, "du": {}, "en": {}, "et": {}, "est": {},
	"il": {}, "la": {}, "le": {}, "les": {}, "leur": {}, "mais": {}, "ou": {},
	"par": {}, "pour": {}, "que": {}, "qui": {}, "se": {}, "sur": {}, "un": {},
	"une": {}, "document": {}, "explique": {}, "expliquer": {}, "resume": {},
	"resumer": {}, "synthese": {}, "faire": {}, "donne": {}, "moi": {},
}

// Retrieve choisit un contexte borné. Les demandes de résumé échantillonnent
// toutes les sections ; les questions libres utilisent un BM25 léger et les
// chunks voisins.
func Retrieve(document *Document, query Query) Retrieval {
	if document == nil || len(document.Chunks) == 0 {
		return Retrieval{Coverage: Coverage{Kind: "unavailable"}}
	}
	maxChunks := query.MaxChunks
	if maxChunks <= 0 {
		maxChunks = defaultMaxChunks
	}
	if maxChunks > len(document.Chunks) {
		maxChunks = len(document.Chunks)
	}
	maxRunes := query.MaxRunes
	if maxRunes <= 0 {
		maxRunes = defaultMaxRunes
	}

	summary := isSummaryQuery(query.Text, query.Intent)
	selected := selectTargeted(document.Chunks, query.Text, maxChunks)
	kind := "targeted"
	if summary {
		selected = selectForSummary(document.Chunks, maxChunks)
		sort.Ints(selected)
		kind = "representative-summary"
	} else if query.AnchorBlockID != "" || strings.TrimSpace(query.AnchorQuote) != "" {
		selected = prioritizeAnchor(document.Chunks, query, selected, maxChunks)
		kind = "anchored"
	}

	byID := make(map[string]*Block, len(document.Blocks))
	for index := range document.Blocks {
		byID[document.Blocks[index].ID] = &document.Blocks[index]
	}
	evidence := make([]Evidence, 0, len(selected))
	remaining := maxRunes
	selectedBlocks := map[string]struct{}{}
	selectedSections := map[string]struct{}{}
	for _, index := range selected {
		if index < 0 || index >= len(document.Chunks) || remaining <= 0 {
			continue
		}
		chunk := document.Chunks[index]
		text := strings.TrimSpace(chunk.Text)
		if text == "" {
			continue
		}
		text = clipRunes(text, remaining)
		remaining -= len([]rune(text))
		page := 0
		var bbox *BBox
		blockKind := "text"
		for _, blockID := range chunk.BlockIDs {
			selectedBlocks[blockID] = struct{}{}
			if block := byID[blockID]; block != nil && page == 0 {
				page, bbox, blockKind = block.Page, block.BBox, block.Type
			}
		}
		sectionKey := strings.Join(chunk.HeadingPath, " / ")
		if sectionKey == "" {
			sectionKey = "Document"
		}
		selectedSections[sectionKey] = struct{}{}
		evidence = append(evidence, Evidence{
			CitationID:  fmt.Sprintf("S%d", len(evidence)+1),
			SourcePath:  document.SourcePath,
			ArtifactID:  document.ArtifactID,
			ChunkID:     chunk.ID,
			BlockIDs:    append([]string(nil), chunk.BlockIDs...),
			HeadingPath: append([]string(nil), chunk.HeadingPath...),
			Page:        page,
			BBox:        bbox,
			Kind:        blockKind,
			Text:        text,
		})
	}

	totalBlocks := 0
	for _, block := range document.Blocks {
		if strings.TrimSpace(blockContent(block)) != "" {
			totalBlocks++
		}
	}
	totalSections := sectionCount(document.Chunks)
	coverage := Coverage{
		Kind:             kind,
		SelectedChunks:   len(evidence),
		TotalChunks:      len(document.Chunks),
		SelectedSections: len(selectedSections),
		TotalSections:    totalSections,
	}
	if coverage.TotalChunks > 0 {
		coverage.Ratio = roundedRatio(coverage.SelectedChunks, coverage.TotalChunks)
	}
	if totalBlocks > 0 {
		coverage.BlockCoverage = roundedRatio(len(selectedBlocks), totalBlocks)
	}
	if summary && len(evidence) == len(document.Chunks) {
		coverage.Kind = "whole-document"
	}
	return Retrieval{Evidence: evidence, Coverage: coverage}
}

func prioritizeAnchor(chunks []Chunk, query Query, selected []int, limit int) []int {
	if limit <= 0 {
		return nil
	}
	anchors := make([]int, 0, 2)
	quote := comparable(query.AnchorQuote)
	for index, chunk := range chunks {
		matchesBlock := query.AnchorBlockID != "" && contains(chunk.BlockIDs, query.AnchorBlockID)
		matchesQuote := quote != "" && strings.Contains(comparable(chunk.Text), quote)
		matchesPage := query.AnchorPage > 0 && containsInt(chunk.Pages, query.AnchorPage)
		if matchesBlock || matchesQuote || (query.AnchorBlockID == "" && quote == "" && matchesPage) {
			anchors = append(anchors, index)
		}
	}
	if len(anchors) == 0 {
		return selected
	}
	out := make([]int, 0, limit)
	appendIndex := func(index int) {
		if index < 0 || index >= len(chunks) || len(out) >= limit || containsInt(out, index) {
			return
		}
		out = append(out, index)
	}
	for _, index := range anchors {
		appendIndex(index)
	}
	for _, index := range anchors {
		appendIndex(index - 1)
		appendIndex(index + 1)
	}
	for _, index := range selected {
		appendIndex(index)
	}
	return out
}

func selectForSummary(chunks []Chunk, limit int) []int {
	if len(chunks) <= limit {
		out := make([]int, len(chunks))
		for index := range chunks {
			out[index] = index
		}
		return out
	}
	selected := make([]int, 0, limit)
	seenSection := map[string]struct{}{}
	// Un premier passage garantit une représentation de chaque section tant
	// que le budget le permet.
	for index, chunk := range chunks {
		key := strings.Join(chunk.HeadingPath, " / ")
		if key == "" {
			key = fmt.Sprintf("page-%d", firstPage(chunk.Pages))
		}
		if _, ok := seenSection[key]; ok {
			continue
		}
		seenSection[key] = struct{}{}
		selected = append(selected, index)
		if len(selected) >= limit {
			return selected
		}
	}
	// Puis répartir les places restantes sur toute la longueur du document.
	for slot := 0; len(selected) < limit && slot < limit*3; slot++ {
		index := int(math.Round(float64(slot+1) * float64(len(chunks)-1) / float64(limit)))
		if index >= len(chunks) {
			index = len(chunks) - 1
		}
		if !containsInt(selected, index) {
			selected = append(selected, index)
		}
	}
	for index := range chunks {
		if len(selected) >= limit {
			break
		}
		if !containsInt(selected, index) {
			selected = append(selected, index)
		}
	}
	return selected
}

func selectTargeted(chunks []Chunk, question string, limit int) []int {
	terms := retrievalTokens(question)
	if len(terms) == 0 {
		return selectForSummary(chunks, limit)
	}
	documentFrequency := map[string]int{}
	chunkTokens := make([]map[string]int, len(chunks))
	for index, chunk := range chunks {
		counts := tokenCounts(chunk.Text)
		chunkTokens[index] = counts
		for _, term := range terms {
			if counts[term] > 0 {
				documentFrequency[term]++
			}
		}
	}
	type scored struct {
		index int
		score float64
	}
	ranked := make([]scored, 0, len(chunks))
	for index, chunk := range chunks {
		score := 0.0
		headingCounts := tokenCounts(strings.Join(chunk.HeadingPath, " "))
		for _, term := range terms {
			idf := math.Log((float64(len(chunks))+1)/(float64(documentFrequency[term])+1)) + 1
			tf := float64(chunkTokens[index][term])
			headingTF := float64(headingCounts[term])
			score += idf * (tf + headingTF*4)
		}
		if score > 0 {
			ranked = append(ranked, scored{index: index, score: score})
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].score == ranked[j].score {
			return ranked[i].index < ranked[j].index
		}
		return ranked[i].score > ranked[j].score
	})
	if len(ranked) == 0 {
		return selectForSummary(chunks, limit)
	}

	selected := make([]int, 0, limit)
	seeds := limit / 2
	if seeds < 1 {
		seeds = 1
	}
	if seeds > len(ranked) {
		seeds = len(ranked)
	}
	for _, candidate := range ranked[:seeds] {
		if !containsInt(selected, candidate.index) {
			selected = append(selected, candidate.index)
		}
	}
	for distance := 1; len(selected) < limit; distance++ {
		added := false
		for _, candidate := range ranked[:seeds] {
			for _, index := range []int{candidate.index - distance, candidate.index + distance} {
				if index < 0 || index >= len(chunks) || containsInt(selected, index) {
					continue
				}
				selected = append(selected, index)
				added = true
				if len(selected) >= limit {
					break
				}
			}
			if len(selected) >= limit {
				break
			}
		}
		if !added {
			break
		}
	}
	return selected
}

func retrievalTokens(value string) []string {
	counts := tokenCounts(value)
	out := make([]string, 0, len(counts))
	for token := range counts {
		if _, stop := retrievalStopwords[token]; !stop && len([]rune(token)) > 1 {
			out = append(out, token)
		}
	}
	sort.Strings(out)
	return out
}

func tokenCounts(value string) map[string]int {
	counts := map[string]int{}
	var token []rune
	flush := func() {
		if len(token) == 0 {
			return
		}
		word := foldToken(string(token))
		if word != "" {
			counts[word]++
		}
		token = token[:0]
	}
	for _, r := range strings.ToLower(value) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			token = append(token, r)
		} else {
			flush()
		}
	}
	flush()
	return counts
}

func foldToken(value string) string {
	var b strings.Builder
	for _, r := range value {
		switch r {
		case 'à', 'á', 'â', 'ä', 'ã', 'å':
			r = 'a'
		case 'ç':
			r = 'c'
		case 'è', 'é', 'ê', 'ë':
			r = 'e'
		case 'ì', 'í', 'î', 'ï':
			r = 'i'
		case 'ñ':
			r = 'n'
		case 'ò', 'ó', 'ô', 'ö', 'õ':
			r = 'o'
		case 'ù', 'ú', 'û', 'ü':
			r = 'u'
		case 'ý', 'ÿ':
			r = 'y'
		}
		b.WriteRune(r)
	}
	return b.String()
}

func isSummaryQuery(text, intent string) bool {
	intent = foldToken(strings.ToLower(strings.TrimSpace(intent)))
	switch intent {
	case "summary", "study-guide", "outline", "glossary", "quiz":
		return true
	}
	value := foldToken(strings.ToLower(text))
	for _, marker := range []string{"resume", "synthese", "fiche de revision", "plan detaille", "tout le document"} {
		if strings.Contains(value, marker) {
			return true
		}
	}
	return false
}

func sectionCount(chunks []Chunk) int {
	seen := map[string]struct{}{}
	for _, chunk := range chunks {
		key := strings.Join(chunk.HeadingPath, " / ")
		if key == "" {
			key = "Document"
		}
		seen[key] = struct{}{}
	}
	if len(seen) == 0 && len(chunks) > 0 {
		return 1
	}
	return len(seen)
}

func clipRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return strings.TrimSpace(string(runes[:limit])) + "…"
}

func firstPage(pages []int) int {
	if len(pages) == 0 {
		return 0
	}
	return pages[0]
}

func containsInt(values []int, target int) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func roundedRatio(part, total int) float64 {
	if total <= 0 {
		return 0
	}
	return math.Round((float64(part)/float64(total))*1000) / 1000
}
