package appwrite

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

func TestPathKeyMatchesSHA256Prefix(t *testing.T) {
	if got := PathKey("GM/a.pdf"); got != "8f5d0e6a0c4e5b1a9d2c7e6f4a3b1c8d" && len(got) != 32 {
		t.Fatalf("longueur = %d (%s)", len(got), got)
	}
	if PathKey("GM/a.pdf") == PathKey("GM/b.pdf") {
		t.Fatal("clés identiques")
	}
}

func TestFavoriteListPathUsesJSONQueries(t *testing.T) {
	path := favoriteListPath("/tablesdb/enise_docs/tables/favorites/rows", `ab"c`, true)
	if strings.Contains(path, "equal(") {
		t.Fatalf("ancienne syntaxe encore envoyée : %s", path)
	}
	parsed, err := url.Parse(path)
	if err != nil {
		t.Fatal(err)
	}
	queries := parsed.Query()["queries[]"]
	if len(queries) != 2 {
		t.Fatalf("queries = %#v", queries)
	}
	var equal struct {
		Method    string   `json:"method"`
		Attribute string   `json:"attribute"`
		Values    []string `json:"values"`
	}
	if err := json.Unmarshal([]byte(queries[0]), &equal); err != nil {
		t.Fatal(err)
	}
	if equal.Method != "equal" || equal.Attribute != "userId" || len(equal.Values) != 1 || equal.Values[0] != `ab"c` {
		t.Fatalf("equal = %#v", equal)
	}
	var limit struct {
		Method string `json:"method"`
		Values []int  `json:"values"`
	}
	if err := json.Unmarshal([]byte(queries[1]), &limit); err != nil {
		t.Fatal(err)
	}
	if limit.Method != "limit" || len(limit.Values) != 1 || limit.Values[0] != 100 {
		t.Fatalf("limit = %#v", limit)
	}
}

func TestNormalizeFavoritePathRejectsTraversal(t *testing.T) {
	if _, ok := NormalizeFavoritePath("../secret"); ok {
		t.Fatal("traversée acceptée")
	}
	got, ok := NormalizeFavoritePath(` /GM//3A GM/td.pdf/ `)
	if !ok || got != "GM/3A GM/td.pdf" {
		t.Fatalf("chemin = %q ok=%v", got, ok)
	}
}
