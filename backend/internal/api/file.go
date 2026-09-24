package api

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"enise-docs/backend/internal/cache"
	"enise-docs/backend/internal/catalog"
)

func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) error {
	filePath, err := s.filePath(r)
	if err != nil {
		return err
	}
	download := r.URL.Query().Get("download") == "1"
	rangeHeader := r.Header.Get("Range")
	key := "file:" + s.cfg.BucketID + ":" + filePath

	if r.Method == http.MethodGet || r.Method == http.MethodHead {
		if entry, freshness := s.cache.GetBlob(key); freshness == "fresh" || freshness == "stale" {
			if freshness == "stale" {
				go s.refreshFile(filePath)
			}
			s.writeCachedFile(w, r, entry, filePath, download, rangeHeader, "HIT")
			return nil
		}
	}

	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	upstream, err := s.openUpstreamFile(ctx, r, filePath)
	if err != nil {
		return err
	}
	defer upstream.Body.Close()

	status := "MISS"
	if rangeHeader != "" || upstream.StatusCode == http.StatusPartialContent {
		status = "BYPASS-RANGE"
	}
	cacheable := upstream.StatusCode == http.StatusOK &&
		rangeHeader == "" &&
		upstream.ContentLength >= 0 &&
		upstream.ContentLength <= s.cfg.MaxCacheableFileBytes
	if !cacheable && status != "BYPASS-RANGE" && upstream.StatusCode == http.StatusOK {
		status = "BYPASS-SIZE"
	}

	s.prepareFileHeaders(w, upstream.Header, filePath, download, status)
	w.WriteHeader(upstream.StatusCode)
	if r.Method == http.MethodHead {
		return nil
	}

	var sink *bytes.Buffer
	reader := io.Reader(upstream.Body)
	if cacheable {
		sink = &bytes.Buffer{}
		reader = io.TeeReader(upstream.Body, sink)
	}
	written, copyErr := io.CopyBuffer(w, reader, make([]byte, 256*1024))
	if copyErr != nil || !cacheable || sink == nil {
		return nil
	}
	if upstream.ContentLength >= 0 && written != upstream.ContentLength {
		return nil
	}
	s.cache.PutBlob(key, cache.Entry{
		Body:        sink.Bytes(),
		ContentType: w.Header().Get("Content-Type"),
		Header:      fileCacheHeaders(upstream.Header),
		FreshUntil:  time.Now().Add(s.cfg.FileTTL),
		StaleUntil:  time.Now().Add(s.cfg.FileTTL + s.cfg.StaleGrace),
	})
	return nil
}

func (s *Server) refreshFile(filePath string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, catalog.BuildHfFileURL(s.cfg.HFOrigin, s.cfg.BucketID, filePath), nil)
	if err != nil {
		return
	}
	request.Header = s.hfHeaders("*/*")
	response, err := s.do(request)
	if err != nil {
		return
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength < 0 || response.ContentLength > s.cfg.MaxCacheableFileBytes {
		return
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, s.cfg.MaxCacheableFileBytes+1))
	if err != nil || int64(len(body)) > s.cfg.MaxCacheableFileBytes {
		return
	}
	s.cache.PutBlob("file:"+s.cfg.BucketID+":"+filePath, cache.Entry{
		Body:        body,
		ContentType: response.Header.Get("Content-Type"),
		Header:      fileCacheHeaders(response.Header),
		FreshUntil:  time.Now().Add(s.cfg.FileTTL),
		StaleUntil:  time.Now().Add(s.cfg.FileTTL + s.cfg.StaleGrace),
	})
}

func (s *Server) filePath(r *http.Request) (string, error) {
	suffix := ""
	if strings.HasPrefix(r.URL.Path, "/api/file/") {
		decoded, err := catalog.DecodeFilePathSuffix(strings.TrimPrefix(r.URL.Path, "/api/file/"))
		if err != nil {
			return "", err
		}
		suffix = decoded
	}
	raw := r.URL.Query().Get("path")
	if raw == "" {
		raw = suffix
	}
	return catalog.NormalizeFilePath(raw)
}

