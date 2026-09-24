// Cache mémoire + disque, avec coalescence des requêtes identiques.
// Un dossier déjà indexé est relu sans rappeler Hugging Face.
package cache

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"enise-docs/backend/internal/catalog"
)

const defaultBlobBudget = 128 << 20

// Entry est une réponse binaire réutilisable (fichier, PDF, GLB).
type Entry struct {
	Body        []byte
	ContentType string
	Header      map[string]string
	FreshUntil  time.Time
	StaleUntil  time.Time
	Touched     time.Time
}

type indexState struct {
	Doc        *catalog.IndexDocument
	Body       []byte
	FreshUntil time.Time
	StaleUntil time.Time
}

// Store garde l’index au chaud et les fichiers sous un budget mémoire.
type Store struct {
	dir       string
	blobLimit int

	mu        sync.Mutex
	index     *indexState
	blobs     map[string]Entry
	blobBytes int
	flight    flightGroup
}

func New(dir string) *Store {
	if dir != "" {
		_ = os.MkdirAll(dir, 0o755)
	}
	return &Store{
		dir:       dir,
		blobLimit: defaultBlobBudget,
		blobs:     map[string]Entry{},
	}
}

func (s *Store) Do(key string, fn func() (any, error)) (any, error) {
	return s.flight.Do(key, fn)
}

func (s *Store) Index() (*catalog.IndexDocument, []byte, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.index == nil || s.index.Doc == nil {
		return nil, nil, ""
	}
	state := "stale"
	if time.Now().Before(s.index.FreshUntil) {
		state = "fresh"
	} else if !s.index.StaleUntil.IsZero() && time.Now().After(s.index.StaleUntil) {
		return nil, nil, ""
	}
	return s.index.Doc, append([]byte(nil), s.index.Body...), state
}

func (s *Store) SetIndex(doc *catalog.IndexDocument, freshFor, staleFor time.Duration) {
	if doc == nil {
		return
	}
	body, err := json.Marshal(doc)
	if err != nil {
		return
	}
	now := time.Now()
	state := &indexState{
		Doc:        doc,
		Body:       body,
		FreshUntil: now.Add(freshFor),
		StaleUntil: now.Add(freshFor + staleFor),
	}
	s.mu.Lock()
	s.index = state
	s.mu.Unlock()
	s.writeIndex(state)
}

