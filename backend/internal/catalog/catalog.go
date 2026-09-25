// Fonctions pures partagées avec le Worker : chemins, URLs Hugging Face,
// comptages et métadonnées de liens. Elles n’ouvrent aucune connexion.
package catalog

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	MaxPathLength          = 1500
	MaxIndexItems          = 50_000
	MaxTreePages           = 45
	SolidworksOutputPrefix = "derived/step"
)

// HTTPError est une erreur métier déjà traduite pour le client.
type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

func Error(status int, message string) *HTTPError {
	return &HTTPError{Status: status, Message: message}
}

// BucketItem est la forme compacte renvoyée par /api/tree et /api/index.
type BucketItem struct {
	Type       string `json:"type"`
	Path       string `json:"path"`
	Size       *int64 `json:"size,omitempty"`
	Mtime      string `json:"mtime,omitempty"`
	NumItems   *int   `json:"numItems,omitempty"`
	TotalFiles *int   `json:"totalFiles,omitempty"`
}

// IndexDocument est le catalogue récursif mis en cache.
type IndexDocument struct {
	BucketID   string         `json:"bucketId"`
	Items      []BucketItem   `json:"items"`
	Counts     map[string]int `json:"counts"`
	TotalFiles int            `json:"totalFiles"`
	Complete   bool           `json:"complete"`
	FetchedAt  string         `json:"fetchedAt"`
}

var bucketIDPattern = regexp.MustCompile(`^[\w.-]+/[\w.-]+$`)

func ValidBucketID(value string) bool {
	return bucketIDPattern.MatchString(value)
}

// NormalizePrefix nettoie un préfixe de dossier sans élaguer les espaces :
// elles peuvent faire partie du nom d’un dossier du bucket (« … tutorials » se
// termine par une espace). Un préfixe uniquement composé d’espaces vaut la
// racine.
func NormalizePrefix(value string) (string, error) {
	prefix := strings.Trim(value, "/")
	if strings.TrimSpace(prefix) == "" {
		prefix = ""
	}
	if err := validatePath(prefix, true); err != nil {
		return "", err
	}
	return prefix, nil
}

func NormalizeFilePath(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", Error(400, "Le chemin du document est obligatoire.")
	}
	// Les espaces internes ou finales appartiennent au nom du fichier.
	filePath := strings.TrimLeft(value, "/")
	if err := validatePath(filePath, false); err != nil {
		return "", err
	}
	return filePath, nil
}

func validatePath(value string, allowEmpty bool) error {
	if !allowEmpty && value == "" {
		return Error(400, "Chemin de document invalide.")
	}
	if jsLength(value) > MaxPathLength || hasControlCharacter(value) {
		return Error(400, "Chemin de document invalide.")
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == ".." {
			return Error(400, "Chemin de document invalide.")
		}
	}
	return nil
}