func (s *Server) openUpstreamFile(ctx context.Context, r *http.Request, filePath string) (*http.Response, error) {
	request, err := http.NewRequestWithContext(ctx, r.Method, catalog.BuildHfFileURL(s.cfg.HFOrigin, s.cfg.BucketID, filePath), nil)
	if err != nil {
		return nil, catalog.Error(502, "Connexion au stockage Hugging Face interrompue.")
	}
	request.Header = s.hfHeaders("*/*")
	if rangeHeader := r.Header.Get("Range"); rangeHeader != "" {
		request.Header.Set("Range", rangeHeader)
	}
	if ifRange := r.Header.Get("If-Range"); ifRange != "" {
		request.Header.Set("If-Range", ifRange)
	}
	response, err := s.do(request)
	if err != nil {
		return nil, catalog.Error(502, "Connexion au stockage Hugging Face interrompue.")
	}
	if response.StatusCode == http.StatusNotFound {
		response.Body.Close()
		return nil, catalog.Error(404, "Document introuvable dans le bucket Hugging Face.")
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent && response.StatusCode != http.StatusNotModified {
		status := response.StatusCode
		response.Body.Close()
		if status >= 500 {
			status = 502
		}
		return nil, catalog.Error(status, "Hugging Face n’a pas pu fournir ce document.")
	}
	return response, nil
}

func (s *Server) writeCachedFile(w http.ResponseWriter, r *http.Request, entry cache.Entry, filePath string, download bool, rangeHeader, cacheStatus string) {
	header := w.Header()
	applyAPISecurity(header)
	contentType := entry.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	header.Set("Content-Type", contentType)
	header.Set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400")
	header.Set("Content-Disposition", catalog.ContentDisposition(filePath, download))
	header.Set("X-Cache-Status", cacheStatus)
	header.Set("Accept-Ranges", "bytes")
	for key, value := range entry.Header {
		if value != "" {
			header.Set(key, value)
		}
	}
	applyFileContentPolicy(header, filePath)
	if rangeHeader != "" {
		start, end, ok := parseRange(rangeHeader, len(entry.Body))
		if !ok {
			header.Set("Content-Range", "bytes */"+strconv.Itoa(len(entry.Body)))
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		header.Set("Content-Range", "bytes "+strconv.Itoa(start)+"-"+strconv.Itoa(end)+"/"+strconv.Itoa(len(entry.Body)))
		header.Set("Content-Length", strconv.Itoa(end-start+1))
		header.Set("X-Cache-Status", "HIT-RANGE")
		w.WriteHeader(http.StatusPartialContent)
		if r.Method != http.MethodHead {
			_, _ = w.Write(entry.Body[start : end+1])
		}
		return
	}
	header.Set("Content-Length", strconv.Itoa(len(entry.Body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(entry.Body)
	}
}

func (s *Server) prepareFileHeaders(w http.ResponseWriter, upstream http.Header, filePath string, download bool, cacheStatus string) {
	header := w.Header()
	applyAPISecurity(header)
	copyHeader(header, upstream, "Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified")
	if header.Get("Content-Type") == "" {
		header.Set("Content-Type", "application/octet-stream")
	}
	header.Set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400")
	header.Set("Content-Disposition", catalog.ContentDisposition(filePath, download))
	header.Set("X-Cache-Status", cacheStatus)
	header.Set("Accept-Ranges", "bytes")
	applyFileContentPolicy(header, filePath)
}

func applyFileContentPolicy(header http.Header, filePath string) {
	switch catalog.Extension(filePath) {
	case "html", "htm", "xml":
		header.Set("Content-Type", "text/plain; charset=utf-8")
		header.Set("Content-Security-Policy", "sandbox; default-src 'none'")
	case "svg":
		header.Set("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
	}
}

func fileCacheHeaders(upstream http.Header) map[string]string {
	out := map[string]string{}
	for _, key := range []string{"ETag", "Last-Modified"} {
		if value := upstream.Get(key); value != "" {
			out[key] = value
		}
	}
	return out
}

func copyHeader(dst, src http.Header, keys ...string) {
	for _, key := range keys {
		if value := src.Get(key); value != "" {
			dst.Set(key, value)
		}
	}
}

func parseRange(header string, size int) (int, int, bool) {
	if size <= 0 || !strings.HasPrefix(header, "bytes=") || strings.Contains(header, ",") {
		return 0, 0, false
	}
	spec := strings.TrimPrefix(header, "bytes=")
	startText, endText, ok := strings.Cut(spec, "-")
	if !ok {
		return 0, 0, false
	}
	if startText == "" {
		suffix, err := strconv.Atoi(endText)
		if err != nil || suffix <= 0 {
			return 0, 0, false
		}
		if suffix > size {
			suffix = size
		}
		return size - suffix, size - 1, true
	}
	start, err := strconv.Atoi(startText)
	if err != nil || start < 0 || start >= size {
		return 0, 0, false
	}
	end := size - 1
	if endText != "" {
		end, err = strconv.Atoi(endText)
		if err != nil || end < start {
			return 0, 0, false
		}
		if end >= size {
			end = size - 1
		}
	}
	return start, end, true
}
