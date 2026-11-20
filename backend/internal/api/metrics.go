package api

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"sync"
	"time"

	"enise-docs/backend/internal/catalog"
)

const (
	readerMetricBodyMax   = 4096
	readerMetricRateLimit = 120
)

type readerMetricRequest struct {
	Event           string `json:"event"`
	Kind            string `json:"kind,omitempty"`
	Mode            string `json:"mode,omitempty"`
	Status          string `json:"status,omitempty"`
	Outcome         string `json:"outcome,omitempty"`
	Action          string `json:"action,omitempty"`
	Viewport        string `json:"viewport,omitempty"`
	PageCount       string `json:"pageCount,omitempty"`
	BlockCount      string `json:"blockCount,omitempty"`
	SelectionLength string `json:"selectionLength,omitempty"`
	DurationMS      int    `json:"durationMs,omitempty"`
}

type readerMetricLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

var readerMetricEvents = stringSet(
	"open", "metadata", "first-page", "mode-change", "selection",
	"assistant", "citation-open", "annotation", "network", "pdf-error",
)
var readerMetricKinds = stringSet(
	"pdf", "office", "document", "presentation", "spreadsheet", "text",
	"ebook", "message", "image", "file", "unknown",
)
var readerMetricModes = stringSet("pdf", "structured")
var readerMetricStatuses = stringSet(
	"structured-ready", "conversion-pending", "artifact-failed", "artifact-oversized", "artifact-unavailable", "unknown",
)
var readerMetricOutcomes = stringSet(
	"success", "error", "started", "anchored", "geometric", "saved", "opened", "online", "offline",
)
var readerMetricActions = stringSet("explain-selection", "translate-selection", "explain", "highlight", "note")
var readerMetricViewports = stringSet("mobile", "tablet", "desktop", "unknown")
var readerMetricBuckets = stringSet(
	"0-1", "2-10", "11-50", "51-100", "101-500", "501+",
	"0-10", "51-200", "201-500", "501-2000", "2001+",
)

func newReaderMetricLimiter() *readerMetricLimiter {
	return &readerMetricLimiter{hits: map[string][]time.Time{}}
}

func (l *readerMetricLimiter) allow(key string) bool {
	if l == nil {
		return true
	}
	now := time.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.hits == nil {
		l.hits = map[string][]time.Time{}
	}
	recent := make([]time.Time, 0, len(l.hits[key])+1)
	for _, hit := range l.hits[key] {
		if now.Sub(hit) < time.Minute {
			recent = append(recent, hit)
		}
	}
	if len(recent) >= readerMetricRateLimit {
		l.hits[key] = recent
		return false
	}
	l.hits[key] = append(recent, now)
	if len(l.hits) > 2000 {
		for id, values := range l.hits {
			if len(values) == 0 || now.Sub(values[len(values)-1]) >= time.Minute {
				delete(l.hits, id)
			}
		}
	}
	return true
}

func (s *Server) handleReaderMetric(w http.ResponseWriter, r *http.Request) error {
	if !s.readerMetricHits.allow(s.chatClientKey(r)) {
		return catalog.Error(http.StatusTooManyRequests, "Trop de mesures envoyées. Réessayez dans une minute.")
	}
	var body readerMetricRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, readerMetricBodyMax))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		return catalog.Error(http.StatusBadRequest, "Mesure du lecteur invalide.")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return catalog.Error(http.StatusBadRequest, "Une seule mesure est acceptée.")
	}
	if err := validateReaderMetric(body); err != nil {
		return err
	}
	log.Printf(
		"reader_metric event=%q kind=%q mode=%q status=%q outcome=%q action=%q viewport=%q pages=%q blocks=%q selection=%q duration_ms=%d",
		body.Event, body.Kind, body.Mode, body.Status, body.Outcome, body.Action, body.Viewport,
		body.PageCount, body.BlockCount, body.SelectionLength, body.DurationMS,
	)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func validateReaderMetric(body readerMetricRequest) error {
	checks := []struct {
		value   string
		allowed map[string]struct{}
	}{
		{body.Event, readerMetricEvents},
		{body.Kind, readerMetricKinds},
		{body.Mode, readerMetricModes},
		{body.Status, readerMetricStatuses},
		{body.Outcome, readerMetricOutcomes},
		{body.Action, readerMetricActions},
		{body.Viewport, readerMetricViewports},
	}
	for index, check := range checks {
		if index == 0 && check.value == "" {
			return catalog.Error(http.StatusBadRequest, "Le type de mesure est requis.")
		}
		if check.value != "" {
			if _, ok := check.allowed[check.value]; !ok {
				return catalog.Error(http.StatusBadRequest, "Dimension de mesure inconnue.")
			}
		}
	}
	if body.DurationMS < 0 || body.DurationMS > 600000 {
		return catalog.Error(http.StatusBadRequest, "Durée de mesure invalide.")
	}
	for _, bucket := range []string{body.PageCount, body.BlockCount, body.SelectionLength} {
		if bucket != "" && !validMetricBucket(bucket) {
			return catalog.Error(http.StatusBadRequest, "Classe de mesure invalide.")
		}
	}
	return nil
}

func validMetricBucket(value string) bool {
	_, ok := readerMetricBuckets[value]
	return ok
}

func stringSet(values ...string) map[string]struct{} {
	result := make(map[string]struct{}, len(values))
	for _, value := range values {
		result[value] = struct{}{}
	}
	return result
}
