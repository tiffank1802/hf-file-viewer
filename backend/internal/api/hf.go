package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"enise-docs/backend/internal/catalog"
)

type rawItem struct {
	Type            string   `json:"type"`
	Path            string   `json:"path"`
	Size            *float64 `json:"size"`
	Mtime           string   `json:"mtime"`
	UploadedAt      string   `json:"uploadedAt"`
	UploadedAtSnake string   `json:"uploaded_at"`
	NumItems        *float64 `json:"numItems"`
	TotalFiles      *float64 `json:"totalFiles"`
}

func (s *Server) hfHeaders(accept string) http.Header {
	header := make(http.Header)
	header.Set("Accept", accept)
	header.Set("User-Agent", "enise-docs-go/1.0")
	if s.cfg.HFToken != "" {
		header.Set("Authorization", "Bearer "+s.cfg.HFToken)
	}
	return header
}

func (s *Server) do(req *http.Request) (*http.Response, error) {
	response, err := s.client.Do(req)
	if err != nil {
		return nil, err
	}
	if req.Method == http.MethodGet && (response.StatusCode == http.StatusTooManyRequests || response.StatusCode == http.StatusServiceUnavailable) {
		response.Body.Close()
		select {
		case <-req.Context().Done():
			return nil, req.Context().Err()
		case <-time.After(250 * time.Millisecond):
		}
		clone := req.Clone(req.Context())
		return s.client.Do(clone)
	}
	return response, nil
}

func (s *Server) fetchTree(ctx context.Context, prefix string, recursive bool) ([]catalog.BucketItem, bool, error) {
	items := make([]catalog.BucketItem, 0)
	nextURL := catalog.BuildHfTreeURL(s.cfg.HFOrigin, s.cfg.BucketID, prefix, recursive)
	pages := 0
	complete := true
	for nextURL != "" && pages < catalog.MaxTreePages && len(items) < catalog.MaxIndexItems {
		pageCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
		request, err := http.NewRequestWithContext(pageCtx, http.MethodGet, nextURL, nil)
		if err != nil {
			cancel()
			return nil, false, catalog.Error(502, "Connexion au stockage Hugging Face interrompue.")
		}
		request.Header = s.hfHeaders("application/json")
		response, err := s.do(request)
		if err != nil {
			cancel()
			return nil, false, catalog.Error(502, "Connexion au stockage Hugging Face interrompue.")
		}
		if response.StatusCode == http.StatusNotFound {
			response.Body.Close()
			cancel()
			return nil, false, catalog.Error(404, "Ce dossier n’existe pas dans la bibliothèque.")
		}
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			response.Body.Close()
			cancel()
			return nil, false, catalog.Error(502, "Le bucket Hugging Face requiert une autorisation côté serveur.")
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			response.Body.Close()
			cancel()
			return nil, false, catalog.Error(502, "Impossible de joindre le stockage Hugging Face.")
		}
		payload, err := io.ReadAll(io.LimitReader(response.Body, 32<<20))
		link := response.Header.Get("Link")
		response.Body.Close()
		cancel()
		if err != nil {
			return nil, false, catalog.Error(502, "Connexion au stockage Hugging Face interrompue.")
		}
		page, err := decodeItems(payload)
		if err != nil {
			return nil, false, catalog.Error(502, "Réponse inattendue du stockage Hugging Face.")
		}
		for _, item := range page {
			items = append(items, compactRaw(item))
		}
		nextURL = catalog.GetNextLink(link, nextURL)
		pages++
	}
	if nextURL != "" || len(items) >= catalog.MaxIndexItems {
		complete = false
	}
	if len(items) > catalog.MaxIndexItems {
		items = items[:catalog.MaxIndexItems]
	}
	return items, complete, nil
}

func decodeItems(payload []byte) ([]rawItem, error) {
	payload = bytesTrim(payload)
	if len(payload) == 0 {
		return nil, catalog.Error(502, "Réponse inattendue du stockage Hugging Face.")
	}
	if payload[0] == '[' {
		var items []rawItem
		if err := json.Unmarshal(payload, &items); err != nil {
			return nil, err
		}
		return items, nil
	}
	var wrapped struct {
		Items []rawItem `json:"items"`
	}
	if err := json.Unmarshal(payload, &wrapped); err != nil {
		return nil, err
	}
	if wrapped.Items == nil {
		return nil, catalog.Error(502, "Réponse inattendue du stockage Hugging Face.")
	}
	return wrapped.Items, nil
}

func bytesTrim(payload []byte) []byte {
	return []byte(strings.TrimSpace(string(payload)))
}

func compactRaw(item rawItem) catalog.BucketItem {
	compact := catalog.BucketItem{Type: "file", Path: strings.TrimLeft(item.Path, "/")}
	if item.Type == "directory" {
		compact.Type = "directory"
	}
	if item.Size != nil {
		size := int64(*item.Size)
		compact.Size = &size
	}
	switch {
	case item.Mtime != "":
		compact.Mtime = item.Mtime
	case item.UploadedAt != "":
		compact.Mtime = item.UploadedAt
	case item.UploadedAtSnake != "":
		compact.Mtime = item.UploadedAtSnake
	}
	if item.NumItems != nil {
		value := int(*item.NumItems)
		compact.NumItems = &value
	}
	if item.TotalFiles != nil {
		value := int(*item.TotalFiles)
		compact.TotalFiles = &value
	}
	return compact
}

func (s *Server) downloadLimited(ctx context.Context, filePath string, maxBytes int64) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, catalog.BuildHfFileURL(s.cfg.HFOrigin, s.cfg.BucketID, filePath), nil)
	if err != nil {
		return nil, catalog.Error(502, "Connexion au stockage Hugging Face interrompue.")
	}
	request.Header = s.hfHeaders("*/*")
	response, err := s.do(request)
	if err != nil {
		return nil, catalog.Error(502, "Connexion au stockage Hugging Face interrompue.")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return nil, catalog.Error(404, "Document introuvable dans le bucket Hugging Face.")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		status := response.StatusCode
		if status >= 500 {
			status = 502
		}
		return nil, catalog.Error(status, "Impossible de lire le document à convertir.")
	}
	if declared := response.ContentLength; declared > maxBytes {
		return nil, tooLarge(maxBytes)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return nil, catalog.Error(502, "Connexion au stockage Hugging Face interrompue.")
	}
	if int64(len(payload)) == 0 {
		return nil, catalog.Error(422, "Le document à convertir est vide.")
	}
	if int64(len(payload)) > maxBytes {
		return nil, tooLarge(maxBytes)
	}
	return payload, nil
}

func tooLarge(maxBytes int64) *catalog.HTTPError {
	return catalog.Error(413, "Ce fichier est trop volumineux pour la conversion (limite "+strconv.FormatInt(maxBytes/1024/1024, 10)+" Mo).")
}

func upstreamError(response *http.Response, fallback string, limit int) *catalog.HTTPError {
	detail := fallback
	payload, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if len(payload) > 0 {
		var body map[string]any
		if json.Unmarshal(payload, &body) == nil {
			for _, key := range []string{"diagnostic", "developerMessage", "detail", "error", "message"} {
				if text, ok := body[key].(string); ok && text != "" {
					detail = text
					break
				}
			}
		}
	}
	if len(detail) > limit {
		detail = detail[:limit]
	}
	status := response.StatusCode
	if status >= 500 {
		status = 502
	}
	if status == 0 {
		status = 502
	}
	return catalog.Error(status, detail)
}
