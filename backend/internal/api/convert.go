package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"enise-docs/backend/internal/cache"
	"enise-docs/backend/internal/catalog"
)

func (s *Server) handleOfficeStatus(w http.ResponseWriter, r *http.Request) error {
	return s.featureStatus(w, r, s.cfg.OfficeConvertURL, "La conversion PDF n’est pas configurée.")
}

func (s *Server) handleModel3DStatus(w http.ResponseWriter, r *http.Request) error {
	return s.featureStatus(w, r, s.cfg.Model3DConvertURL, "La conversion 3D n’est pas configurée.")
}

func (s *Server) handleSolidworksStatus(w http.ResponseWriter, r *http.Request) error {
	return s.featureStatus(w, r, s.cfg.SolidworksConvertURL, "La conversion SolidWorks → STEP n’est pas configurée.")
}

func (s *Server) featureStatus(w http.ResponseWriter, r *http.Request, endpoint, missing string) error {
	if endpoint == "" {
		writeJSON(w, r, http.StatusOK, map[string]string{
			"status": "not-configured",
			"error":  missing,
		}, "public, max-age=300", nil)
		return nil
	}
	writeJSON(w, r, http.StatusOK, map[string]string{"status": "ready"}, "public, max-age=300", nil)
	return nil
}

func (s *Server) handleOfficePDF(w http.ResponseWriter, r *http.Request) error {
	filePath, err := catalog.NormalizeFilePath(r.URL.Query().Get("path"))
	if err != nil {
		return err
	}
	extension := catalog.Extension(filePath)
	if !catalog.IsOfficeConvertible(extension) {
		return catalog.Error(400, "Ce format ne peut pas être converti en PDF.")
	}
	if s.cfg.OfficeConvertURL == "" {
		writeJSON(w, r, http.StatusNotImplemented, map[string]string{
			"error":  "La conversion PDF n’est pas configurée sur ce site.",
			"status": "not-configured",
		}, "no-store", nil)
		return nil
	}
	sourceKey := catalog.MakeSourceKey(filePath, catalog.NormalizeNumericParam(r.URL.Query().Get("size")), r.URL.Query().Get("mtime"), "office-pdf:")
	cacheKey := "office:" + s.cfg.BucketID + ":" + sourceKey
	if entry, freshness := s.cache.GetBlob(cacheKey); freshness != "" {
		s.writeBinary(w, r, entry, pdfName(filePath), "application/pdf", "HIT", nil)
		return nil
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	source, err := s.downloadLimited(ctx, filePath, s.cfg.MaxOfficeBytes)
	if err != nil {
		return err
	}
	filename := pathBase(filePath)
	body, contentType, err := multipartFile(map[string]string{}, filename, source)
	if err != nil {
		return catalog.Error(500, "Préparation de la conversion impossible.")
	}
	converted, meta, err := s.postConvert(ctx, s.cfg.OfficeConvertURL+"/api/convert-office", body, contentType, nil)
	if err != nil {
		return translateOfficeError(err)
	}
	if len(converted) < 5 || string(converted[:5]) != "%PDF-" {
		return catalog.Error(502, "Le service de conversion n’a pas renvoyé un PDF valide.")
	}
	entry := cache.Entry{
		Body:        converted,
		ContentType: "application/pdf",
		FreshUntil:  time.Now().Add(s.cfg.OfficePDFTTL),
		StaleUntil:  time.Now().Add(s.cfg.OfficePDFTTL + s.cfg.StaleGrace),
	}
	if int64(len(converted)) <= s.cfg.MaxOfficeBytes {
		s.cache.PutBlob(cacheKey, entry)
	}
	s.writeBinary(w, r, entry, pdfName(filePath), "application/pdf", "MISS", meta)
	return nil
}

func (s *Server) handleModel3DGLB(w http.ResponseWriter, r *http.Request) error {
	filePath, err := catalog.NormalizeFilePath(r.URL.Query().Get("path"))
	if err != nil {
		return err
	}
	if !catalog.IsModelGLBExtension(catalog.Extension(filePath)) {
		return catalog.Error(400, "Ce format ne peut pas être converti en GLB.")
	}
	quality := strings.ToLower(r.URL.Query().Get("quality"))
	if quality == "" {
		quality = "standard"
	}
	if !catalog.IsModel3DQuality(quality) {
		return catalog.Error(400, "Qualité inconnue (draft, standard ou fine attendue).")
	}
	if s.cfg.Model3DConvertURL == "" {
		writeJSON(w, r, http.StatusNotImplemented, map[string]string{
			"error":  "La conversion 3D n’est pas configurée sur ce site.",
			"status": "not-configured",
		}, "no-store", nil)
		return nil
	}
	sourceKey := catalog.MakeModel3DSourceKey(filePath, catalog.NormalizeNumericParam(r.URL.Query().Get("size")), r.URL.Query().Get("mtime"), quality)
	cacheKey := "model3d:" + s.cfg.BucketID + ":" + sourceKey
	if entry, freshness := s.cache.GetBlob(cacheKey); freshness != "" {
		s.writeBinary(w, r, entry, glbName(filePath), "model/gltf-binary", "HIT", entry.Header)
		return nil
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	source, err := s.downloadLimited(ctx, filePath, s.cfg.MaxModel3DBytes)
	if err != nil {
		return err
	}
	body, contentType, err := multipartFile(map[string]string{"quality": quality}, pathBase(filePath), source)
	if err != nil {
		return catalog.Error(500, "Préparation de la conversion impossible.")
	}
	converted, meta, err := s.postConvert(ctx, s.cfg.Model3DConvertURL+"/api/convert-3d", body, contentType, nil)
	if err != nil {
		return translateModelError(err)
	}
	if len(converted) < 4 || string(converted[:4]) != "glTF" {
		return catalog.Error(502, "Le service de conversion n’a pas renvoyé un GLB valide.")
	}
	entry := cache.Entry{
		Body:        converted,
		ContentType: "model/gltf-binary",
		Header:      meta,
		FreshUntil:  time.Now().Add(s.cfg.Model3DTTL),
		StaleUntil:  time.Now().Add(s.cfg.Model3DTTL + s.cfg.StaleGrace),
	}
	if int64(len(converted)) <= s.cfg.MaxModel3DBytes {
		s.cache.PutBlob(cacheKey, entry)
	}
	s.writeBinary(w, r, entry, glbName(filePath), "model/gltf-binary", "MISS", meta)
	return nil
}

func translateOfficeError(err error) error {
	httpErr, ok := err.(*catalog.HTTPError)
	if !ok {
		return err
	}
	switch httpErr.Status {
	case 413:
		return httpErr
	case 400, 422:
		return catalog.Error(422, "Document non convertible : "+httpErr.Message)
	default:
		if strings.HasPrefix(httpErr.Message, "Connexion") {
			return httpErr
		}
		return catalog.Error(httpErr.Status, "Conversion PDF : "+httpErr.Message)
	}
}

func translateModelError(err error) error {
	httpErr, ok := err.(*catalog.HTTPError)
	if !ok {
		return err
	}
	switch httpErr.Status {
	case 413:
		return httpErr
	case 400, 422:
		return catalog.Error(422, "Modèle non convertible : "+httpErr.Message)
	default:
		if strings.HasPrefix(httpErr.Message, "Conversion 3D") || strings.HasPrefix(httpErr.Message, "Connexion") {
			return httpErr
		}
		return catalog.Error(httpErr.Status, "Conversion 3D : "+httpErr.Message)
	}
}

type solidworksDependency struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	bytes  []byte
}

func (s *Server) handleSolidworksStep(w http.ResponseWriter, r *http.Request) error {
	filePath, err := catalog.NormalizeFilePath(r.URL.Query().Get("path"))
	if err != nil {
		return err
	}
	if !catalog.IsSolidworksExtension(catalog.Extension(filePath)) {
		return catalog.Error(400, "Seuls les fichiers .sldprt et .sldasm peuvent être exportés en STEP.")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Minute)
	defer cancel()
	source, err := s.downloadLimited(ctx, filePath, s.cfg.MaxSolidworksBytes)
	if err != nil {
		return err
	}
	sourceSHA := sha256Hex(source)
	dependencies, err := s.collectSolidworksDependencies(ctx, filePath, int64(len(source)))
	if err != nil {
		return err
	}
	manifestDeps := make([]solidworksDependency, len(dependencies))
	for i, dependency := range dependencies {
		manifestDeps[i] = solidworksDependency{Path: dependency.Path, SHA256: dependency.SHA256}
	}
	outputPath := catalog.BuildSolidworksStepPath(filePath)
	manifestPath := catalog.BuildSolidworksManifestPath(filePath)
	originalPath := catalog.BuildSolidworksOriginalStepPath(filePath)
	originalManifest := catalog.BuildSolidworksOriginalManifestPath(filePath)
	if r.URL.Query().Get("force") != "1" {
		for _, candidate := range []struct{ step, manifest string }{
			{outputPath, manifestPath},
			{originalPath, originalManifest},
		} {
			manifest, ok := s.readSolidworksManifest(ctx, candidate.manifest)
			if ok && manifest.SourceSHA256 == sourceSHA && sameDependencies(manifest.Dependencies, manifestDeps) {
				writeJSON(w, r, http.StatusOK, map[string]any{
					"status":       "success",
					"cached":       true,
					"sourcePath":   filePath,
					"sourceSha256": sourceSHA,
					"dependencies": manifestDeps,
					"stepPath":     candidate.step,
					"manifestPath": candidate.manifest,
					"downloadUrl":  solidworksDownloadURL(candidate.step),
					"size":         manifest.Size,
				}, "no-store", nil)
				return nil
			}
		}
	}
	if s.cfg.SolidworksConvertURL == "" {
		writeJSON(w, r, http.StatusNotImplemented, map[string]string{
			"status": "not-configured",
			"error":  "La conversion SolidWorks → STEP n’est pas configurée sur ce site.",
		}, "no-store", nil)
		return nil
	}
	fields := map[string]string{
		"source_path":         filePath,
		"source_sha256":       sourceSHA,
		"dependency_manifest": mustJSONString(manifestDeps),
		"output_path":         outputPath,
	}
	body, contentType, err := multipartSolidworks(pathBase(filePath), source, fields, dependencies)
	if err != nil {
		return catalog.Error(500, "Préparation de la conversion impossible.")
	}
	headers := map[string]string{"Accept": "application/json"}
	if s.cfg.SolidworksToken != "" {
		headers["Authorization"] = "Bearer " + s.cfg.SolidworksToken
	}
	payload, _, err := s.postConvert(ctx, s.cfg.SolidworksConvertURL+"/api/convert-solidworks-step", body, contentType, headers)
	if err != nil {
		return translateSolidworksError(err)
	}
	var converted map[string]any
	if json.Unmarshal(payload, &converted) != nil || converted["status"] != "success" || converted["stepPath"] == "" {
		return catalog.Error(502, "Le convertisseur HOOPS n’a pas confirmé l’enregistrement du STEP.")
	}
	stepPath, _ := converted["stepPath"].(string)
	manifestOut, _ := converted["manifestPath"].(string)
	if manifestOut == "" {
		manifestOut = manifestPath
	}
	converted["sourcePath"] = filePath
	converted["sourceSha256"] = sourceSHA
	converted["dependencies"] = manifestDeps
	converted["stepPath"] = stepPath
	converted["manifestPath"] = manifestOut
	converted["downloadUrl"] = solidworksDownloadURL(stepPath)
	converted["cached"] = false
	writeJSON(w, r, http.StatusOK, converted, "no-store", nil)
	return nil
}

type storedManifest struct {
	SourceSHA256 string                 `json:"sourceSha256"`
	Dependencies []solidworksDependency `json:"dependencies"`
	Size         any                    `json:"size"`
}

func (s *Server) readSolidworksManifest(ctx context.Context, manifestPath string) (storedManifest, bool) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, catalog.BuildHfFileURL(s.cfg.HFOrigin, s.cfg.BucketID, manifestPath), nil)
	if err != nil {
		return storedManifest{}, false
	}
	request.Header = s.hfHeaders("application/json")
	response, err := s.do(request)
	if err != nil {
		return storedManifest{}, false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return storedManifest{}, false
	}
	var manifest storedManifest
	if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&manifest) != nil {
		return storedManifest{}, false
	}
	return manifest, true
}

