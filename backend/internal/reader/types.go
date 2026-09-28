// Package reader transforme les artefacts Docling immuables en contexte
// documentaire navigable pour le lecteur et l'assistant d'étude.
package reader

import "encoding/json"

const SchemaVersion = "enise-reader/v1"

// Catalog est reader/v1/catalog.json dans le bucket dérivé.
type Catalog struct {
	SchemaVersion string                  `json:"schemaVersion"`
	DerivedBucket string                  `json:"derivedBucket"`
	Documents     map[string]CatalogEntry `json:"documents"`
}

// CatalogEntry pointe vers une révision immuable d'un document source.
type CatalogEntry struct {
	SourcePath      string `json:"sourcePath"`
	SourceSignature string `json:"sourceSignature"`
	SourcePresent   bool   `json:"sourcePresent"`
	PipelineVersion string `json:"pipelineVersion"`
	ArtifactID      string `json:"artifactId"`
	ArtifactPrefix  string `json:"artifactPrefix"`
	ManifestPath    string `json:"manifestPath"`
	Status          string `json:"status"`
	LastError       string `json:"lastError"`
	BlockCount      int    `json:"blockCount"`
	ChunkCount      int    `json:"chunkCount"`
	AssetCount      int    `json:"assetCount"`
}

// Manifest est la barrière de publication : seul status=ready est lisible.
type Manifest struct {
	SchemaVersion   string            `json:"schemaVersion"`
	SourcePath      string            `json:"sourcePath"`
	ArtifactID      string            `json:"artifactId"`
	ArtifactPrefix  string            `json:"artifactPrefix"`
	PipelineVersion string            `json:"pipelineVersion"`
	Status          string            `json:"status"`
	Files           map[string]string `json:"files"`
}

// RawDocument correspond à document.json produit par reader_pipeline.py.
type RawDocument struct {
	SchemaVersion   string     `json:"schemaVersion"`
	ArtifactID      string     `json:"artifactId"`
	PipelineVersion string     `json:"pipelineVersion"`
	Title           string     `json:"title"`
	Blocks          []RawBlock `json:"blocks"`
	Assets          []RawAsset `json:"assets"`
}

type RawBlock struct {
	ID         string       `json:"id"`
	Ordinal    int          `json:"ordinal"`
	Level      int          `json:"level"`
	Type       string       `json:"type"`
	Text       string       `json:"text"`
	SelfRef    string       `json:"selfRef"`
	ParentRef  string       `json:"parentRef"`
	Caption    string       `json:"caption"`
	Markdown   string       `json:"markdown"`
	AssetID    string       `json:"assetId"`
	Provenance []Provenance `json:"provenance"`
}

type RawAsset struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Path    string `json:"path"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	BlockID string `json:"blockId"`
	Caption string `json:"caption"`
}

type Provenance struct {
	PageNo int   `json:"page_no"`
	BBox   *BBox `json:"bbox,omitempty"`
}

// BBox est normalisée dans le même repère que la provenance Docling.
type BBox struct {
	L      float64 `json:"l"`
	T      float64 `json:"t"`
	R      float64 `json:"r"`
	B      float64 `json:"b"`
	Origin string  `json:"origin,omitempty"`
}

func (b *BBox) UnmarshalJSON(payload []byte) error {
	type wire struct {
		L           float64 `json:"l"`
		T           float64 `json:"t"`
		R           float64 `json:"r"`
		B           float64 `json:"b"`
		Origin      string  `json:"origin"`
		CoordOrigin string  `json:"coord_origin"`
	}
	var value wire
	if err := json.Unmarshal(payload, &value); err != nil {
		return err
	}
	b.L, b.T, b.R, b.B = value.L, value.T, value.R, value.B
	b.Origin = value.Origin
	if b.Origin == "" {
		b.Origin = value.CoordOrigin
	}
	return nil
}

// RawChunk accepte les deux sorties du pipeline : blockIds déterministes ou
// meta du HybridChunker.
type RawChunk struct {
	ID       string          `json:"id"`
	Text     string          `json:"text"`
	BlockIDs []string        `json:"blockIds"`
	Meta     json.RawMessage `json:"meta"`
}

// Document est la représentation normalisée utilisée par la recherche.
type Document struct {
	SourcePath      string
	ArtifactID      string
	PipelineVersion string
	Title           string
	Blocks          []Block
	Assets          []Asset
	Chunks          []Chunk
	Outline         []string
}

type Block struct {
	ID          string
	Ordinal     int
	Level       int
	Type        string
	Text        string
	SelfRef     string
	Caption     string
	Markdown    string
	AssetID     string
	HeadingPath []string
	Page        int
	BBox        *BBox
}

type Asset struct {
	ID      string
	Kind    string
	Path    string
	Width   int
	Height  int
	BlockID string
	Caption string
}

type Chunk struct {
	ID          string
	Text        string
	BlockIDs    []string
	HeadingPath []string
	Pages       []int
}

// Evidence est la seule forme de contenu documentaire injectée au modèle.
type Evidence struct {
	CitationID  string   `json:"citationId"`
	SourcePath  string   `json:"sourcePath"`
	ArtifactID  string   `json:"artifactId"`
	ChunkID     string   `json:"chunkId"`
	BlockIDs    []string `json:"blockIds,omitempty"`
	HeadingPath []string `json:"headingPath,omitempty"`
	Page        int      `json:"page,omitempty"`
	BBox        *BBox    `json:"bbox,omitempty"`
	Kind        string   `json:"kind,omitempty"`
	Text        string   `json:"text,omitempty"`
}

// Coverage empêche de présenter un échantillon comme une lecture exhaustive.
type Coverage struct {
	Kind             string  `json:"kind"`
	Ratio            float64 `json:"ratio"`
	SelectedChunks   int     `json:"selectedChunks"`
	TotalChunks      int     `json:"totalChunks"`
	SelectedSections int     `json:"selectedSections"`
	TotalSections    int     `json:"totalSections"`
	BlockCoverage    float64 `json:"blockCoverage"`
}

type Query struct {
	Text          string
	Intent        string
	AnchorBlockID string
	AnchorQuote   string
	AnchorPage    int
	MaxChunks     int
	MaxRunes      int
}

type Retrieval struct {
	Evidence []Evidence `json:"evidence"`
	Coverage Coverage   `json:"coverage"`
}
