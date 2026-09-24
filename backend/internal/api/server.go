package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"enise-docs/backend/internal/cache"
	"enise-docs/backend/internal/catalog"
	"enise-docs/backend/internal/config"
)

const staticCSP = "default-src 'self'; script-src 'self' https://static.cloudflareinsights.com https://developer.api.autodesk.com; style-src 'self' 'unsafe-inline' https://developer.api.autodesk.com; img-src 'self' data: blob: https:; media-src 'self' blob: https://developer.api.autodesk.com; frame-src 'self' blob: https://view.officeapps.live.com https://developer.api.autodesk.com https://iframe.sharecad.org; connect-src 'self' https://cloudflareinsights.com https://developer.api.autodesk.com; font-src 'self' data: https://developer.api.autodesk.com; worker-src 'self' blob: https://developer.api.autodesk.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"

// Server sert le même contrat /api que le Worker, avec un cache chaud.
type Server struct {
	cfg           config.Config
	cache         *cache.Store
	client        *http.Client
	convertClient *http.Client
	linkClient    *http.Client
	tokens        *tokenCache
	chatHits      *chatLimiter
}

func New(cfg config.Config) *Server {
	transport := newTransport(30 * time.Second)
	convertTransport := newTransport(2 * time.Minute)
	server := &Server{
		cfg:   cfg,
		cache: cache.New(cfg.CacheDir),
		client: &http.Client{
			Transport:     transport,
			CheckRedirect: redirectPolicy,
		},
		convertClient: &http.Client{
			Transport:     convertTransport,
			CheckRedirect: redirectPolicy,
		},
		linkClient: newLinkClient(),
		tokens:     &tokenCache{},
		chatHits:   newChatLimiter(),
	}
	if server.cache.LoadIndex() {
		log.Printf("index disque chargé (%s)", cfg.BucketID)
	}
	return server
}

// Warmup recharge l’index en arrière-plan pour que la première navigation
// n’attende pas le parcours complet du bucket.
func (s *Server) Warmup(ctx context.Context) {
	s.refreshIndex(ctx)
	interval := s.cfg.IndexTTL / 2
	if interval < time.Minute {
		interval = s.cfg.IndexTTL
	}
	if interval <= 0 {
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.refreshIndex(ctx)
		}
	}
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	writer := &statusWriter{ResponseWriter: w}
	if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api" {
		s.serveAPI(writer, r)
	} else {
		s.serveStatic(writer, r)
	}
	if writer.status == 0 {
		writer.status = http.StatusOK
	}
	log.Printf("%s %s %d %s", r.Method, r.URL.RequestURI(), writer.status, time.Since(started).Round(time.Millisecond))
}