func (s *Server) collectSolidworksDependencies(ctx context.Context, filePath string, initialBytes int64) ([]solidworksDependency, error) {
	if catalog.Extension(filePath) != "sldasm" {
		return []solidworksDependency{}, nil
	}
	parent := pathDir(filePath)
	if initialBytes > s.cfg.MaxSolidworksBundle {
		return nil, catalog.Error(413, "Le fichier de l’assemblage dépasse la limite de "+itoaMiB(s.cfg.MaxSolidworksBundle)+" Mo.")
	}
	var items []catalog.BucketItem
	var complete bool
	var err error
	if doc, _, state := s.cache.Index(); doc != nil && doc.Complete && state != "" {
		items = doc.Items
		complete = true
	} else {
		items, complete, err = s.fetchTree(ctx, parent, true)
		if err != nil {
			return nil, err
		}
	}
	if !complete {
		return nil, catalog.Error(413, "Le dossier de l’assemblage contient trop de fichiers pour transférer ses dépendances.")
	}
	candidates := make([]string, 0)
	for _, item := range items {
		if item.Type == "directory" || item.Path == "" {
			continue
		}
		candidate := strings.TrimLeft(item.Path, "/")
		if candidate == filePath {
			continue
		}
		if parent != "" && !strings.HasPrefix(candidate, parent+"/") {
			continue
		}
		if catalog.IsSolidworksExtension(catalog.Extension(candidate)) {
			candidates = append(candidates, candidate)
		}
	}
	sort.Strings(candidates)
	if len(candidates) > s.cfg.MaxSolidworksFiles {
		return nil, catalog.Error(413, "L’assemblage référence trop de fichiers SolidWorks (limite "+strconv.Itoa(s.cfg.MaxSolidworksFiles)+").")
	}
	results := make([]solidworksDependency, len(candidates))
	errCh := make(chan error, len(candidates))
	sem := make(chan struct{}, 4)
	for i, candidate := range candidates {
		sem <- struct{}{}
		go func(index int, candidate string) {
			defer func() { <-sem }()
			payload, err := s.downloadLimited(ctx, candidate, s.cfg.MaxSolidworksBytes)
			if err != nil {
				errCh <- err
				return
			}
			relative := candidate
			if parent != "" {
				relative = strings.TrimPrefix(candidate, parent+"/")
			}
			results[index] = solidworksDependency{
				Path:   relative,
				SHA256: sha256Hex(payload),
				bytes:  payload,
			}
			errCh <- nil
		}(i, candidate)
	}
	var first error
	for range candidates {
		if err := <-errCh; err != nil && first == nil {
			first = err
		}
	}
	if first != nil {
		return nil, first
	}
	total := initialBytes
	for _, dependency := range results {
		total += int64(len(dependency.bytes))
		if total > s.cfg.MaxSolidworksBundle {
			return nil, catalog.Error(413, "Les dépendances de l’assemblage dépassent la limite de "+itoaMiB(s.cfg.MaxSolidworksBundle)+" Mo.")
		}
	}
	return results, nil
}

