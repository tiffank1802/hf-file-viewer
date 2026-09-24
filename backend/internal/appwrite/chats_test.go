package appwrite

import (
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

func TestChatQueryUsesJSON(t *testing.T) {
	path := queryPath("/tablesdb/enise_docs/tables/conversations/rows", []appwriteQuery{
		{Method: "equal", Attribute: "userId", Values: []any{"abc"}},
		{Method: "limit", Values: []any{30}},
	})
	if strings.Contains(path, "equal(") {
		t.Fatalf("ancienne syntaxe : %s", path)
	}
	parsed, err := url.Parse(path)
	if err != nil {
		t.Fatal(err)
	}
	raw := parsed.Query()["queries[]"]
	if len(raw) != 2 {
		t.Fatalf("queries = %#v", raw)
	}
	var equal struct {
		Method    string   `json:"method"`
		Attribute string   `json:"attribute"`
		Values    []string `json:"values"`
	}
	if err := json.Unmarshal([]byte(raw[0]), &equal); err != nil {
		t.Fatal(err)
	}
	if equal.Method != "equal" || equal.Attribute != "userId" || len(equal.Values) != 1 || equal.Values[0] != "abc" {
		t.Fatalf("equal = %#v", equal)
	}
}

func TestEncodeSourcesClipsAndDropsEmpty(t *testing.T) {
	raw := encodeSources([]ChatSource{{Path: "  GM/a.pdf  ", Name: "a.pdf", Type: "file"}, {Path: ""}})
	var sources []ChatSource
	if err := json.Unmarshal([]byte(raw), &sources); err != nil {
		t.Fatal(err)
	}
	if len(sources) != 1 || sources[0].Path != "GM/a.pdf" {
		t.Fatalf("sources = %#v", sources)
	}
}

func TestClipRunes(t *testing.T) {
	if got := clipRunes("ééé", 2); got != "éé" {
		t.Fatalf("clip = %q", got)
	}
}
