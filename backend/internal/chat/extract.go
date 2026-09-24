package chat

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"compress/zlib"
	"encoding/hex"
	"html"
	"io"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf16"
)

const (
	extractZipEntryLimit = 1 << 20
	extractZipTotalLimit = 4 << 20
	extractPDFLimit      = 8 << 20
	extractInflateLimit  = 2 << 20
)

// Readable dit si un extrait texte peut être tenté sans service externe.
func Readable(filePath, itemType string, size *int64, maxBytes int64) bool {
	if itemType != "file" || !readableExtension(filePath) {
		return false
	}
	return size == nil || *size <= maxBytes
}

// Extract lit un extrait court. Les formats inconnus et les binaires
// illisibles renvoient une chaîne vide, jamais une erreur fatale.
func Extract(filename string, data []byte, limit int) string {
	if limit <= 0 || len(data) == 0 {
		return ""
	}
	var text string
	switch extension(filename) {
	case "txt", "md", "csv", "tsv", "json", "log", "tex", "rst", "yaml", "yml":
		text = string(data)
	case "docx":
		text = extractZipXML(data, func(name string) bool {
			return name == "word/document.xml"
		})
	case "pptx":
		text = extractZipXML(data, func(name string) bool {
			return strings.HasPrefix(name, "ppt/slides/slide") && strings.HasSuffix(name, ".xml")
		})
	case "xlsx":
		text = extractZipXML(data, func(name string) bool {
			return name == "xl/sharedStrings.xml" || strings.HasPrefix(name, "xl/worksheets/")
		})
	case "pdf":
		text = extractPDF(data)
	default:
		return ""
	}
	text = Clip(cleanText(text), limit)
	if !readableText(text) {
		// Polices PDF encodées par glyphes : le texte extrait est du bruit.
		// Mieux vaut ne rien renvoyer que nourrir le modèle avec « ÿÿ A B D… ».
		return ""
	}
	return text
}

// readableText écarte les extractions qui ne sont pas du langage : une
// table de glyphes (« A B D I E N W P s V a à b d… »), des caractères de
// remplacement, ou un fatras de symboles. Un texte court mais propre est
// conservé.
func readableText(text string) bool {
	if strings.TrimSpace(text) == "" {
		return false
	}
	if strings.Contains(text, "\u00ff\u00ff") || strings.ContainsRune(text, '\ufffd') {
		return false
	}
	words := strings.Fields(text)
	if len(words) == 0 {
		return false
	}
	total := 0
	letters := 0
	single := 0
	long := 0
	run := 0
	longestRun := 0
	for _, word := range words {
		runes := []rune(word)
		total += len(runes)
		for _, r := range runes {
			if unicode.IsLetter(r) || unicode.IsDigit(r) {
				letters++
			}
		}
		if len(runes) == 1 {
			single++
			run++
			if run > longestRun {
				longestRun = run
			}
			continue
		}
		run = 0
		if len(runes) >= 4 {
			long++
		}
	}
	if total == 0 || letters*4 < total*3 {
		return false
	}
	// Une enfilade de lettres isolées est une table de glyphes, pas une phrase.
	if longestRun >= 8 {
		return false
	}
	if len(words) >= 10 && single*2 > len(words) && long*3 < len(words) {
		return false
	}
	return true
}

// Clip coupe un texte sur une limite de runes.
func Clip(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return strings.TrimSpace(string(runes[:limit])) + "…"
}

func cleanText(value string) string {
	var b strings.Builder
	space := false
	for _, r := range value {
		if r == '\n' || r == '\r' || r == '\t' || r == '\f' || r == '\v' {
			r = ' '
		}
		if r < 32 || r == 127 {
			continue
		}
		if unicode.IsSpace(r) {
			if space || b.Len() == 0 {
				continue
			}
			space = true
			b.WriteByte(' ')
			continue
		}
		space = false
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}

func extractZipXML(data []byte, match func(string) bool) string {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ""
	}
	var b strings.Builder
	total := 0
	for _, file := range reader.File {
		if file.FileInfo().IsDir() || !match(file.Name) || file.UncompressedSize64 > extractZipEntryLimit {
			continue
		}
		rc, err := file.Open()
		if err != nil {
			continue
		}
		payload, err := io.ReadAll(io.LimitReader(rc, extractZipEntryLimit))
		rc.Close()
		if err != nil || len(payload) == 0 {
			continue
		}
		b.WriteString(stripTags(string(payload)))
		b.WriteByte(' ')
		total += len(payload)
		if total >= extractZipTotalLimit {
			break
		}
	}
	return b.String()
}

