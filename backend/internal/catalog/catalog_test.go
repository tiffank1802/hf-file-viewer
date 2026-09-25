package catalog

import (
	"net/url"
	"strings"
	"testing"
)

func TestBuildHfTreeURL(t *testing.T) {
	raw := BuildHfTreeURL("https://huggingface.co", "ktongue/ENISE-SITE", "GM/3A GM/S5/Mécanique", false)
	if !strings.Contains(raw, "/tree/GM%2F3A%20GM%2FS5%2FM%C3%A9canique?") {
		t.Fatalf("url = %s", raw)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Query().Get("recursive") != "false" {
		t.Fatalf("recursive = %s", parsed.Query().Get("recursive"))
	}

	recursive, err := url.Parse(BuildHfTreeURL("https://huggingface.co", "ktongue/ENISE-SITE", "", true))
	if err != nil {
		t.Fatal(err)
	}
	if recursive.Query().Get("recursive") != "true" || recursive.Query().Get("limit") != "1000" {
		t.Fatalf("query = %s", recursive.RawQuery)
	}
}

func TestBuildHfFileURL(t *testing.T) {
	got := BuildHfFileURL("https://huggingface.co", "ktongue/ENISE-SITE", "GM/4A GM/Cours & TD/épreuve.pdf")
	want := "https://huggingface.co/buckets/ktongue/ENISE-SITE/resolve/GM/4A%20GM/Cours%20%26%20TD/%C3%A9preuve.pdf?download=false"
	if got != want {
		t.Fatalf("got %s", got)
	}
}

func TestGetNextLink(t *testing.T) {
	next := GetNextLink(
		`</api/buckets/u/b/tree?cursor=abc>; rel="next", </api/buckets/u/b/tree?cursor=xyz>; rel="last"`,
		"https://huggingface.co/api/buckets/u/b/tree",
	)
	if next != "https://huggingface.co/api/buckets/u/b/tree?cursor=abc" {
		t.Fatalf("next = %s", next)
	}
}

func TestPaths(t *testing.T) {
	prefix, err := NormalizePrefix("/GM/3A GM/")
	if err != nil || prefix != "GM/3A GM" {
		t.Fatalf("prefix %q %v", prefix, err)
	}
	filePath, err := NormalizeFilePath("/GM/poly.pdf")
	if err != nil || filePath != "GM/poly.pdf" {
		t.Fatalf("file %q %v", filePath, err)
	}
	if _, err := NormalizeFilePath("../secret"); err == nil {
		t.Fatal("expected traversal rejection")
	}
	if _, err := NormalizeFilePath("a\x00b"); err == nil {
		t.Fatal("expected control character rejection")
	}
	if _, err := NormalizeFilePath(""); err == nil {
		t.Fatal("expected required path")
	}
}

// Certains dossiers du bucket se terminent par une espace
// (« 1) introduction to solidworks tutorials ») : l’élaguer ferait perdre le
// contenu du dossier, Hugging Face ne renvoyant alors que le dossier lui-même.
func TestPathsKeepTrailingSpaces(t *testing.T) {
	dossier := "GM/Tutos SolidWorks/SolidProfessor/1-CSWA/1) introduction to solidworks tutorials "
	prefix, err := NormalizePrefix(dossier)
	if err != nil || prefix != dossier {
		t.Fatalf("préfixe %q %v", prefix, err)
	}
	if got, err := NormalizePrefix("  "); err != nil || got != "" {
		t.Fatalf("préfixe vide %q %v", got, err)
	}
	if got, err := NormalizePrefix("/TOEIC/"); err != nil || got != "TOEIC" {
		t.Fatalf("préfixe simple %q %v", got, err)
	}

	filePath, err := NormalizeFilePath(dossier + "/Section 1 - Overview/welcome.pdf")
	if err != nil || filePath != dossier+"/Section 1 - Overview/welcome.pdf" {
		t.Fatalf("fichier %q %v", filePath, err)
	}
	if _, err := NormalizeFilePath("   "); err == nil {
		t.Fatal("un chemin uniquement composé d’espaces doit être refusé")
	}
}

func TestCountAndSelect(t *testing.T) {
	counts, total := CountFilesByDirectory([]BucketItem{
		{Type: "directory", Path: "GM"},
		{Type: "file", Path: "GM/3A GM/S5/poly.pdf"},
		{Type: "file", Path: "GM/3A GM/S6/td.pdf"},
		{Type: "file", Path: "GM/readme.md"},
		{Type: "file", Path: "TOEIC/audio.mp3"},
	}, "")
	if total != 4 || counts["GM"] != 3 || counts["GM/3A GM"] != 2 || counts["GM/3A GM/S5"] != 1 || counts["TOEIC"] != 1 {
		t.Fatalf("counts=%v total=%d", counts, total)
	}

	document := &IndexDocument{
		Counts:     map[string]int{"GM": 3, "GM/3A GM": 2, "GM/4A GM": 1, "TOEIC": 1},
		TotalFiles: 4,
	}
	rootCounts, rootTotal := SelectCountsForPrefix(document, "")
	if rootTotal != 4 || rootCounts["TOEIC"] != 1 {
		t.Fatalf("root %#v %d", rootCounts, rootTotal)
	}
	scoped, scopedTotal := SelectCountsForPrefix(document, "/GM/")
	if scopedTotal != 3 || scoped["GM/3A GM"] != 2 {
		t.Fatalf("scoped %#v %d", scoped, scopedTotal)
	}
	if _, ok := scoped["TOEIC"]; ok {
		t.Fatal("TOEIC should be excluded")
	}
	empty, emptyTotal := SelectCountsForPrefix(nil, "GM")
	if emptyTotal != 0 || len(empty) != 0 {
		t.Fatalf("empty %#v %d", empty, emptyTotal)
	}
}

func TestChildrenFromIndex(t *testing.T) {
	items := []BucketItem{
		{Type: "directory", Path: "GM"},
		{Type: "directory", Path: "GM/3A GM", Mtime: "2026-01-01"},
		{Type: "file", Path: "GM/3A GM/poly.pdf", Size: Int64Ptr(12)},
		{Type: "file", Path: "TOEIC/audio.mp3", Size: Int64Ptr(4)},
	}
	root := ChildrenFromIndex(items, "")
	if len(root) != 2 || root[0].Path != "GM" || root[1].Path != "TOEIC" || root[1].Type != "directory" {
		t.Fatalf("root %#v", root)
	}
	gm := ChildrenFromIndex(items, "GM")
	if len(gm) != 1 || gm[0].Path != "GM/3A GM" || gm[0].Mtime != "2026-01-01" {
		t.Fatalf("gm %#v", gm)
	}
}

func TestSolidworksPaths(t *testing.T) {
	if got := BuildSolidworksStepPath("GM/Tutos SolidWorks/piece.sldprt"); got != "derived/step/GM/Tutos SolidWorks/piece.step" {
		t.Fatalf("step %s", got)
	}
	if got := BuildSolidworksManifestPath("GM/Tutos SolidWorks/piece.sldprt"); got != "derived/step/GM/Tutos SolidWorks/piece.step.json" {
		t.Fatalf("manifest %s", got)
	}
	if got := BuildSolidworksOriginalStepPath("GM/Tutos SolidWorks/piece.sldprt"); got != "GM/Tutos SolidWorks/piece.step" {
		t.Fatalf("original %s", got)
	}
	if !IsSolidworksExtension("SLDASM") || IsSolidworksExtension("step") {
		t.Fatal("extension detection")
	}
	first := MakeSourceKey("GM/piece.sldprt", "123", "2026-09-09", "solidworks-step:")
	if first != MakeSourceKey("GM/piece.sldprt", "123", "2026-09-09", "solidworks-step:") {
		t.Fatal("unstable key")
	}
	if first == MakeSourceKey("GM/other.sldprt", "123", "2026-09-09", "solidworks-step:") {
		t.Fatal("key should change with path")
	}
}

func TestHashMatchesWorker(t *testing.T) {
	if got := HashIdentifier("GM/cours.docx|1024|2026-01-01"); got != "a6fa725ff139b2ab" {
		t.Fatalf("hash %s", got)
	}
	if got := HashIdentifier("pièce-😀"); got != "3176cb7cfc657200" {
		t.Fatalf("emoji hash %s", got)
	}
	office := MakeSourceKey("GM/cours.docx", "1024", "2026-01-01", "office-pdf:")
	if office != "a6fa725ff139b2ab14a3eeb0503e0054" {
		t.Fatalf("office key %s", office)
	}
	if len(MakeModel3DSourceKey("a", "1", "2", "standard")) != 32 {
		t.Fatal("model key length")
	}
}

func TestExtensionsAndAps(t *testing.T) {
	for _, extension := range []string{"doc", "DOCX", "odp"} {
		if !IsOfficeConvertible(extension) {
			t.Fatalf("%s should be convertible", extension)
		}
	}
	if IsOfficeConvertible("pdf") || IsOfficeConvertible("odb") {
		t.Fatal("unexpected convertible extension")
	}
	if !IsModelGLBExtension("STEP") || IsModelGLBExtension("sldprt") {
		t.Fatal("glb extensions")
	}
	if !IsModel3DQuality("STANDARD") || IsModel3DQuality("ultra") || IsModel3DQuality("") {
		t.Fatal("qualities")
	}
	if BuildApsObjectKey("GM/3D/maquette_du$batiment.rvt", "abc123") != "abc123-maquette_du_batiment.rvt" {
		t.Fatal(BuildApsObjectKey("GM/3D/maquette_du$batiment.rvt", "abc123"))
	}
	failure := DescribeApsFailure([]string{"The Version of the file: 2024 is not supported."}, "GM/3D/_1700mm_plank.SLDPRT")
	if !containsAll(failure, "n’est pas prise en charge", "SLDPRT", "STEP/IGES/OBJ/STL", "Autodesk") {
		t.Fatalf("failure %s", failure)
	}
}

func TestLinkSafetyAndMeta(t *testing.T) {
	blocked := []string{"localhost", "LOCALHOST.", "127.0.0.1", "10.4.2.1", "172.16.0.9", "172.31.255.1", "192.168.1.1", "169.254.169.254", "0.0.0.0", "::1", "[::1]", "intranet", "srv.local", "app.internal", "x.test", ""}
	for _, host := range blocked {
		if !IsBlockedLinkHost(host) {
			t.Fatalf("%q should be blocked", host)
		}
	}
	allowed := []string{"exemple.fr", "www.univ-lyon.fr", "ecole.sharepoint.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "192.167.1.1"}
	for _, host := range allowed {
		if IsBlockedLinkHost(host) {
			t.Fatalf("%q should be allowed", host)
		}
	}
	meta := ExtractLinkMeta(
		`<html><head><title>Titre brut &amp; co</title>`+
			`<meta name="description" content="Desc classique">`+
			`<meta property="og:title" content="Titre &lt;OG&gt;">`+
			`<meta property="og:description" content="Desc OG">`+
			`<meta property="og:image" content="/img/cover.png">`+
			`<meta property="og:site_name" content="Site démo">`+
			`<link rel="icon" href="https://cdn.exemple.fr/f.ico">`+
			`</head></html>`,
		"https://exemple.fr/page/a",
	)
	if meta.Title != "Titre <OG>" || meta.Description != "Desc OG" || meta.Image != "https://exemple.fr/img/cover.png" || meta.SiteName != "Site démo" || meta.Icon != "https://cdn.exemple.fr/f.ico" {
		t.Fatalf("%#v", meta)
	}
	fallback := ExtractLinkMeta("<title>Seul titre</title>", "https://exemple.fr/")
	if fallback.Title != "Seul titre" || fallback.Description != "" || fallback.Image != "" {
		t.Fatalf("fallback %#v", fallback)
	}
	unsafe := ExtractLinkMeta(`<meta property="og:image" content="javascript:alert(1)">`, "https://exemple.fr/")
	if unsafe.Image != "" {
		t.Fatalf("unsafe image %q", unsafe.Image)
	}
	if !IsAuthWallURL("https://login.microsoftonline.com/tenant/oauth2/authorize?x=1") || IsAuthWallURL("https://exemple.fr/") || IsAuthWallURL("pas une url") {
		t.Fatal("auth wall detection")
	}
}

func TestContentDisposition(t *testing.T) {
	got := ContentDisposition("GM/épreuve (1).pdf", true)
	want := "attachment; filename*=UTF-8''%C3%A9preuve%20%281%29.pdf"
	if got != want {
		t.Fatalf("got %s", got)
	}
}

func containsAll(value string, parts ...string) bool {
	for _, part := range parts {
		if !stringsContains(value, part) {
			return false
		}
	}
	return true
}

func stringsContains(value, part string) bool {
	return len(part) == 0 || (len(value) >= len(part) && (value == part || len(value) > 0 && containsFold(value, part)))
}

func containsFold(value, part string) bool {
	for i := 0; i+len(part) <= len(value); i++ {
		if value[i:i+len(part)] == part {
			return true
		}
	}
	return false
}