func jsLength(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func hasControlCharacter(value string) bool {
	for _, r := range value {
		if r < 32 || r == 127 {
			return true
		}
	}
	return false
}

func Extension(filePath string) string {
	name := filePath
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	i := strings.LastIndex(name, ".")
	if i < 0 || i == len(name)-1 {
		return ""
	}
	return strings.ToLower(name[i+1:])
}

func EncodeBucketID(bucketID string) string {
	parts := strings.Split(bucketID, "/")
	for i, part := range parts {
		parts[i] = encodeURIComponent(part)
	}
	return strings.Join(parts, "/")
}

// BuildHfTreeURL reproduit l’encodage du Worker : le préfixe entier est
// passé dans un seul segment percent-encoded (les « / » deviennent %2F).
func BuildHfTreeURL(origin, bucketID, prefix string, recursive bool) string {
	path := strings.TrimRight(origin, "/") + "/api/buckets/" + EncodeBucketID(bucketID) + "/tree"
	if prefix != "" {
		path += "/" + encodeURIComponent(prefix)
	}
	query := url.Values{}
	query.Set("recursive", strconv.FormatBool(recursive))
	if recursive {
		query.Set("limit", "1000")
	}
	return path + "?" + query.Encode()
}

func BuildHfFileURL(origin, bucketID, filePath string) string {
	segments := strings.Split(filePath, "/")
	for i, segment := range segments {
		segments[i] = encodeURIComponent(segment)
	}
	return strings.TrimRight(origin, "/") + "/buckets/" + EncodeBucketID(bucketID) + "/resolve/" + strings.Join(segments, "/") + "?download=false"
}

var nextLinkPattern = regexp.MustCompile(`(?i)<([^>]+)>\s*;\s*rel=(?:"next"|next)`)

func GetNextLink(linkHeader, currentURL string) string {
	if linkHeader == "" {
		return ""
	}
	base, err := url.Parse(currentURL)
	if err != nil {
		return ""
	}
	for _, part := range strings.Split(linkHeader, ",") {
		match := nextLinkPattern.FindStringSubmatch(part)
		if match == nil {
			continue
		}
		next, err := url.Parse(match[1])
		if err != nil {
			continue
		}
		return base.ResolveReference(next).String()
	}
	return ""
}

func CountFilesByDirectory(items []BucketItem, prefix string) (map[string]int, int) {
	base := strings.Trim(prefix, "/")
	counts := map[string]int{}
	total := 0
	for _, item := range items {
		if item.Type == "directory" {
			continue
		}
		path := strings.TrimLeft(item.Path, "/")
		if path == "" {
			continue
		}
		if base != "" && path != base && !strings.HasPrefix(path, base+"/") {
			continue
		}
		total++
		parts := splitPath(path)
		for index := 1; index < len(parts); index++ {
			dirPath := strings.Join(parts[:index], "/")
			// Même filtre que le Worker : un préfixe non vide exclut le
			// dossier racine de la portée (les effectifs servis viennent
			// ensuite de selectCounts, pas de ce filtre).
			if base != "" && (dirPath == base || !strings.HasPrefix(dirPath, base+"/")) {
				continue
			}
			counts[dirPath]++
		}
	}
	return counts, total
}

// SelectCountsForPrefix extrait les effectifs déjà calculés. Il ne reparcourt
// pas les fichiers : c’est le même contrat que le Worker.
func SelectCountsForPrefix(document *IndexDocument, prefix string) (map[string]int, int) {
	base := strings.Trim(prefix, "/")
	source := map[string]int{}
	if document != nil && document.Counts != nil {
		source = document.Counts
	}
	if base == "" {
		counts := map[string]int{}
		for path, value := range source {
			counts[path] = value
		}
		total := 0
		if document != nil {
			total = document.TotalFiles
		}
		return counts, total
	}
	counts := map[string]int{}
	for path, value := range source {
		if path == base || strings.HasPrefix(path, base+"/") {
			counts[path] = value
		}
	}
	return counts, source[base]
}

// ChildrenFromIndex reconstruit le contenu immédiat d’un dossier à partir de
// l’index récursif. Évite un aller-retour Hugging Face à chaque navigation.
func ChildrenFromIndex(items []BucketItem, prefix string) []BucketItem {
	prefix = strings.Trim(prefix, "/")
	byPath := map[string]BucketItem{}
	order := make([]string, 0)
	put := func(item BucketItem, synthetic bool) {
		if item.Path == "" {
			return
		}
		if prev, ok := byPath[item.Path]; ok {
			if synthetic {
				return
			}
			if prev.Mtime == "" && item.Mtime != "" {
				byPath[item.Path] = item
			}
			return
		}
		byPath[item.Path] = item
		order = append(order, item.Path)
	}
	for _, item := range items {
		rel, ok := relativePath(item.Path, prefix)
		if !ok || rel == "" {
			continue
		}
		head, rest, nested := strings.Cut(rel, "/")
		childPath := head
		if prefix != "" {
			childPath = prefix + "/" + head
		}
		if !nested || rest == "" {
			copied := item
			copied.Path = strings.TrimLeft(item.Path, "/")
			put(copied, false)
			continue
		}
		put(BucketItem{Type: "directory", Path: childPath}, true)
	}
	out := make([]BucketItem, 0, len(order))
	for _, path := range order {
		out = append(out, byPath[path])
	}
	sortItems(out)
	return out
}

func relativePath(path, prefix string) (string, bool) {
	path = strings.Trim(path, "/")
	if prefix == "" {
		return path, path != ""
	}
	if path == prefix {
		return "", false
	}
	if strings.HasPrefix(path, prefix+"/") {
		return strings.TrimPrefix(path, prefix+"/"), true
	}
	return "", false
}

func sortItems(items []BucketItem) {
	// Tri stable et déterministe. L’interface retrie ensuite en français.
	for i := 1; i < len(items); i++ {
		item := items[i]
		j := i
		for j > 0 && itemLess(item, items[j-1]) {
			items[j] = items[j-1]
			j--
		}
		items[j] = item
	}
}

func itemLess(a, b BucketItem) bool {
	aDir := a.Type == "directory"
	bDir := b.Type == "directory"
	if aDir != bDir {
		return aDir
	}
	return a.Path < b.Path
}

func splitPath(path string) []string {
	if path == "" {
		return nil
	}
	parts := strings.Split(path, "/")
	out := parts[:0]
	for _, part := range parts {
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func Int64Ptr(value int64) *int64 { return &value }

func CompactItem(item BucketItem) BucketItem {
	compact := BucketItem{
		Type: "file",
		Path: item.Path,
	}
	if item.Type == "directory" {
		compact.Type = "directory"
	}
	if item.Size != nil {
		compact.Size = item.Size
	}
	if item.Mtime != "" {
		compact.Mtime = item.Mtime
	}
	if item.NumItems != nil {
		compact.NumItems = item.NumItems
	}
	if item.TotalFiles != nil {
		compact.TotalFiles = item.TotalFiles
	}
	return compact
}

// HashIdentifier reprend le mélange 32 bits du Worker (Math.imul), y compris
// l’itération UTF-16, pour que les clés de conversion restent identiques.
func HashIdentifier(value string) string {
	// Variables, pas des constantes : la conversion uint32 → int32 doit
	// tronquer comme Math.imul, sans être rejetée à la compilation.
	first := uint32(0x811c9dc5)
	second := uint32(0x9e3779b9)
	mulA := uint32(0x01000193)
	mulB := uint32(0x85ebca6b)
	for _, code := range utf16.Encode([]rune(value)) {
		unit := uint32(code)
		first = uint32(int32(first^unit) * int32(mulA))
		second = uint32(int32(second^unit) * int32(mulB))
	}
	return fmt.Sprintf("%08x%08x", first, second)
}

func MakeSourceKey(filePath, size, mtime, salt string) string {
	source := filePath + "|" + size + "|" + mtime
	sum := HashIdentifier(source) + HashIdentifier(salt+source)
	if len(sum) > 32 {
		return sum[:32]
	}
	return sum
}

func MakeModel3DSourceKey(filePath, size, mtime, quality string) string {
	source := filePath + "|" + size + "|" + mtime + "|" + quality
	sum := HashIdentifier(source) + HashIdentifier("model3d:"+source)
	if len(sum) > 32 {
		return sum[:32]
	}
	return sum
}

var (
	officeExtensions = setOf(
		"doc", "docx", "docm", "xls", "xlsx", "xlsm", "ppt", "pptx", "pptm", "odt", "ods", "odp",
	)
	model3DExtensions = setOf("step", "stp", "iges", "igs", "stl", "obj")
	model3DQualities  = setOf("draft", "standard", "fine")
	solidworksExt     = setOf("sldprt", "sldasm")
)

func setOf(values ...string) map[string]struct{} {
	out := make(map[string]struct{}, len(values))
	for _, value := range values {
		out[value] = struct{}{}
	}
	return out
}

func IsOfficeConvertible(extension string) bool {
	_, ok := officeExtensions[strings.ToLower(extension)]
	return ok
}

func IsModelGLBExtension(extension string) bool {
	_, ok := model3DExtensions[strings.ToLower(extension)]
	return ok
}

func IsModel3DQuality(value string) bool {
	_, ok := model3DQualities[strings.ToLower(value)]
	return ok
}

func IsSolidworksExtension(extension string) bool {
	_, ok := solidworksExt[strings.ToLower(extension)]
	return ok
}

func ReplaceExtension(filePath, next string) string {
	parts := strings.Split(filePath, "/")
	filename := "model"
	if len(parts) > 0 && parts[len(parts)-1] != "" {
		filename = parts[len(parts)-1]
	}
	stem := filename
	if i := strings.LastIndex(filename, "."); i > 0 {
		stem = filename[:i]
	}
	if stem == "" {
		stem = "model"
	}
	dir := ""
	if len(parts) > 1 {
		dir = strings.Join(parts[:len(parts)-1], "/") + "/"
	}
	return dir + stem + next
}

func BuildSolidworksStepPath(filePath string) string {
	return SolidworksOutputPrefix + "/" + ReplaceExtension(filePath, ".step")
}

func BuildSolidworksManifestPath(filePath string) string {
	return BuildSolidworksStepPath(filePath) + ".json"
}

func BuildSolidworksOriginalStepPath(filePath string) string {
	return ReplaceExtension(filePath, ".step")
}

func BuildSolidworksOriginalManifestPath(filePath string) string {
	return BuildSolidworksOriginalStepPath(filePath) + ".json"
}

func ContentDisposition(filePath string, download bool) string {
	filename := filePath
	if i := strings.LastIndex(filename, "/"); i >= 0 {
		filename = filename[i+1:]
	}
	if filename == "" {
		filename = "document"
	}
	encoded := encodeURIComponent(filename)
	encoded = strings.NewReplacer(
		"!", "%21",
		"'", "%27",
		"(", "%28",
		")", "%29",
		"*", "%2A",
	).Replace(encoded)
	kind := "inline"
	if download {
		kind = "attachment"
	}
	return kind + "; filename*=UTF-8''" + encoded
}

func encodeURIComponent(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	for _, r := range value {
		if isURIUnreserved(r) {
			b.WriteRune(r)
			continue
		}
		var buf [utf8.UTFMax]byte
		n := utf8.EncodeRune(buf[:], r)
		for i := 0; i < n; i++ {
			fmt.Fprintf(&b, "%%%02X", buf[i])
		}
	}
	return b.String()
}

func isURIUnreserved(r rune) bool {
	switch {
	case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		return true
	case r == '-' || r == '_' || r == '.' || r == '!' || r == '~' || r == '*' || r == '\'' || r == '(' || r == ')':
		return true
	default:
		return false
	}
}

func DecodeFilePathSuffix(suffix string) (string, error) {
	decoded, err := url.PathUnescape(suffix)
	if err != nil {
		return "", Error(400, "Le chemin du document est invalide.")
	}
	return decoded, nil
}

func NormalizeNumericParam(value string) string {
	if value == "" {
		return ""
	}
	number, err := strconv.ParseFloat(value, 64)
	if err != nil || number < 0 {
		return ""
	}
	return strconv.FormatInt(int64(number), 10)
}

func PositiveInt(value string, fallback int) int {
	number, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || number <= 0 {
		return fallback
	}
	return number
}

func TrimTrailingSlashes(value string) string {
	return strings.TrimRight(strings.TrimSpace(value), "/")
}

var authWallHosts = map[string]struct{}{
	"login.microsoftonline.com": {},
	"login.live.com":            {},
	"account.live.com":          {},
	"account.microsoft.com":     {},
}

func IsAuthWallURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Hostname() == "" {
		return false
	}
	_, ok := authWallHosts[strings.ToLower(parsed.Hostname())]
	return ok
}

func IsBlockedLinkHost(hostname string) bool {
	host := strings.TrimRight(strings.ToLower(strings.TrimSpace(hostname)), ".")
	if host == "" || host == "localhost" || host == "::1" || host == "[::1]" {
		return true
	}
	switch host {
	case "local", "internal", "invalid", "test", "example":
		return true
	}
	for _, suffix := range []string{".local", ".localhost", ".internal", ".invalid", ".test", ".example"} {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}
	if parts := strings.Split(host, "."); len(parts) == 4 && isIPv4(parts) {
		a, _ := strconv.Atoi(parts[0])
		b, _ := strconv.Atoi(parts[1])
		if a > 255 || b > 255 || octet(parts[2]) > 255 || octet(parts[3]) > 255 {
			return true
		}
		if a == 0 || a == 10 || a == 127 || a >= 224 {
			return true
		}
		if a == 172 && b >= 16 && b <= 31 {
			return true
		}
		if a == 192 && b == 168 {
			return true
		}
		if a == 169 && b == 254 {
			return true
		}
		return false
	}
	if strings.Contains(host, ":") || !strings.Contains(host, ".") {
		return true
	}
	return false
}

func isIPv4(parts []string) bool {
	if len(parts) != 4 {
		return false
	}
	for _, part := range parts {
		if part == "" || len(part) > 3 {
			return false
		}
		for _, r := range part {
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
}

func octet(value string) int {
	number, _ := strconv.Atoi(value)
	return number
}

func BuildApsObjectKey(filePath, sourceKey string) string {
	filename := filePath
	if i := strings.LastIndex(filename, "/"); i >= 0 {
		filename = filename[i+1:]
	}
	if filename == "" {
		filename = "document"
	}
	var b strings.Builder
	for _, r := range filename {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
			b.WriteRune(r)
			continue
		}
		b.WriteByte('_')
	}
	safe := b.String()
	if len(safe) > 120 {
		safe = safe[:120]
	}
	if safe == "" {
		safe = "document"
	}
	return sourceKey + "-" + safe
}

func NormalizeApsStatus(status string) string {
	switch strings.ToLower(status) {
	case "success", "complete":
		return "success"
	case "failed", "timeout", "canceled", "cancelled":
		return "failed"
	default:
		return "inprogress"
	}
}

func DescribeApsFailure(messages []string, filePath string) string {
	raw := strings.Join(filterNonEmpty(messages), " · ")
	if raw == "" {
		raw = "La conversion 3D a échoué."
	}
	if !unsupportedVersionPattern.MatchString(raw) {
		return raw
	}
	extension := strings.ToUpper(Extension(filePath))
	if extension == "" {
		extension = "3D"
	}
	return "La version du fichier " + extension + " n’est pas prise en charge par le convertisseur Autodesk. " +
		"Exportez le modèle en STEP/IGES/OBJ/STL puis réessayez, ou téléchargez le fichier pour l’ouvrir dans son application d’origine. " +
		"(Autodesk : " + raw + ")"
}

var unsupportedVersionPattern = regexp.MustCompile(`(?i)version of the file.{0,30}not supported|not supported|unsupported`)

func filterNonEmpty(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}

func ClampProgress(value any, fallback int) int {
	number, ok := progressNumber(value)
	if !ok {
		return fallback
	}
	rounded := int(number + 0.5)
	if number < 0 {
		rounded = int(number - 0.5)
	}
	if rounded < 0 {
		return 0
	}
	if rounded > 100 {
		return 100
	}
	return rounded
}

func progressNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	case string:
		text := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(typed), "%"))
		number, err := strconv.ParseFloat(text, 64)
		return number, err == nil
	default:
		return 0, false
	}
}

