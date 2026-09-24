package api

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"enise-docs/backend/internal/catalog"
)

func applyAPISecurity(header http.Header) {
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()")
	header.Set("X-Robots-Tag", "noindex, nofollow")
	header.Set("X-Backend", "go")
}

func writeError(w http.ResponseWriter, r *http.Request, err error) {
	var httpErr *catalog.HTTPError
	if errors.As(err, &httpErr) && httpErr != nil {
		writeJSON(w, r, httpErr.Status, map[string]string{"error": httpErr.Message}, "no-store", nil)
		return
	}
	log.Printf("api error: %v", err)
	writeJSON(w, r, http.StatusInternalServerError, map[string]string{
		"error": "Le service documentaire est momentanément indisponible.",
	}, "no-store", nil)
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, value any, cacheControl string, extra map[string]string) {
	payload, err := json.Marshal(value)
	if err != nil {
		http.Error(w, "json", http.StatusInternalServerError)
		return
	}
	writeRawJSON(w, r, status, payload, cacheControl, extra)
}

func writeRawJSON(w http.ResponseWriter, r *http.Request, status int, payload []byte, cacheControl string, extra map[string]string) {
	header := w.Header()
	applyAPISecurity(header)
	header.Set("Content-Type", "application/json; charset=utf-8")
	if cacheControl == "" {
		cacheControl = "no-store"
	}
	header.Set("Cache-Control", cacheControl)
	for key, value := range extra {
		header.Set(key, value)
	}
	if len(payload) >= 256 && acceptsGzip(r) {
		header.Set("Content-Encoding", "gzip")
		header.Add("Vary", "Accept-Encoding")
		w.WriteHeader(status)
		compressor := gzip.NewWriter(w)
		_, _ = compressor.Write(payload)
		_ = compressor.Close()
		return
	}
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

func acceptsGzip(r *http.Request) bool {
	if r == nil {
		return false
	}
	return strings.Contains(r.Header.Get("Accept-Encoding"), "gzip")
}

func timing(started time.Time, label string) string {
	duration := time.Since(started).Milliseconds()
	if duration < 0 {
		duration = 0
	}
	return label + ";dur=" + strconv.FormatInt(duration, 10)
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(payload []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(payload)
}

func (w *statusWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}