func stripTags(raw string) string {
	var b strings.Builder
	inTag := false
	for _, r := range raw {
		switch {
		case r == '<':
			inTag = true
			b.WriteByte(' ')
		case r == '>':
			inTag = false
		case !inTag:
			b.WriteRune(r)
		}
	}
	return html.UnescapeString(b.String())
}

func extractPDF(data []byte) string {
	if len(data) > extractPDFLimit {
		data = data[:extractPDFLimit]
	}
	payloads := make([][]byte, 0, 8)
	rest := data
	for len(payloads) < 48 {
		idx := bytes.Index(rest, []byte("stream"))
		if idx < 0 {
			break
		}
		dictStart := idx - 700
		if dictStart < 0 {
			dictStart = 0
		}
		dict := rest[dictStart:idx]
		// Le dictionnaire de CE flux commence au dernier « obj » : la fenêtre
		// de 700 octets peut contenir la fin de l’objet précédent.
		if at := bytes.LastIndex(dict, []byte("obj")); at >= 0 {
			dict = dict[at:]
		}
		payloadStart := idx + len("stream")
		if payloadStart < len(rest) && (rest[payloadStart] == '\r' || rest[payloadStart] == '\n') {
			if rest[payloadStart] == '\r' && payloadStart+1 < len(rest) && rest[payloadStart+1] == '\n' {
				payloadStart += 2
			} else {
				payloadStart++
			}
		}
		end := bytes.Index(rest[payloadStart:], []byte("endstream"))
		if end < 0 {
			break
		}
		stream := bytes.TrimRight(rest[payloadStart:payloadStart+end], "\r\n")
		rest = rest[payloadStart+end+len("endstream"):]
		if len(stream) == 0 || bytes.Contains(dict, []byte("/Image")) || bytes.Contains(dict, []byte("DCTDecode")) || bytes.Contains(dict, []byte("JPXDecode")) || pdfNonContent(dict) {
			continue
		}
		if bytes.Contains(dict, []byte("FlateDecode")) {
			if inflated := inflatePDF(stream); len(inflated) > 0 {
				payloads = append(payloads, inflated)
			}
			continue
		}
		payloads = append(payloads, stream)
	}
	if len(payloads) == 0 {
		payloads = append(payloads, data)
	}
	var b strings.Builder
	for _, payload := range payloads {
		appendPDFText(&b, payload)
		if b.Len() > 20000 {
			break
		}
	}
	return b.String()
}

func inflatePDF(stream []byte) []byte {
	if len(stream) == 0 || len(stream) > extractZipTotalLimit {
		return nil
	}
	if out := inflateReader(func() (io.ReadCloser, error) {
		return zlib.NewReader(bytes.NewReader(stream))
	}); len(out) > 0 {
		return out
	}
	reader := flate.NewReader(bytes.NewReader(stream))
	defer reader.Close()
	out, err := io.ReadAll(io.LimitReader(reader, extractInflateLimit))
	if err != nil || len(out) == 0 {
		return nil
	}
	return out
}

func inflateReader(open func() (io.ReadCloser, error)) []byte {
	reader, err := open()
	if err != nil {
		return nil
	}
	defer reader.Close()
	out, err := io.ReadAll(io.LimitReader(reader, extractInflateLimit))
	if err != nil || len(out) == 0 {
		return nil
	}
	return out
}

