package reader

import (
	"strings"
	"testing"
)

const testDocumentJSON = `{
  "schemaVersion":"enise-reader/v1",
  "artifactId":"artifact-1",
  "pipelineVersion":"docling-test",
  "title":"Cours de mécanique",
  "blocks":[
    {"id":"b-title","ordinal":1,"level":1,"type":"section_header","text":"Statique","selfRef":"#/texts/0","provenance":[{"page_no":1,"bbox":{"l":1,"t":9,"r":8,"b":2,"coord_origin":"BOTTOMLEFT"}}]},
    {"id":"b-force","ordinal":2,"level":1,"type":"text","text":"Une force possède une direction, un sens et une intensité.","selfRef":"#/texts/1","provenance":[{"page_no":1,"bbox":{"l":2,"t":8,"r":7,"b":3,"coord_origin":"BOTTOMLEFT"}}]},
    {"id":"b-energy-title","ordinal":3,"level":1,"type":"section_header","text":"Énergie","selfRef":"#/texts/2","provenance":[{"page_no":2}]},
    {"id":"b-energy","ordinal":4,"level":1,"type":"text","text":"L'énergie cinétique dépend de la masse et de la vitesse.","selfRef":"#/texts/3","provenance":[{"page_no":2}]}
  ]
}`

const testChunksJSONL = `{"id":"c-000001","text":"Une force possède une direction, un sens et une intensité.","meta":{"doc_items":[{"self_ref":"#/texts/1"}],"headings":["Statique"]}}
{"id":"c-000002","text":"L'énergie cinétique dépend de la masse et de la vitesse.","meta":{"doc_items":[{"self_ref":"#/texts/3"}],"headings":["Énergie"]}}
`

func TestNormalizeHybridChunksPreservesDoclingAnchors(t *testing.T) {
	document, err := Normalize("GM/cours.pdf", []byte(testDocumentJSON), []byte(testChunksJSONL))
	if err != nil {
		t.Fatal(err)
	}
	if document.ArtifactID != "artifact-1" || len(document.Chunks) != 2 {
		t.Fatalf("document = %#v", document)
	}
	chunk := document.Chunks[0]
	if len(chunk.BlockIDs) != 1 || chunk.BlockIDs[0] != "b-force" {
		t.Fatalf("blockIds = %#v", chunk.BlockIDs)
	}
	if len(chunk.Pages) != 1 || chunk.Pages[0] != 1 {
		t.Fatalf("pages = %#v", chunk.Pages)
	}
	if len(chunk.HeadingPath) != 1 || chunk.HeadingPath[0] != "Statique" {
		t.Fatalf("heading = %#v", chunk.HeadingPath)
	}
}

func TestNormalizeEnrichesChunkWithTableAndFigureCaption(t *testing.T) {
	documentJSON := `{
  "artifactId":"artifact-2",
  "pipelineVersion":"docling-test",
  "title":"Essai",
  "blocks":[
    {"id":"b-table","ordinal":1,"type":"table","text":"Résultats","selfRef":"#/tables/0","markdown":"| Force | 12 N |","caption":"Mesures de traction","provenance":[{"page_no":3}]},
    {"id":"b-figure","ordinal":2,"type":"picture","text":"","selfRef":"#/pictures/0","caption":"Montage expérimental","assetId":"figure-00002","provenance":[{"page_no":4}]}
  ]
}`
	chunks := `{"id":"c-1","text":"Résultats","blockIds":["b-table","b-figure"]}
`
	document, err := Normalize("GM/essai.pdf", []byte(documentJSON), []byte(chunks))
	if err != nil {
		t.Fatal(err)
	}
	text := document.Chunks[0].Text
	for _, expected := range []string{"| Force | 12 N |", "Mesures de traction", "Montage expérimental"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("chunk sans %q: %s", expected, text)
		}
	}
	if len(document.Chunks[0].Pages) != 2 || document.Chunks[0].Pages[0] != 3 || document.Chunks[0].Pages[1] != 4 {
		t.Fatalf("pages = %#v", document.Chunks[0].Pages)
	}
}

func TestRetrieveTargetsQuestionAndBuildsNavigableCitation(t *testing.T) {
	document, err := Normalize("GM/cours.pdf", []byte(testDocumentJSON), []byte(testChunksJSONL))
	if err != nil {
		t.Fatal(err)
	}
	result := Retrieve(document, Query{Text: "De quoi dépend l'énergie cinétique ?", MaxChunks: 1})
	if len(result.Evidence) != 1 {
		t.Fatalf("evidence = %#v", result.Evidence)
	}
	evidence := result.Evidence[0]
	if evidence.ChunkID != "c-000002" || evidence.CitationID != "S1" || evidence.Page != 2 {
		t.Fatalf("citation = %#v", evidence)
	}
	if !strings.Contains(evidence.Text, "vitesse") || result.Coverage.Kind != "targeted" {
		t.Fatalf("result = %#v", result)
	}
}

func TestSummarySamplesEverySectionWhenBudgetAllows(t *testing.T) {
	document, err := Normalize("GM/cours.pdf", []byte(testDocumentJSON), []byte(testChunksJSONL))
	if err != nil {
		t.Fatal(err)
	}
	result := Retrieve(document, Query{Text: "Résume tout le document", Intent: "summary", MaxChunks: 2})
	if len(result.Evidence) != 2 || result.Coverage.Kind != "whole-document" {
		t.Fatalf("summary = %#v", result)
	}
	if result.Coverage.SelectedSections != 2 || result.Coverage.TotalSections != 2 {
		t.Fatalf("coverage = %#v", result.Coverage)
	}
}

func TestNormalizeRebuildsUnmappableChunks(t *testing.T) {
	chunks := `{"id":"legacy","text":"métadonnées sans références","meta":{"unknown":true}}
`
	document, err := Normalize("GM/cours.pdf", []byte(testDocumentJSON), []byte(chunks))
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Chunks) == 0 || len(document.Chunks[0].BlockIDs) == 0 {
		t.Fatalf("chunks reconstruits = %#v", document.Chunks)
	}
}