func (s *Server) serveAPI(w http.ResponseWriter, r *http.Request) {
	applyAPISecurity(w.Header())
	if r.Method == http.MethodOptions {
		w.Header().Set("Allow", "GET, HEAD, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Range, Content-Type, Authorization")
		w.Header().Set("Access-Control-Max-Age", "86400")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	var err error
	switch {
	case r.URL.Path == "/api/health":
		err = s.handleHealth(w, r)
	case r.URL.Path == "/api/chat/status":
		err = s.allow(w, r, http.MethodGet, s.handleChatStatus)
	case r.URL.Path == "/api/chat":
		err = s.allow(w, r, http.MethodPost, s.handleChat)
	case r.URL.Path == "/api/tree":
		err = s.allow(w, r, http.MethodGet, s.handleTree)
	case r.URL.Path == "/api/index":
		err = s.allow(w, r, http.MethodGet, s.handleIndex)
	case r.URL.Path == "/api/counts":
		err = s.allow(w, r, http.MethodGet, s.handleCounts)
	case r.URL.Path == "/api/file" || strings.HasPrefix(r.URL.Path, "/api/file/"):
		err = s.allow(w, r, "", s.handleFile)
	case r.URL.Path == "/api/office/status":
		err = s.allow(w, r, http.MethodGet, s.handleOfficeStatus)
	case r.URL.Path == "/api/office/pdf":
		err = s.allow(w, r, http.MethodGet, s.handleOfficePDF)
	case r.URL.Path == "/api/model3d/status":
		err = s.allow(w, r, http.MethodGet, s.handleModel3DStatus)
	case r.URL.Path == "/api/model3d/glb":
		err = s.allow(w, r, http.MethodGet, s.handleModel3DGLB)
	case r.URL.Path == "/api/solidworks/status":
		err = s.allow(w, r, http.MethodGet, s.handleSolidworksStatus)
	case r.URL.Path == "/api/solidworks/step":
		err = s.allow(w, r, http.MethodPost, s.handleSolidworksStep)
	case r.URL.Path == "/api/link/preview":
		err = s.allow(w, r, http.MethodGet, s.handleLinkPreview)
	case r.URL.Path == "/api/aps/token":
		err = s.allow(w, r, http.MethodGet, s.handleApsToken)
	case r.URL.Path == "/api/aps/status":
		err = s.allow(w, r, http.MethodGet, s.handleApsStatus)
	case r.URL.Path == "/api/aps/view":
		err = s.allow(w, r, http.MethodPost, s.handleApsView)
	default:
		err = catalog.Error(http.StatusNotFound, "Route API introuvable.")
	}
	if err != nil {
		writeError(w, r, err)
	}
}

func (s *Server) allow(w http.ResponseWriter, r *http.Request, method string, handler func(http.ResponseWriter, *http.Request) error) error {
	if method == "" {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			return catalog.Error(http.StatusMethodNotAllowed, "Méthode "+r.Method+" non autorisée.")
		}
		return handler(w, r)
	}
	if r.Method != method {
		w.Header().Set("Allow", method)
		return catalog.Error(http.StatusMethodNotAllowed, "Méthode "+r.Method+" non autorisée.")
	}
	return handler(w, r)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) error {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		return catalog.Error(http.StatusMethodNotAllowed, "Méthode "+r.Method+" non autorisée.")
	}
	_, _, state := s.cache.Index()
	index := "cold"
	switch state {
	case "fresh":
		index = "ready"
	case "stale":
		index = "stale"
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok":       true,
		"service":  "enise-docs",
		"backend":  "go",
		"bucketId": s.cfg.BucketID,
		"cache":    "memory",
		"index":    index,
	}, "no-store", nil)
	return nil
}

func (s *Server) handleTree(w http.ResponseWriter, r *http.Request) error {
	prefix, err := catalog.NormalizePrefix(r.URL.Query().Get("prefix"))
	if err != nil {
		return err
	}
	started := time.Now()
	if doc, _, state := s.cache.Index(); doc != nil && doc.Complete {
		if !indexHasPrefix(doc, prefix) {
			return catalog.Error(http.StatusNotFound, "Ce dossier n’existe pas dans la bibliothèque.")
		}
		if state == "stale" {
			go s.refreshIndex(context.Background())
		}
		writeJSON(w, r, http.StatusOK, map[string]any{
			"bucketId":  s.cfg.BucketID,
			"prefix":    prefix,
			"items":     catalog.ChildrenFromIndex(doc.Items, prefix),
			"complete":  true,
			"fetchedAt": doc.FetchedAt,
		}, "public, max-age=300, stale-while-revalidate=3600", map[string]string{
			"X-Cache-Status": "INDEX",
			"Server-Timing":  timing(started, "index"),
		})
		return nil
	}

	key := "tree:" + s.cfg.BucketID + ":" + prefix
	if entry, freshness := s.cache.GetBlob(key); freshness == "fresh" || freshness == "stale" {
		status := "HIT"
		if freshness == "stale" {
			status = "STALE"
			go s.refreshTree(prefix)
		}
		writeRawJSON(w, r, http.StatusOK, entry.Body, "public, max-age=300, stale-while-revalidate=3600", map[string]string{
			"X-Cache-Status": status,
			"Server-Timing":  timing(started, "cache"),
		})
		return nil
	}

	value, err := s.cache.Do(key, func() (any, error) {
		if entry, freshness := s.cache.GetBlob(key); freshness == "fresh" {
			return entry.Body, nil
		}
		items, complete, err := s.fetchTree(context.Background(), prefix, false)
		if err != nil {
			return nil, err
		}
		if items == nil {
			items = []catalog.BucketItem{}
		}
		payload, err := json.Marshal(map[string]any{
			"bucketId":  s.cfg.BucketID,
			"prefix":    prefix,
			"items":     items,
			"complete":  complete,
			"fetchedAt": time.Now().UTC().Format(time.RFC3339),
		})
		if err != nil {
			return nil, err
		}
		s.cache.PutBlob(key, cache.Entry{
			Body:        payload,
			ContentType: "application/json",
			FreshUntil:  time.Now().Add(s.cfg.TreeTTL),
			StaleUntil:  time.Now().Add(s.cfg.TreeTTL + s.cfg.StaleGrace),
		})
		return payload, nil
	})
	if err != nil {
		return err
	}
	writeRawJSON(w, r, http.StatusOK, value.([]byte), "public, max-age=300, stale-while-revalidate=3600", map[string]string{
		"X-Cache-Status": "MISS",
		"Server-Timing":  timing(started, "hf"),
	})
	return nil
}

