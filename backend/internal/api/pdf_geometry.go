package api

import (
	"math"
	"net/http"

	"enise-docs/backend/internal/catalog"
)

const pdfGeometrySchema = "pdf-geometry/v1"

type pdfGeometry struct {
	Shape    string      `json:"shape"`
	PageView []float64   `json:"pageView"`
	Points   [][]float64 `json:"points"`
}

func validatePDFAnnotationAnchor(anchor *chatAnchor, revision string) error {
	if anchor == nil || anchor.SchemaVersion != pdfGeometrySchema {
		return validatePDFAnchor(anchor, revision)
	}
	invalid := catalog.Error(http.StatusBadRequest, "La zone ou le tracé est invalide ou hors de la page PDF.")
	g := anchor.Geometry
	if anchor.SourceRevision != revision || !validPDFRevision(revision) || anchor.Page < 1 || anchor.Page > 100000 ||
		anchor.Quote != "" || anchor.Origin != "" || anchor.Prefix != "" || anchor.Suffix != "" || anchor.Start != 0 || anchor.End != 0 ||
		anchor.BlockID != "" || len(anchor.Segments) != 0 || len(anchor.Rects) != 0 || g == nil || len(g.PageView) != 4 ||
		len(g.Points) < 2 || len(g.Points) > 160 || (g.Shape != "rect" && g.Shape != "ink") || (g.Shape == "rect" && len(g.Points) != 2) {
		return invalid
	}
	x0, y0, x1, y1 := g.PageView[0], g.PageView[1], g.PageView[2], g.PageView[3]
	for _, value := range g.PageView {
		if math.IsNaN(value) || math.Abs(value) > 1000000 {
			return invalid
		}
	}
	if x1 <= x0 || y1 <= y0 {
		return invalid
	}
	for _, point := range g.Points {
		if len(point) != 2 || math.IsNaN(point[0]) || math.IsNaN(point[1]) || point[0] < x0 || point[0] > x1 || point[1] < y0 || point[1] > y1 {
			return invalid
		}
	}
	first := g.Points[0]
	if g.Shape == "rect" && (math.Abs(first[0]-g.Points[1][0]) < .01 || math.Abs(first[1]-g.Points[1][1]) < .01) {
		return invalid
	}
	for _, point := range g.Points[1:] {
		if math.Hypot(first[0]-point[0], first[1]-point[1]) >= .01 {
			return nil
		}
	}
	return invalid
}