func (s *Store) LoadIndex() bool {
	if s.dir == "" {
		return false
	}
	raw, err := os.ReadFile(filepath.Join(s.dir, "index.json"))
	if err != nil {
		return false
	}
	var envelope struct {
		FreshUntil time.Time             `json:"freshUntil"`
		StaleUntil time.Time             `json:"staleUntil"`
		Body       catalog.IndexDocument `json:"body"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return false
	}
	if !envelope.StaleUntil.IsZero() && time.Now().After(envelope.StaleUntil.Add(7*24*time.Hour)) {
		return false
	}
	body, err := json.Marshal(envelope.Body)
	if err != nil {
		return false
	}
	s.mu.Lock()
	s.index = &indexState{
		Doc:        &envelope.Body,
		Body:       body,
		FreshUntil: envelope.FreshUntil,
		StaleUntil: envelope.StaleUntil,
	}
	s.mu.Unlock()
	return true
}

func (s *Store) writeIndex(state *indexState) {
	if s.dir == "" || state == nil || state.Doc == nil {
		return
	}
	envelope := struct {
		FreshUntil time.Time              `json:"freshUntil"`
		StaleUntil time.Time              `json:"staleUntil"`
		Body       *catalog.IndexDocument `json:"body"`
	}{state.FreshUntil, state.StaleUntil, state.Doc}
	payload, err := json.Marshal(envelope)
	if err != nil {
		return
	}
	_ = writeAtomic(filepath.Join(s.dir, "index.json"), payload)
}

func (s *Store) GetBlob(key string) (Entry, string) {
	s.mu.Lock()
	entry, ok := s.blobs[key]
	if ok {
		entry.Touched = time.Now()
		s.blobs[key] = entry
		s.mu.Unlock()
		if time.Now().Before(entry.FreshUntil) {
			return entry, "fresh"
		}
		if entry.StaleUntil.IsZero() || time.Now().Before(entry.StaleUntil) {
			return entry, "stale"
		}
	} else {
		s.mu.Unlock()
	}
	if loaded, ok := s.readBlob(key); ok {
		s.PutBlob(key, loaded)
		if time.Now().Before(loaded.FreshUntil) {
			return loaded, "fresh"
		}
		return loaded, "stale"
	}
	return Entry{}, ""
}

func (s *Store) PutBlob(key string, entry Entry) {
	if len(entry.Body) == 0 {
		return
	}
	entry.Touched = time.Now()
	s.mu.Lock()
	if previous, ok := s.blobs[key]; ok {
		s.blobBytes -= len(previous.Body)
	}
	s.blobs[key] = entry
	s.blobBytes += len(entry.Body)
	s.evictLocked()
	s.mu.Unlock()
	s.writeBlob(key, entry)
}

func (s *Store) evictLocked() {
	for s.blobBytes > s.blobLimit && len(s.blobs) > 0 {
		var oldestKey string
		var oldest time.Time
		for key, entry := range s.blobs {
			if oldestKey == "" || entry.Touched.Before(oldest) {
				oldestKey = key
				oldest = entry.Touched
			}
		}
		s.blobBytes -= len(s.blobs[oldestKey].Body)
		delete(s.blobs, oldestKey)
	}
}

func (s *Store) blobPaths(key string) (string, string) {
	sum := sha256.Sum256([]byte(key))
	name := hex.EncodeToString(sum[:])
	dir := filepath.Join(s.dir, "blobs", name[:2])
	return filepath.Join(dir, name+".meta.json"), filepath.Join(dir, name+".body")
}

func (s *Store) writeBlob(key string, entry Entry) {
	if s.dir == "" {
		return
	}
	metaPath, bodyPath := s.blobPaths(key)
	if err := os.MkdirAll(filepath.Dir(metaPath), 0o755); err != nil {
		return
	}
	meta := struct {
		ContentType string            `json:"contentType"`
		Header      map[string]string `json:"header,omitempty"`
		FreshUntil  time.Time         `json:"freshUntil"`
		StaleUntil  time.Time         `json:"staleUntil"`
	}{entry.ContentType, entry.Header, entry.FreshUntil, entry.StaleUntil}
	payload, err := json.Marshal(meta)
	if err != nil {
		return
	}
	if err := writeAtomic(bodyPath, entry.Body); err != nil {
		return
	}
	_ = writeAtomic(metaPath, payload)
}

func (s *Store) readBlob(key string) (Entry, bool) {
	if s.dir == "" {
		return Entry{}, false
	}
	metaPath, bodyPath := s.blobPaths(key)
	raw, err := os.ReadFile(metaPath)
	if err != nil {
		return Entry{}, false
	}
	var meta struct {
		ContentType string            `json:"contentType"`
		Header      map[string]string `json:"header"`
		FreshUntil  time.Time         `json:"freshUntil"`
		StaleUntil  time.Time         `json:"staleUntil"`
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		return Entry{}, false
	}
	if !meta.StaleUntil.IsZero() && time.Now().After(meta.StaleUntil) {
		return Entry{}, false
	}
	body, err := os.ReadFile(bodyPath)
	if err != nil {
		return Entry{}, false
	}
	return Entry{
		Body:        body,
		ContentType: meta.ContentType,
		Header:      meta.Header,
		FreshUntil:  meta.FreshUntil,
		StaleUntil:  meta.StaleUntil,
	}, true
}

func writeAtomic(path string, payload []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

type flightCall struct {
	done chan struct{}
	val  any
	err  error
}

type flightGroup struct {
	mu    sync.Mutex
	calls map[string]*flightCall
}

func (g *flightGroup) Do(key string, fn func() (any, error)) (any, error) {
	g.mu.Lock()
	if g.calls == nil {
		g.calls = map[string]*flightCall{}
	}
	if call, ok := g.calls[key]; ok {
		g.mu.Unlock()
		<-call.done
		return call.val, call.err
	}
	call := &flightCall{done: make(chan struct{})}
	g.calls[key] = call
	g.mu.Unlock()

	call.val, call.err = fn()
	close(call.done)

	g.mu.Lock()
	delete(g.calls, key)
	g.mu.Unlock()
	return call.val, call.err
}