func (s *Server) refreshTree(prefix string) {
	_, _ = s.cache.Do("refresh-tree:"+prefix, func() (any, error) {
		items, complete, err := s.fetchTree(context.Background(), prefix, false)
		if err != nil {
			return nil, err
		}
		payload, err := json.Marshal(map[string]any{
			"bucketId":  s.cfg.BucketID,
			"prefix":    prefix,
			"items":     items,
			"complete":  complete,
			"fetchedAt": time.Now().UTC().Format(time.RFC3339),
		})
		if err != nil {
			return nil, err
		}
		s.cache.PutBlob("tree:"+s.cfg.BucketID+":"+prefix, cache.Entry{
			Body:        payload,
			ContentType: "application/json",
			FreshUntil:  time.Now().Add(s.cfg.TreeTTL),
			StaleUntil:  time.Now().Add(s.cfg.TreeTTL + s.cfg.StaleGrace),
		})
		return nil, nil
	})
}

type indexResult struct {
	doc    *catalog.IndexDocument
	body   []byte
	status string
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) error {
	started := time.Now()
	result, err := s.loadIndex(r.Context(), false)
	if err != nil {
		return err
	}
	writeRawJSON(w, r, http.StatusOK, result.body, "public, max-age=1800, stale-while-revalidate=7200", map[string]string{
		"X-Cache-Status": result.status,
		"X-Data-Source":  "index-json",
		"Server-Timing":  timing(started, "index"),
	})
	return nil
}

func (s *Server) handleCounts(w http.ResponseWriter, r *http.Request) error {
	prefix, err := catalog.NormalizePrefix(r.URL.Query().Get("prefix"))
	if err != nil {
		return err
	}
	started := time.Now()
	result, err := s.loadIndex(r.Context(), false)
	if err != nil {
		return err
	}
	counts, total := catalog.SelectCountsForPrefix(result.doc, prefix)
	writeJSON(w, r, http.StatusOK, map[string]any{
		"bucketId":   s.cfg.BucketID,
		"prefix":     prefix,
		"counts":     counts,
		"totalFiles": total,
		"complete":   result.doc.Complete,
		"fetchedAt":  result.doc.FetchedAt,
		"source":     "index-json",
	}, "public, max-age=1800, stale-while-revalidate=7200", map[string]string{
		"X-Cache-Status": result.status,
		"X-Data-Source":  "index-json",
		"Server-Timing":  timing(started, "index"),
	})
	return nil
}

func (s *Server) refreshIndex(ctx context.Context) {
	if _, err := s.loadIndex(ctx, true); err != nil {
		log.Printf("rafraîchissement de l’index impossible: %v", err)
	}
}

