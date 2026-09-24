package api

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"enise-docs/backend/internal/cache"
	"enise-docs/backend/internal/catalog"
)

const maxLinkPreviewBytes = 128 * 1024

func newLinkClient() *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			if catalog.IsBlockedLinkHost(host) {
				return nil, errBlockedHost
			}
			ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
			if err != nil {
				return nil, err
			}
			var dialErr error
			for _, ip := range ips {
				if isPrivateIP(ip.IP) {
					dialErr = errBlockedHost
					continue
				}
				conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(ip.IP.String(), port))
				if err == nil {
					return conn, nil
				}
				dialErr = err
			}
			if dialErr == nil {
				dialErr = errBlockedHost
			}
			return nil, dialErr
		},
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          16,
		IdleConnTimeout:       30 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 8 * time.Second,
	}
	return &http.Client{
		Timeout:   10 * time.Second,
		Transport: transport,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errTooManyRedirects
			}
			if req.URL.User != nil || catalog.IsBlockedLinkHost(req.URL.Hostname()) {
				return errBlockedHost
			}
			return nil
		},
	}
}

var (
	errBlockedHost      = &linkError{message: "blocked host"}
	errTooManyRedirects = &linkError{message: "too many redirects"}
)

type linkError struct{ message string }

func (e *linkError) Error() string { return e.message }

func (s *Server) handleLinkPreview(w http.ResponseWriter, r *http.Request) error {
	target := r.URL.Query().Get("url")
	if target == "" || len(target) > 2000 {
		return catalog.Error(400, "Paramètre url manquant ou trop long.")
	}
	parsed, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil || (parsed.URL.Scheme != "http" && parsed.URL.Scheme != "https") || parsed.URL.User != nil {
		return catalog.Error(400, "URL de destination invalide.")
	}
	if catalog.IsBlockedLinkHost(parsed.URL.Hostname()) {
		return catalog.Error(400, "Cette adresse ne peut pas être prévisualisée.")
	}
	key := "link:" + sha256Hex([]byte(target))
	if entry, freshness := s.cache.GetBlob(key); freshness != "" {
		writeRawJSON(w, r, http.StatusOK, entry.Body, "public, max-age=3600, stale-while-revalidate=86400", map[string]string{
			"X-Cache-Status": "HIT",
		})
		return nil
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, target, nil)
	if err != nil {
		return catalog.Error(400, "URL de destination invalide.")
	}
	request.Header.Set("Accept", "text/html,application/xhtml+xml")
	request.Header.Set("User-Agent", "enise-docs-link-preview/1.0")
	response, err := s.linkClient.Do(request)
	if err != nil {
		writeJSON(w, r, http.StatusOK, map[string]any{
			"ok": false, "reason": "unreachable", "url": target,
			"error": "La page liée est injoignable.",
		}, "public, max-age=300", nil)
		return nil
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeJSON(w, r, http.StatusOK, map[string]any{
			"ok": false, "reason": "http-error", "url": target,
			"error": "La page liée répond " + itoaStatus(response.StatusCode) + ".",
		}, "public, max-age=300", nil)
		return nil
	}
	finalURL := target
	if response.Request != nil && response.Request.URL != nil {
		finalURL = response.Request.URL.String()
	}
	if catalog.IsAuthWallURL(finalURL) {
		writeJSON(w, r, http.StatusOK, map[string]any{
			"ok": false, "reason": "auth-required", "url": target,
			"error": "Ce contenu exige une connexion Microsoft.",
		}, "public, max-age=300", nil)
		return nil
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0]))
	meta := catalog.LinkMeta{}
	if contentType == "text/html" || contentType == "application/xhtml+xml" {
		payload, _ := io.ReadAll(io.LimitReader(response.Body, maxLinkPreviewBytes))
		meta = catalog.ExtractLinkMeta(string(payload), finalURL)
	}
	body := map[string]any{
		"ok":          true,
		"url":         finalURL,
		"contentType": contentType,
		"title":       meta.Title,
		"description": meta.Description,
		"image":       meta.Image,
		"siteName":    meta.SiteName,
		"icon":        meta.Icon,
	}
	encoded := mustJSON(body)
	s.cache.PutBlob(key, cache.Entry{
		Body:        encoded,
		ContentType: "application/json",
		FreshUntil:  time.Now().Add(s.cfg.LinkPreviewTTL),
		StaleUntil:  time.Now().Add(s.cfg.LinkPreviewTTL),
	})
	writeRawJSON(w, r, http.StatusOK, encoded, "public, max-age=3600, stale-while-revalidate=86400", map[string]string{
		"X-Cache-Status": "MISS",
	})
	return nil
}

func isPrivateIP(ip net.IP) bool {
	if ip == nil || ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return true
	}
	v4 := ip.To4()
	if v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
		return true
	}
	return false
}

func itoaStatus(value int) string {
	return strconv.Itoa(value)
}

func mustJSON(value any) []byte {
	payload, err := json.Marshal(value)
	if err != nil {
		return []byte(`{"ok":false}`)
	}
	return payload
}
