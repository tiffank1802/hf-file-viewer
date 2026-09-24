// Classement local des documents. Aucun appel réseau : la réponse peut
// afficher des cartes avant que le modèle NVIDIA ne commence à écrire.
package chat

import (
	"strings"
	"unicode"

	"enise-docs/backend/internal/catalog"
)

// Hit est un document déjà présent dans l’index, jamais un chemin inventé.
type Hit struct {
	Path    string `json:"path"`
	Type    string `json:"type"`
	Name    string `json:"name"`
	Size    *int64 `json:"size,omitempty"`
	Mtime   string `json:"mtime,omitempty"`
	Score   int    `json:"score"`
	Reason  string `json:"reason"`
	Excerpt string `json:"excerpt,omitempty"`
	Read    bool   `json:"read,omitempty"`
}

var stopwords = map[string]struct{}{
	"le": {}, "la": {}, "les": {}, "un": {}, "une": {}, "des": {}, "de": {}, "du": {},
	"et": {}, "ou": {}, "au": {}, "aux": {}, "en": {}, "pour": {}, "sur": {}, "dans": {},
	"avec": {}, "que": {}, "qui": {}, "quoi": {}, "comment": {}, "quel": {}, "quelle": {},
	"quels": {}, "quelles": {}, "mon": {}, "ma": {}, "mes": {}, "ton": {}, "ta": {},
	"tes": {}, "je": {}, "tu": {}, "il": {}, "elle": {}, "on": {}, "nous": {}, "vous": {},
	"ce": {}, "cet": {}, "cette": {}, "ces": {}, "est": {}, "sont": {}, "pas": {}, "ne": {},
	"plus": {}, "tres": {}, "moi": {}, "toi": {}, "stp": {}, "svp": {}, "peux": {},
	"peut": {}, "veux": {}, "voudrais": {}, "bonjour": {}, "salut": {}, "merci": {},
	"ouvre": {}, "ouvrir": {}, "trouve": {}, "trouver": {}, "cherche": {}, "chercher": {},
	"resume": {}, "resumer": {}, "recommande": {}, "recommander": {}, "besoin": {},
	"aide": {}, "document": {}, "documents": {}, "fichier": {}, "fichiers": {},
	"the": {}, "and": {}, "for": {}, "where": {}, "what": {}, "how": {},
	"sil": {}, "plait": {}, "please": {},
}

// Tokens extrait les mots utiles d’une question, sans accents.
func Tokens(query string) []string {
	folded := fold(query)
	var tokens []string
	seen := map[string]struct{}{}
	var current strings.Builder
	flush := func() {
		token := current.String()
		current.Reset()
		if token == "" {
			return
		}
		if _, skip := stopwords[token]; skip || len([]rune(token)) < 2 {
			return
		}
		if _, ok := seen[token]; ok {
			return
		}
		seen[token] = struct{}{}
		tokens = append(tokens, token)
	}
	for _, r := range folded {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			current.WriteRune(r)
			continue
		}
		flush()
	}
	flush()
	if len(tokens) > 12 {
		return tokens[:12]
	}
	return tokens
}

type scored struct {
	item      catalog.BucketItem
	score     int
	nameHit   bool
	folderHit bool
	inContext bool
	complete  bool
}

// Rank ordonne les documents de l’index. Un résultat qui contient tous les
// mots utiles est préféré à un résultat partiel.
func Rank(items []catalog.BucketItem, query, contextPath string, limit int) []Hit {
	tokens := Tokens(query)
	if len(tokens) == 0 || limit <= 0 {
		return nil
	}
	contextPath = strings.Trim(contextPath, "/")
	rows := make([]scored, 0, 32)
	anyComplete := false
	for _, item := range items {
		if item.Path == "" || (item.Type != "file" && item.Type != "directory") {
			continue
		}
		row, ok := scoreItem(item, tokens, contextPath)
		if !ok {
			continue
		}
		if row.complete {
			anyComplete = true
		}
		rows = append(rows, row)
	}
	if anyComplete {
		filtered := rows[:0]
		for _, candidate := range rows {
			if candidate.complete {
				filtered = append(filtered, candidate)
			}
		}
		rows = filtered
	}
	sortRows(rows)
	if len(rows) > limit {
		rows = rows[:limit]
	}
	hits := make([]Hit, 0, len(rows))
	for _, candidate := range rows {
		hits = append(hits, Hit{
			Path:   candidate.item.Path,
			Type:   candidate.item.Type,
			Name:   baseName(candidate.item.Path),
			Size:   candidate.item.Size,
			Mtime:  candidate.item.Mtime,
			Score:  candidate.score,
			Reason: reason(candidate.nameHit, candidate.folderHit, candidate.inContext),
		})
	}
	return hits
}