func sameDependencies(recorded, current []solidworksDependency) bool {
	if recorded == nil {
		return false
	}
	left, _ := json.Marshal(normalizeDeps(recorded))
	right, _ := json.Marshal(normalizeDeps(current))
	return bytes.Equal(left, right)
}

func normalizeDeps(values []solidworksDependency) []solidworksDependency {
	out := make([]solidworksDependency, len(values))
	for i, value := range values {
		out[i] = solidworksDependency{Path: value.Path, SHA256: value.SHA256}
	}
	return out
}

func (s *Server) postConvert(ctx context.Context, endpoint string, body *bytes.Buffer, contentType string, headers map[string]string) ([]byte, map[string]string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, body)
	if err != nil {
		return nil, nil, catalog.Error(502, "Connexion au service de conversion impossible.")
	}
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Accept", "application/json, application/pdf, application/octet-stream, model/gltf-binary")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := s.convertClient.Do(request)
	if err != nil {
		return nil, nil, catalog.Error(502, "Connexion au service de conversion impossible.")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, nil, upstreamError(response, "La conversion a échoué.", 300)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, 80<<20))
	if err != nil {
		return nil, nil, catalog.Error(502, "Connexion au service de conversion impossible.")
	}
	meta := map[string]string{}
	if value := response.Header.Get("X-Model3D-Meta"); value != "" {
		meta["X-Model3D-Meta"] = value
	}
	return payload, meta, nil
}