var (
	metaTagPattern  = regexp.MustCompile(`(?i)<meta\s+[^>]*>`)
	linkTagPattern  = regexp.MustCompile(`(?i)<link\s+[^>]*>`)
	titleTagPattern = regexp.MustCompile(`(?i)<title[^>]*>([^<]{1,500})</title\s*>`)
	attrPatterns    = map[string]*regexp.Regexp{}
)

func htmlAttribute(tag, name string) string {
	pattern := attrPatterns[name]
	if pattern == nil {
		pattern = regexp.MustCompile(`(?i)` + regexp.QuoteMeta(name) + `\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`)
		attrPatterns[name] = pattern
	}
	match := pattern.FindStringSubmatch(tag)
	if match == nil {
		return ""
	}
	for _, group := range match[1:] {
		if group != "" {
			return strings.TrimSpace(group)
		}
	}
	return ""
}

// LinkMeta est le résumé Open Graph renvoyé par /api/link/preview.
type LinkMeta struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Image       string `json:"image"`
	SiteName    string `json:"siteName"`
	Icon        string `json:"icon"`
}

func ExtractLinkMeta(html, baseURL string) LinkMeta {
	var meta LinkMeta
	if match := titleTagPattern.FindStringSubmatch(html); match != nil {
		meta.Title = cleanMeta(match[1], 200)
	}
	for _, tag := range metaTagPattern.FindAllString(html, -1) {
		key := strings.ToLower(htmlAttribute(tag, "property"))
		if key == "" {
			key = strings.ToLower(htmlAttribute(tag, "name"))
		}
		content := htmlAttribute(tag, "content")
		if key == "" || content == "" {
			continue
		}
		switch key {
		case "og:title":
			meta.Title = cleanMeta(content, 200)
		case "og:description":
			meta.Description = cleanMeta(content, 500)
		case "description":
			if meta.Description == "" {
				meta.Description = cleanMeta(content, 500)
			}
		case "og:image":
			if meta.Image == "" {
				meta.Image = content
			}
		case "og:site_name":
			if meta.SiteName == "" {
				meta.SiteName = cleanMeta(content, 120)
			}
		}
	}
	var icon string
	var iconIsGeneric bool
	for _, tag := range linkTagPattern.FindAllString(html, -1) {
		rel := strings.ToLower(htmlAttribute(tag, "rel"))
		tokens := strings.Fields(rel)
		if !hasToken(tokens, "icon") && !hasToken(tokens, "apple-touch-icon") {
			continue
		}
		href := htmlAttribute(tag, "href")
		if href == "" {
			continue
		}
		icon = href
		iconIsGeneric = hasToken(tokens, "icon")
		if iconIsGeneric {
			break
		}
	}
	if meta.Image != "" {
		meta.Image = resolveLinkURL(meta.Image, baseURL)
	}
	if icon != "" {
		meta.Icon = resolveLinkURL(icon, baseURL)
	}
	return meta
}

