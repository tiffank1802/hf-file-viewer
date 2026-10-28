package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"enise-docs/backend/internal/catalog"
)

// A weak ETag, Last-Modified or a path hash cannot identify PDF bytes safely.
// When no strong validator exists, the reader hashes the bytes it actually
// opened and the server independently hashes the source before a write/chat.
const maxPDFHashBytes int64 = 64 << 20

var pdfRevisionPattern = regexp.MustCompile(`^(etag-sha256|sha256):[0-9a-f]{64}$`)

func strongETagRevision(etag string) string {
	etag = strings.TrimSpace(etag)
	if len(etag) < 2 || len(etag) > 512 || strings.HasPrefix(strings.ToLower(etag), "w/") || etag[0] != '"' || etag[len(etag)-1] != '"' {
		return ""
	}
	sum := sha256.Sum256([]byte(etag))
	return "etag-sha256:" + hex.EncodeToString(sum[:])
}

func validPDFRevision(revision string) bool {
	return pdfRevisionPattern.MatchString(revision)
}

func (s *Server) sourcePDFHead(ctx context.Context, sourcePath string) (string, int64, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, catalog.BuildHfFileURL(s.cfg.HFOrigin, s.cfg.BucketID, sourcePath), nil)
	if err != nil {
		return "", 0, catalog.Error(http.StatusBadGateway, "Impossible de vérifier la version du PDF.")
	}
	request.Header = s.hfHeaders("application/pdf")
	response, err := s.do(request)
	if err != nil {
		return "", 0, catalog.Error(http.StatusBadGateway, "Impossible de vérifier la version du PDF.")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return "", 0, catalog.Error(http.StatusNotFound, "PDF introuvable.")
	}
	if response.StatusCode == http.StatusMethodNotAllowed || response.StatusCode == http.StatusNotImplemented {
		return "", -1, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", 0, catalog.Error(http.StatusBadGateway, "Le stockage ne peut pas vérifier la version du PDF.")
	}
	return strongETagRevision(response.Header.Get("ETag")), response.ContentLength, nil
}

func (s *Server) handlePDFRevision(w http.ResponseWriter, r *http.Request) error {
	sourcePath, err := s.readerSourcePath(r)
	if err != nil {
		return err
	}
	if readerDocumentKind(sourcePath) != "pdf" {
		return catalog.Error(http.StatusBadRequest, "Ce document n’est pas un PDF.")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	revision, size, err := s.sourcePDFHead(ctx, sourcePath)
	if err != nil {
		return err
	}
	strategy := "sha256"
	if revision != "" {
		strategy = "strong-etag"
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"sourcePath": sourcePath, "revision": revision, "strategy": strategy,
		"size": size, "maxHashBytes": maxPDFHashBytes,
	}, "no-store", nil)
	return nil
}

func (s *Server) verifyPDFRevision(ctx context.Context, sourcePath, revision string) error {
	if readerDocumentKind(sourcePath) != "pdf" || !validPDFRevision(revision) {
		return catalog.Error(http.StatusBadRequest, "La révision fiable du PDF est requise.")
	}
	if strings.HasPrefix(revision, "etag-sha256:") {
		current, _, err := s.sourcePDFHead(ctx, sourcePath)
		if err != nil {
			return err
		}
		if current == "" || current != revision {
			return catalog.Error(http.StatusConflict, "Le PDF a changé ou sa version ne peut plus être vérifiée. Rouvre le document.")
		}
		return nil
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, catalog.BuildHfFileURL(s.cfg.HFOrigin, s.cfg.BucketID, sourcePath), nil)
	if err != nil {
		return catalog.Error(http.StatusBadGateway, "Impossible de vérifier l’empreinte du PDF.")
	}
	request.Header = s.hfHeaders("application/pdf")
	response, err := s.do(request)
	if err != nil {
		return catalog.Error(http.StatusBadGateway, "Impossible de vérifier l’empreinte du PDF.")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return catalog.Error(http.StatusBadGateway, "Le stockage ne peut pas vérifier l’empreinte du PDF.")
	}
	if response.ContentLength > maxPDFHashBytes {
		return catalog.Error(http.StatusRequestEntityTooLarge, "Ce PDF dépasse la limite de vérification de 64 Mio sans ETag fort.")
	}
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(response.Body, maxPDFHashBytes+1))
	if err != nil || size <= 0 || size > maxPDFHashBytes || (response.ContentLength >= 0 && size != response.ContentLength) {
		return catalog.Error(http.StatusBadGateway, "La vérification du PDF est incomplète ou le fichier est trop volumineux.")
	}
	if "sha256:"+hex.EncodeToString(hash.Sum(nil)) != revision {
		return catalog.Error(http.StatusConflict, "Le PDF a changé depuis son ouverture. Rouvre le document.")
	}
	return nil
}