func scoreItem(item catalog.BucketItem, tokens []string, contextPath string) (scored, bool) {
	name := fold(baseName(item.Path))
	folder := fold(parentPath(item.Path))
	path := fold(item.Path)
	matched := 0
	score := 0
	nameHit := false
	folderHit := false
	for _, token := range tokens {
		hit := false
		if strings.Contains(name, token) {
			score += 28
			nameHit = true
			hit = true
		}
		if folder != "" && strings.Contains(folder, token) {
			score += 12
			folderHit = true
			hit = true
		}
		if strings.Contains(path, token) {
			score += 6
			hit = true
		}
		if hit {
			matched++
		}
	}
	if matched == 0 {
		return scored{}, false
	}
	inContext := contextPath != "" && (item.Path == contextPath || strings.HasPrefix(item.Path, contextPath+"/"))
	if inContext {
		score += 12
	}
	if item.Type == "file" && readableExtension(item.Path) {
		score += 3
	}
	return scored{
		item:      item,
		score:     score,
		nameHit:   nameHit,
		folderHit: folderHit,
		inContext: inContext,
		complete:  matched == len(tokens),
	}, true
}

func sortRows(rows []scored) {
	for i := 1; i < len(rows); i++ {
		current := rows[i]
		j := i
		for j > 0 && worse(rows[j-1], current) {
			rows[j] = rows[j-1]
			j--
		}
		rows[j] = current
	}
}

func worse(left, right scored) bool {
	if left.score != right.score {
		return left.score < right.score
	}
	return left.item.Path > right.item.Path
}

func reason(nameHit, folderHit, inContext bool) string {
	switch {
	case nameHit && inContext:
		return "Le nom correspond à ta recherche, dans le dossier ouvert."
	case nameHit:
		return "Le nom correspond à ta recherche."
	case folderHit && inContext:
		return "Le dossier correspond à ta recherche."
	case folderHit:
		return "Un dossier du chemin correspond à ta recherche."
	case inContext:
		return "Le chemin correspond à ta recherche, dans le dossier ouvert."
	default:
		return "Le chemin correspond à ta recherche."
	}
}

func fold(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var b strings.Builder
	b.Grow(len(value))
	for _, r := range value {
		switch r {
		case 'à', 'á', 'â', 'ä', 'ã', 'å':
			b.WriteByte('a')
		case 'è', 'é', 'ê', 'ë':
			b.WriteByte('e')
		case 'ì', 'í', 'î', 'ï':
			b.WriteByte('i')
		case 'ò', 'ó', 'ô', 'ö', 'õ':
			b.WriteByte('o')
		case 'ù', 'ú', 'û', 'ü':
			b.WriteByte('u')
		case 'ý', 'ÿ':
			b.WriteByte('y')
		case 'ç':
			b.WriteByte('c')
		case 'ñ':
			b.WriteByte('n')
		case 'œ':
			b.WriteString("oe")
		case 'æ':
			b.WriteString("ae")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func baseName(filePath string) string {
	if i := strings.LastIndex(filePath, "/"); i >= 0 {
		return filePath[i+1:]
	}
	return filePath
}

func parentPath(filePath string) string {
	if i := strings.LastIndex(filePath, "/"); i >= 0 {
		return filePath[:i]
	}
	return ""
}

func readableExtension(filePath string) bool {
	switch extension(filePath) {
	case "txt", "md", "csv", "tsv", "json", "log", "tex", "rst", "yaml", "yml", "docx", "pptx", "xlsx", "pdf":
		return true
	default:
		return false
	}
}

func extension(filePath string) string {
	name := baseName(filePath)
	i := strings.LastIndex(name, ".")
	if i < 0 || i == len(name)-1 {
		return ""
	}
	return strings.ToLower(name[i+1:])
}