func hasToken(tokens []string, want string) bool {
	for _, token := range tokens {
		if token == want {
			return true
		}
	}
	return false
}

func cleanMeta(value string, max int) string {
	value = decodeHTMLEntities(value)
	value = strings.Join(strings.Fields(value), " ")
	if jsLength(value) <= max {
		return value
	}
	units := utf16.Encode([]rune(value))
	if len(units) > max {
		units = units[:max]
	}
	return string(utf16.Decode(units))
}

func resolveLinkURL(value, baseURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil {
		return ""
	}
	if baseURL != "" {
		base, err := url.Parse(baseURL)
		if err != nil {
			return ""
		}
		parsed = base.ResolveReference(parsed)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	return parsed.String()
}

var (
	namedEntityPattern = regexp.MustCompile(`(?i)&(?:lt|gt|quot);`)
	decEntityPattern   = regexp.MustCompile(`&#(\d{1,6});`)
	hexEntityPattern   = regexp.MustCompile(`(?i)&#x([0-9a-f]{1,6});`)
	aposEntityPattern  = regexp.MustCompile(`(?i)&#0*39;|&#x27;|&apos;`)
	ampEntityPattern   = regexp.MustCompile(`(?i)&amp;`)
)

func decodeHTMLEntities(value string) string {
	// Même ordre que le Worker : les noms d’abord, &amp; tout à la fin,
	// pour ne pas transformer « &amp;lt; » en « < ».
	value = strings.NewReplacer(
		"&lt;", "<", "&LT;", "<", "&Lt;", "<", "&lT;", "<",
		"&gt;", ">", "&GT;", ">", "&Gt;", ">", "&gT;", ">",
		"&quot;", `"`, "&QUOT;", `"`,
	).Replace(value)
	value = namedEntityPattern.ReplaceAllStringFunc(value, func(entity string) string {
		switch strings.ToLower(entity) {
		case "&lt;":
			return "<"
		case "&gt;":
			return ">"
		case "&quot;":
			return `"`
		default:
			return entity
		}
	})
	value = aposEntityPattern.ReplaceAllString(value, "'")
	value = decEntityPattern.ReplaceAllStringFunc(value, replaceDecimalEntity)
	value = hexEntityPattern.ReplaceAllStringFunc(value, replaceHexEntity)
	return ampEntityPattern.ReplaceAllString(value, "&")
}

func replaceDecimalEntity(entity string) string {
	match := decEntityPattern.FindStringSubmatch(entity)
	if match == nil {
		return entity
	}
	point, err := strconv.Atoi(match[1])
	if err != nil || point <= 0 || point > 0x10FFFF {
		return entity
	}
	return string(rune(point))
}

func replaceHexEntity(entity string) string {
	match := hexEntityPattern.FindStringSubmatch(entity)
	if match == nil {
		return entity
	}
	point, err := strconv.ParseInt(match[1], 16, 32)
	if err != nil || point <= 0 || point > 0x10FFFF {
		return entity
	}
	return string(rune(point))
}