func (s *Server) writeBinary(w http.ResponseWriter, r *http.Request, entry cache.Entry, filename, contentType, cacheStatus string, extra map[string]string) {
	header := w.Header()
	applyAPISecurity(header)
	if contentType == "" {
		contentType = entry.ContentType
	}
	header.Set("Content-Type", contentType)
	header.Set("Content-Disposition", catalog.ContentDisposition(filename, false))
	header.Set("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400")
	header.Set("X-Cache-Status", cacheStatus)
	for key, value := range entry.Header {
		header.Set(key, value)
	}
	for key, value := range extra {
		header.Set(key, value)
	}
	header.Set("Content-Length", strconv.Itoa(len(entry.Body)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(entry.Body)
	}
}

func multipartFile(fields map[string]string, filename string, payload []byte) (*bytes.Buffer, string, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		return nil, "", err
	}
	if _, err := part.Write(payload); err != nil {
		return nil, "", err
	}
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			return nil, "", err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return &body, writer.FormDataContentType(), nil
}

func multipartSolidworks(filename string, payload []byte, fields map[string]string, dependencies []solidworksDependency) (*bytes.Buffer, string, error) {
	var rebuilt bytes.Buffer
	writer := multipart.NewWriter(&rebuilt)
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		return nil, "", err
	}
	if _, err := part.Write(payload); err != nil {
		return nil, "", err
	}
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			return nil, "", err
		}
	}
	for _, dependency := range dependencies {
		header := make(textproto.MIMEHeader)
		header.Set("Content-Disposition", `form-data; name="dependencies"; filename="`+escapeQuotes(dependency.Path)+`"`)
		header.Set("Content-Type", "application/octet-stream")
		depPart, err := writer.CreatePart(header)
		if err != nil {
			return nil, "", err
		}
		if _, err := depPart.Write(dependency.bytes); err != nil {
			return nil, "", err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return &rebuilt, writer.FormDataContentType(), nil
}

func escapeQuotes(value string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value)
}

