package api

import (
	"strings"
	"testing"

	"enise-docs/backend/internal/reader"
)

func TestReaderDocumentKindCoversPreconvertedFormats(t *testing.T) {
	cases := map[string]string{
		"GM/cours.pdf":      "pdf",
		"GM/support.docx":   "document",
		"GM/mesures.xlsx":   "spreadsheet",
		"GM/slides.pptx":    "presentation",
		"GM/annexe.epub":    "ebook",
		"GM/schema.tiff":    "image",
		"GM/transcript.vtt": "text",
		"GM/script.js":      "",
		"GM/archive.sldprt": "",
	}
	for sourcePath, expected := range cases {
		if value := readerDocumentKind(sourcePath); value != expected {
			t.Errorf("readerDocumentKind(%q) = %q, attendu %q", sourcePath, value, expected)
		}
	}
}

func TestReaderAssetsRejectTraversalAndActiveContent(t *testing.T) {
	if readerAssetTypes[".svg"] != "" || readerAssetTypes[".html"] != "" {
		t.Fatal("un format actif est autorisé comme illustration")
	}
	prefix := "reader/v1/documents/cours/artifact-1"
	value, err := artifactFile(prefix, "assets/figure-1.webp")
	if err != nil || value != prefix+"/assets/figure-1.webp" {
		t.Fatalf("asset valide = %q err=%v", value, err)
	}
	if _, err := artifactFile(prefix, "../../secret.webp"); err == nil {
		t.Fatal("traversée d’asset acceptée")
	}
}

func TestReaderBlockWindowIsBoundedAndCarriesDeclaredAsset(t *testing.T) {
	document := &reader.Document{
		Blocks: []reader.Block{
			{ID: "b-2", Ordinal: 2, Type: "picture", AssetID: "figure-1", Caption: "Montage"},
			{ID: "b-1", Ordinal: 1, Type: "text", Text: "Introduction"},
			{ID: "b-3", Ordinal: 3, Type: "text", Text: strings.Repeat("x", readerBlockTextMax+20)},
		},
		Assets: []reader.Asset{{ID: "figure-1", Kind: "figure", Path: "assets/figure-1.webp", Width: 640, Height: 480}},
	}
	blocks, next := readerBlockWindow(document, 1, 2)
	if len(blocks) != 2 || blocks[0].ID != "b-1" || blocks[1].ID != "b-2" || next != 3 {
		t.Fatalf("fenêtre = %#v next=%d", blocks, next)
	}
	if blocks[1].Asset == nil || blocks[1].Asset.ID != "figure-1" || blocks[1].Asset.Width != 640 {
		t.Fatalf("asset = %#v", blocks[1].Asset)
	}
	last, next := readerBlockWindow(document, next, 2)
	if len(last) != 1 || len([]rune(last[0].Text)) > readerBlockTextMax+1 || next != 0 {
		t.Fatalf("dernière fenêtre = %#v next=%d", last, next)
	}
}