// pdfFontStream repère les flux qui ne portent pas le texte des pages :
// polices embarquées, tables de références, flux d’objets, métadonnées XMP.
// Leurs chaînes (« Wingdings 3 », « Identity », « Adobe »…) polluaient
// l’extrait avant même le premier mot du cours.
var pdfFontStream = regexp.MustCompile(`/Length[123][\s/>]|/FontFile|/Subtype\s*/(Type1C|CIDFontType0C|OpenType|XML)|/Type\s*/(XRef|ObjStm|Metadata|EmbeddedFile)`)

func pdfNonContent(dict []byte) bool {
	return pdfFontStream.Match(dict)
}

// appendPDFText ne lit que le texte des pages : les chaînes placées entre
// BT et ET. Dans un tableau TJ, les morceaux d’un même mot sont recollés ;
// seul un grand décalage (≥ 250 millièmes) vaut une espace. L’ancienne
// lecture ajoutait une espace après chaque morceau : « économ ique ».
func appendPDFText(b *strings.Builder, data []byte) {
	inText := false
	inArray := false
	wrote := false
	sep := func() {
		if wrote {
			b.WriteByte(' ')
			wrote = false
		}
	}
	put := func(text string) {
		if text == "" {
			return
		}
		b.WriteString(text)
		wrote = true
	}
	for i := 0; i < len(data); i++ {
		c := data[i]
		switch {
		case c == '(':
			text, next := readPDFLiteral(data, i)
			if inText {
				put(text)
			}
			if next > i {
				i = next
			}
		case c == '<':
			if i+1 < len(data) && data[i+1] == '<' {
				i++
				continue
			}
			text, next := readPDFHex(data, i)
			if inText {
				put(text)
			}
			if next > i {
				i = next
			}
		case c == '[':
			if inText {
				inArray = true
			}
		case c == ']':
			inArray = false
		case inArray && (c == '-' || c == '.' || (c >= '0' && c <= '9')):
			j := i + 1
			for j < len(data) && (data[j] == '.' || (data[j] >= '0' && data[j] <= '9')) {
				j++
			}
			if value, err := strconv.ParseFloat(string(data[i:j]), 64); err == nil && value <= -250 {
				sep()
			}
			i = j - 1
		case pdfKeywordStart(c) && (i == 0 || pdfDelimiter(data[i-1])):
			j := i + 1
			if c != '\'' && c != '"' {
				for j < len(data) && pdfKeywordChar(data[j]) {
					j++
				}
			}
			if j < len(data) && !pdfDelimiter(data[j]) {
				i = j - 1
				continue
			}
			switch string(data[i:j]) {
			case "BT":
				inText = true
				sep()
			case "ET":
				inText = false
				inArray = false
				sep()
			case "Td", "TD", "T*", "Tm", "'", "\"":
				if inText {
					sep()
				}
			}
			i = j - 1
		}
	}
	sep()
}

func pdfKeywordStart(c byte) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '\'' || c == '"'
}

func pdfKeywordChar(c byte) bool {
	return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '*'
}

func pdfDelimiter(c byte) bool {
	switch c {
	case ' ', '\n', '\r', '\t', '\f', 0, '(', ')', '<', '>', '[', ']', '{', '}', '/', '%':
		return true
	}
	return false
}

func readPDFLiteral(data []byte, start int) (string, int) {
	var raw []byte
	depth := 1
	for i := start + 1; i < len(data); i++ {
		b := data[i]
		if b == '\\' && i+1 < len(data) {
			next := data[i+1]
			switch next {
			case 'n':
				raw = append(raw, '\n')
			case 'r':
				raw = append(raw, '\r')
			case 't':
				raw = append(raw, '\t')
			case 'b':
				raw = append(raw, '\b')
			case 'f':
				raw = append(raw, '\f')
			case '(', ')', '\\':
				raw = append(raw, next)
			case '\n':
			case '\r':
				if i+2 < len(data) && next == '\r' && data[i+2] == '\n' {
					i++
				}
			default:
				if next >= '0' && next <= '7' {
					value := int(next - '0')
					consumed := 1
					for consumed < 3 && i+1+consumed < len(data) {
						digit := data[i+1+consumed]
						if digit < '0' || digit > '7' {
							break
						}
						value = value*8 + int(digit-'0')
						consumed++
					}
					raw = append(raw, byte(value))
					i += consumed
					continue
				}
				raw = append(raw, next)
			}
			i++
			continue
		}
		if b == '(' {
			depth++
			raw = append(raw, b)
			continue
		}
		if b == ')' {
			depth--
			if depth == 0 {
				return decodePDFBytes(raw), i
			}
			raw = append(raw, b)
			continue
		}
		raw = append(raw, b)
	}
	return "", start
}