func (s *Server) loadIndex(ctx context.Context, force bool) (indexResult, error) {
	if !force {
		if doc, body, state := s.cache.Index(); doc != nil && state == "fresh" {
			return indexResult{doc: doc, body: body, status: "HIT"}, nil
		}
		if doc, body, state := s.cache.Index(); doc != nil && state == "stale" {
			go s.refreshIndex(context.Background())
			return indexResult{doc: doc, body: body, status: "STALE"}, nil
		}
	}
	value, err := s.cache.Do("index", func() (any, error) {
		if !force {
			if doc, body, state := s.cache.Index(); doc != nil && state == "fresh" {
				return indexResult{doc: doc, body: body, status: "HIT"}, nil
			}
		}
		fetchCtx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		doc, err := s.buildIndex(fetchCtx)
		if err != nil {
			if cached, body, state := s.cache.Index(); cached != nil && state != "" {
				return indexResult{doc: cached, body: body, status: "STALE"}, nil
			}
			return nil, err
		}
		s.cache.SetIndex(doc, s.cfg.IndexTTL, s.cfg.StaleGrace)
		body, err := json.Marshal(doc)
		if err != nil {
			return nil, err
		}
		return indexResult{doc: doc, body: body, status: "MISS"}, nil
	})
	if err != nil {
		return indexResult{}, err
	}
	result, _ := value.(indexResult)
	if result.doc == nil {
		return indexResult{}, catalog.Error(502, "Index documentaire illisible.")
	}
	_ = ctx
	return result, nil
}

func (s *Server) buildIndex(ctx context.Context) (*catalog.IndexDocument, error) {
	items, complete, err := s.fetchTree(ctx, "", true)
	if err != nil {
		return nil, err
	}
	if len(items) > catalog.MaxIndexItems {
		items = items[:catalog.MaxIndexItems]
		complete = false
	}
	compact := make([]catalog.BucketItem, 0, len(items))
	for _, item := range items {
		compact = append(compact, catalog.CompactItem(item))
	}
	counts, total := catalog.CountFilesByDirectory(compact, "")
	return &catalog.IndexDocument{
		BucketID:   s.cfg.BucketID,
		Items:      compact,
		Counts:     counts,
		TotalFiles: total,
		Complete:   complete && len(items) <= catalog.MaxIndexItems,
		FetchedAt:  time.Now().UTC().Format(time.RFC3339),
	}, nil
}

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if s.cfg.StaticDir == "" {
		http.NotFound(w, r)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "Méthode non autorisée.", http.StatusMethodNotAllowed)
		return
	}
	rel := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	root := filepath.Clean(s.cfg.StaticDir)
	target := filepath.Join(root, filepath.FromSlash(rel))
	relative, err := filepath.Rel(root, target)
	if err != nil || strings.HasPrefix(relative, "..") || relative == ".." {
		http.NotFound(w, r)
		return
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		s.serveSPA(w, r)
		return
	}
	s.staticHeaders(w, r.URL.Path)
	http.ServeFile(w, r, target)
}

func (s *Server) serveSPA(w http.ResponseWriter, r *http.Request) {
	index := filepath.Join(s.cfg.StaticDir, "index.html")
	if _, err := os.Stat(index); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Security-Policy", staticCSP)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	http.ServeFile(w, r, index)
}

func (s *Server) staticHeaders(w http.ResponseWriter, urlPath string) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
	w.Header().Set("Content-Security-Policy", staticCSP)
	if strings.HasPrefix(urlPath, "/assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
}

func indexHasPrefix(doc *catalog.IndexDocument, prefix string) bool {
	if prefix == "" || doc == nil {
		return prefix == ""
	}
	for _, item := range doc.Items {
		path := strings.Trim(item.Path, "/")
		if path == prefix || strings.HasPrefix(path, prefix+"/") {
			return true
		}
	}
	return false
}