func translateSolidworksError(err error) error {
	httpErr, ok := err.(*catalog.HTTPError)
	if !ok {
		return err
	}
	switch httpErr.Status {
	case 413, 501, 504:
		return httpErr
	case 400, 422:
		return catalog.Error(422, "Fichier SolidWorks non convertible : "+httpErr.Message)
	default:
		return catalog.Error(httpErr.Status, "Conversion SolidWorks : "+httpErr.Message)
	}
}

func solidworksDownloadURL(stepPath string) string {
	return "/api/file?path=" + url.QueryEscape(stepPath) + "&download=1"
}

func sha256Hex(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func pdfName(filePath string) string {
	return catalog.ReplaceExtension(filePath, ".pdf")
}

func glbName(filePath string) string {
	return catalog.ReplaceExtension(filePath, ".glb")
}

func pathBase(filePath string) string {
	if i := strings.LastIndex(filePath, "/"); i >= 0 {
		filePath = filePath[i+1:]
	}
	if filePath == "" {
		return "document"
	}
	return filePath
}

func pathDir(filePath string) string {
	i := strings.LastIndex(filePath, "/")
	if i < 0 {
		return ""
	}
	return filePath[:i]
}

func mustJSONString(value any) string {
	payload, _ := json.Marshal(value)
	return string(payload)
}

func itoaMiB(value int64) string {
	return strconv.FormatInt(value/1024/1024, 10)
}