func readPDFHex(data []byte, start int) (string, int) {
	end := bytes.IndexByte(data[start+1:], '>')
	if end < 0 || end > 800 {
		return "", start
	}
	raw := data[start+1 : start+1+end]
	cleaned := make([]byte, 0, len(raw))
	for _, b := range raw {
		if b == ' ' || b == '\n' || b == '\r' || b == '\t' {
			continue
		}
		cleaned = append(cleaned, b)
	}
	if len(cleaned) < 2 || len(cleaned)%2 != 0 || !isHex(cleaned) {
		return "", start + 1 + end
	}
	decoded := make([]byte, len(cleaned)/2)
	if _, err := hex.Decode(decoded, cleaned); err != nil {
		return "", start + 1 + end
	}
	return decodePDFBytes(decoded), start + 1 + end
}

func isHex(data []byte) bool {
	for _, b := range data {
		switch {
		case b >= '0' && b <= '9', b >= 'a' && b <= 'f', b >= 'A' && b <= 'F':
		default:
			return false
		}
	}
	return true
}

func decodePDFBytes(data []byte) string {
	if len(data) == 0 || len(data) > 4000 {
		return ""
	}
	zeros := 0
	for _, b := range data {
		if b == 0 {
			zeros++
		}
	}
	var text string
	if (len(data) >= 2 && data[0] == 0xFE && data[1] == 0xFF) || zeros > len(data)/4 {
		text = utf16BE(data)
	} else {
		text = latin1(data)
	}
	if !mostlyText(text) {
		return ""
	}
	return text
}

// cp1252 couvre la plage 0x80–0x9F de WinAnsiEncoding, l’encodage des PDF
// produits par Word : sans elle, l’apostrophe typographique disparaît
// (« lanalyse », « dun ») et « œ » ou « … » deviennent des caractères de
// contrôle.
var cp1252 = map[byte]rune{
	0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
	0x88: 'ˆ', 0x89: '‰', 0x8A: 'Š', 0x8B: '‹', 0x8C: 'Œ', 0x8E: 'Ž',
	0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
	0x98: '˜', 0x99: '™', 0x9A: 'š', 0x9B: '›', 0x9C: 'œ', 0x9E: 'ž', 0x9F: 'Ÿ',
}

func latin1(data []byte) string {
	runes := make([]rune, len(data))
	for i, b := range data {
		if r, ok := cp1252[b]; ok {
			runes[i] = r
			continue
		}
		runes[i] = rune(b)
	}
	return string(runes)
}

func utf16BE(data []byte) string {
	if len(data) >= 2 && data[0] == 0xFE && data[1] == 0xFF {
		data = data[2:]
	}
	if len(data) < 2 {
		return ""
	}
	if len(data)%2 == 1 {
		data = data[:len(data)-1]
	}
	units := make([]uint16, len(data)/2)
	for i := range units {
		units[i] = uint16(data[i*2])<<8 | uint16(data[i*2+1])
	}
	return string(utf16.Decode(units))
}

func mostlyText(value string) bool {
	letters := 0
	printable := 0
	total := 0
	for _, r := range value {
		total++
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r):
			letters++
			printable++
		case unicode.IsSpace(r) || unicode.IsPunct(r) || r == '€' || r == '°':
			printable++
		}
	}
	// Morceaux courts d’un tableau TJ : une apostrophe ou une espace seule
	// fait partie du texte, la jeter recollait les mots (« dun »).
	if total <= 3 && printable == total {
		return true
	}
	return letters >= 2 && total > 0 && printable*4 >= total*3
}
