package api

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"enise-docs/backend/internal/cache"
	"enise-docs/backend/internal/catalog"
)

const apsBaseURL = "https://developer.api.autodesk.com"

type tokenCache struct {
	mu     sync.Mutex
	tokens map[string]cachedToken
}

type cachedToken struct {
	value  string
	expiry time.Time
}

type apsRecord struct {
	Path      string `json:"path"`
	ObjectKey string `json:"objectKey"`
	ObjectID  string `json:"objectId"`
	URN       string `json:"urn"`
	Status    string `json:"status"`
	Progress  int    `json:"progress"`
	Message   string `json:"message"`
	UpdatedAt string `json:"updatedAt"`
}

func (s *Server) handleApsToken(w http.ResponseWriter, r *http.Request) error {
	if !s.cfg.ApsConfigured() {
		return s.apsNotConfigured(w, r)
	}
	token, expires, err := s.apsToken(r.Context(), "viewables:read")
	if err != nil {
		return err
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"access_token": token,
		"expires_in":   expires,
		"token_type":   "Bearer",
	}, "no-store", map[string]string{"X-APS-Status": "ready"})
	return nil
}

func (s *Server) handleApsStatus(w http.ResponseWriter, r *http.Request) error {
	if !s.cfg.ApsConfigured() {
		return s.apsNotConfigured(w, r)
	}
	filePath, size, mtime, err := s.apsQuery(r)
	if err != nil {
		return err
	}
	record, ok := s.readApsRecord(filePath, size, mtime)
	if !ok || record.URN == "" {
		writeJSON(w, r, http.StatusOK, map[string]string{
			"status":  "missing",
			"message": "Aucune traduction 3D enregistrée pour ce fichier.",
		}, "no-store", nil)
		return nil
	}
	token, _, err := s.apsToken(r.Context(), "")
	if err != nil {
		return err
	}
	updated, cacheStatus, err := s.refreshApsRecord(r.Context(), filePath, size, mtime, record, token)
	if err != nil {
		return err
	}
	writeJSON(w, r, http.StatusOK, apsClientView(updated, cacheStatus), "no-store", nil)
	return nil
}

func (s *Server) handleApsView(w http.ResponseWriter, r *http.Request) error {
	if !s.cfg.ApsConfigured() {
		return s.apsNotConfigured(w, r)
	}
	filePath, size, mtime, err := s.apsQuery(r)
	if err != nil {
		return err
	}
	force := r.URL.Query().Get("force") == "1"
	token, _, err := s.apsToken(r.Context(), "")
	if err != nil {
		return err
	}
	if existing, ok := s.readApsRecord(filePath, size, mtime); ok && !force && (existing.Status == "success" || existing.URN != "") {
		refreshed, cacheStatus, err := s.refreshApsRecord(r.Context(), filePath, size, mtime, existing, token)
		if err != nil {
			return err
		}
		if refreshed.Status != "expired" {
			writeJSON(w, r, http.StatusOK, apsClientView(refreshed, cacheStatus), "no-store", nil)
			return nil
		}
	}
	record, err := s.startApsTranslation(r.Context(), filePath, size, mtime, token, force)
	if err != nil {
		return err
	}
	writeJSON(w, r, http.StatusOK, apsClientView(record, "new"), "no-store", nil)
	return nil
}

func (s *Server) apsNotConfigured(w http.ResponseWriter, r *http.Request) error {
	writeJSON(w, r, http.StatusNotImplemented, map[string]string{
		"error":  "Autodesk APS non configuré.",
		"status": "not-configured",
	}, "no-store", nil)
	return nil
}

func (s *Server) apsQuery(r *http.Request) (string, string, string, error) {
	filePath, err := catalog.NormalizeFilePath(r.URL.Query().Get("path"))
	if err != nil {
		return "", "", "", err
	}
	return filePath, catalog.NormalizeNumericParam(r.URL.Query().Get("size")), r.URL.Query().Get("mtime"), nil
}

func (s *Server) apsToken(ctx context.Context, scope string) (string, int, error) {
	if scope == "" {
		scope = "bucket:create bucket:read data:read data:write viewables:read"
	}
	s.tokens.mu.Lock()
	if s.tokens.tokens != nil {
		if cached, ok := s.tokens.tokens[scope]; ok && time.Now().Before(cached.expiry) {
			s.tokens.mu.Unlock()
			return cached.value, int(time.Until(cached.expiry).Seconds()) + 60, nil
		}
	}
	s.tokens.mu.Unlock()

	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("client_id", s.cfg.ApsClientID)
	form.Set("client_secret", s.cfg.ApsClientSecret)
	form.Set("scope", scope)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, apsBaseURL+"/authentication/v2/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", 0, catalog.Error(502, "Connexion à Autodesk APS impossible.")
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	response, err := s.client.Do(request)
	if err != nil {
		return "", 0, catalog.Error(502, "Connexion à Autodesk APS impossible.")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", 0, apsHTTPError(response, "Authentification Autodesk refusée.")
	}
	var payload struct {
		AccessToken string  `json:"access_token"`
		ExpiresIn   float64 `json:"expires_in"`
	}
	if json.NewDecoder(response.Body).Decode(&payload) != nil || payload.AccessToken == "" {
		return "", 0, catalog.Error(502, "Autodesk APS n’a pas renvoyé de jeton d’accès.")
	}
	expires := int(payload.ExpiresIn)
	if expires < 60 {
		expires = 3600
	}
	s.tokens.mu.Lock()
	if s.tokens.tokens == nil {
		s.tokens.tokens = map[string]cachedToken{}
	}
	s.tokens.tokens[scope] = cachedToken{value: payload.AccessToken, expiry: time.Now().Add(time.Duration(expires-60) * time.Second)}
	s.tokens.mu.Unlock()
	return payload.AccessToken, expires, nil
}

func (s *Server) apsBucketKey() string {
	if s.cfg.ApsBucketKey != "" {
		return s.cfg.ApsBucketKey
	}
	return "enise-docs-3d-" + catalog.HashIdentifier(s.cfg.ApsClientID)[:10]
}

func (s *Server) startApsTranslation(ctx context.Context, filePath, size, mtime, token string, force bool) (apsRecord, error) {
	sourceKey := catalog.MakeSourceKey(filePath, size, mtime, "aps:")
	bucketKey, err := s.ensureApsBucket(ctx, token)
	if err != nil {
		return apsRecord{}, err
	}
	objectKey := catalog.BuildApsObjectKey(filePath, sourceKey)
	objectID, err := s.uploadApsObject(ctx, token, bucketKey, objectKey, filePath)
	if err != nil {
		return apsRecord{}, err
	}
	encoded := base64.StdEncoding.EncodeToString([]byte(objectID))
	encoded = strings.TrimRight(strings.NewReplacer("+", "-", "/", "_").Replace(encoded), "=")
	body, _ := json.Marshal(map[string]any{
		"input":  map[string]any{"urn": encoded, "compressedUrn": false},
		"output": map[string]any{"formats": []map[string]any{{"type": "svf2", "views": []string{"2d", "3d"}}}},
	})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, apsBaseURL+"/modelderivative/v2/designdata/job", bytes.NewReader(body))
	if err != nil {
		return apsRecord{}, catalog.Error(502, "Démarrage de la conversion 3D Autodesk impossible.")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	if force {
		request.Header.Set("x-ads-force", "true")
	}
	response, err := s.client.Do(request)
	if err != nil {
		return apsRecord{}, catalog.Error(502, "Démarrage de la conversion 3D Autodesk impossible.")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return apsRecord{}, apsHTTPError(response, "Autodesk a refusé la conversion du fichier.")
	}
	var job struct {
		URN string `json:"urn"`
	}
	if json.NewDecoder(response.Body).Decode(&job) != nil || job.URN == "" {
		return apsRecord{}, catalog.Error(502, "Autodesk n’a pas renvoyé d’identifiant de conversion.")
	}
	record := apsRecord{
		Path:      filePath,
		ObjectKey: objectKey,
		ObjectID:  objectID,
		URN:       job.URN,
		Status:    "inprogress",
		Progress:  0,
		Message:   "Conversion 3D démarrée.",
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}
	s.storeApsRecord(filePath, size, mtime, record)
	return record, nil
}

func (s *Server) ensureApsBucket(ctx context.Context, token string) (string, error) {
	bucketKey := s.apsBucketKey()
	detail, err := s.apsJSON(ctx, http.MethodGet, apsBaseURL+"/oss/v2/buckets/"+url.PathEscape(bucketKey)+"/details", token, nil)
	if err == nil && detail != nil {
		return bucketKey, nil
	}
	created, err := s.apsJSON(ctx, http.MethodPost, apsBaseURL+"/oss/v2/buckets", token, map[string]string{
		"bucketKey": bucketKey,
		"policyKey": "transient",
	})
	if err == nil && created != nil {
		return bucketKey, nil
	}
	var httpErr *catalog.HTTPError
	if ok := errorAs(err, &httpErr); ok && httpErr.Status == http.StatusConflict {
		if _, err := s.apsJSON(ctx, http.MethodGet, apsBaseURL+"/oss/v2/buckets/"+url.PathEscape(bucketKey)+"/details", token, nil); err == nil {
			return bucketKey, nil
		}
		return "", catalog.Error(502, "Le panier Autodesk existe déjà et n’appartient pas à cette application.")
	}
	if err != nil {
		return "", err
	}
	return "", catalog.Error(502, "Création du panier Autodesk refusée.")
}

func (s *Server) uploadApsObject(ctx context.Context, token, bucketKey, objectKey, filePath string) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, catalog.BuildHfFileURL(s.cfg.HFOrigin, s.cfg.BucketID, filePath), nil)
	if err != nil {
		return "", catalog.Error(502, "Connexion au stockage Hugging Face interrompue.")
	}
	request.Header = s.hfHeaders("*/*")
	source, err := s.do(request)
	if err != nil {
		return "", catalog.Error(502, "Connexion au stockage Hugging Face interrompue.")
	}
	defer source.Body.Close()
	if source.StatusCode == http.StatusNotFound {
		return "", catalog.Error(404, "Document 3D introuvable dans le bucket Hugging Face.")
	}
	if source.StatusCode < 200 || source.StatusCode >= 300 {
		status := source.StatusCode
		if status >= 500 {
			status = 502
		}
		return "", catalog.Error(status, "Impossible de lire le fichier 3D pour Autodesk.")
	}
	if source.ContentLength > s.cfg.MaxApsBytes {
		return "", catalog.Error(413, "Ce fichier est trop volumineux pour Autodesk (limite "+itoaMiB(s.cfg.MaxApsBytes)+" Mo).")
	}
	signedURL := apsBaseURL + "/oss/v2/buckets/" + url.PathEscape(bucketKey) + "/objects/" + url.PathEscape(objectKey) + "/signeds3upload"
	signed, err := s.apsJSON(ctx, http.MethodGet, signedURL, token, nil)
	if err != nil {
		return "", err
	}
	urls, _ := signed["urls"].([]any)
	uploadKey, _ := signed["uploadKey"].(string)
	if len(urls) == 0 || uploadKey == "" {
		return "", catalog.Error(502, "Autodesk n’a pas fourni d’URL de téléversement.")
	}
	uploadURL, _ := urls[0].(string)
	put, err := http.NewRequestWithContext(ctx, http.MethodPut, uploadURL, source.Body)
	if err != nil {
		return "", catalog.Error(502, "Téléversement du fichier vers Autodesk impossible.")
	}
	put.Header.Set("Content-Type", "application/octet-stream")
	if source.ContentLength > 0 {
		put.ContentLength = source.ContentLength
	}
	uploaded, err := s.client.Do(put)
	if err != nil {
		return "", catalog.Error(502, "Téléversement du fichier vers Autodesk impossible.")
	}
	uploaded.Body.Close()
	if uploaded.StatusCode < 200 || uploaded.StatusCode >= 300 {
		return "", catalog.Error(502, "Le téléversement du fichier 3D a échoué.")
	}
	completed, err := s.apsJSON(ctx, http.MethodPost, signedURL, token, map[string]string{"uploadKey": uploadKey})
	if err != nil {
		return "", err
	}
	objectID, _ := completed["objectId"].(string)
	if objectID == "" {
		return "", catalog.Error(502, "Autodesk n’a pas confirmé le fichier téléversé.")
	}
	return objectID, nil
}

func (s *Server) refreshApsRecord(ctx context.Context, filePath, size, mtime string, record apsRecord, token string) (apsRecord, string, error) {
	if record.URN == "" {
		return record, "", nil
	}
	response, err := s.apsGET(ctx, apsBaseURL+"/modelderivative/v2/designdata/"+url.PathEscape(record.URN)+"/manifest", token)
	if err != nil {
		return apsRecord{}, "", catalog.Error(502, "Vérification de la conversion Autodesk impossible.")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		updated := record
		updated.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		cacheStatus := "pending"
		if record.Status == "success" {
			updated.Status = "expired"
			updated.Progress = 0
			updated.Message = "Conversion 3D expirée côté Autodesk, à relancer."
			cacheStatus = "expired"
		} else {
			updated.Status = "inprogress"
			updated.Progress = 0
			updated.Message = "Conversion 3D en attente de démarrage…"
		}
		s.storeApsRecord(filePath, size, mtime, updated)
		return updated, cacheStatus, nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return apsRecord{}, "", apsHTTPError(response, "Autodesk n’a pas pu fournir l’état de conversion.")
	}
	var manifest map[string]any
	if json.NewDecoder(response.Body).Decode(&manifest) != nil {
		return apsRecord{}, "", catalog.Error(502, "État de conversion Autodesk illisible.")
	}
	status := catalog.NormalizeApsStatus(stringField(manifest["status"]))
	fallback := 0
	if status == "success" {
		fallback = 100
	}
	updated := record
	updated.Status = status
	updated.Progress = catalog.ClampProgress(manifest["progress"], fallback)
	updated.Message = describeManifest(manifest, filePath, status)
	updated.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	s.storeApsRecord(filePath, size, mtime, updated)
	return updated, "checked", nil
}

func describeManifest(manifest map[string]any, filePath, status string) string {
	if status == "success" {
		return "Modèle 3D prêt."
	}
	var messages []string
	derivatives, _ := manifest["derivatives"].([]any)
	for _, raw := range derivatives {
		derivative, _ := raw.(map[string]any)
		items, _ := derivative["messages"].([]any)
		for _, item := range items {
			message, _ := item.(map[string]any)
			kind := stringField(message["type"])
			if kind != "error" && kind != "warning" {
				continue
			}
			if text := stringField(message["message"]); text != "" {
				messages = append(messages, text)
			}
		}
	}
	if status == "failed" {
		return catalog.DescribeApsFailure(messages, filePath)
	}
	if progress := stringField(manifest["progress"]); progress != "" {
		return "Conversion en cours (" + strconvItoaSafe(catalog.ClampProgress(manifest["progress"], 0)) + " %)."
	}
	return "Conversion en cours…"
}

func (s *Server) readApsRecord(filePath, size, mtime string) (apsRecord, bool) {
	entry, freshness := s.cache.GetBlob(s.apsCacheKey(filePath, size, mtime))
	if freshness == "" {
		return apsRecord{}, false
	}
	var record apsRecord
	if json.Unmarshal(entry.Body, &record) != nil {
		return apsRecord{}, false
	}
	return record, true
}

func (s *Server) storeApsRecord(filePath, size, mtime string, record apsRecord) {
	payload, err := json.Marshal(record)
	if err != nil {
		return
	}
	s.cache.PutBlob(s.apsCacheKey(filePath, size, mtime), cache.Entry{
		Body:        payload,
		ContentType: "application/json",
		FreshUntil:  time.Now().Add(s.cfg.ApsTTL),
		StaleUntil:  time.Now().Add(s.cfg.ApsTTL + s.cfg.StaleGrace),
	})
}

func (s *Server) apsCacheKey(filePath, size, mtime string) string {
	return "aps:" + s.cfg.BucketID + ":" + catalog.MakeSourceKey(filePath, size, mtime, "aps:")
}

func apsClientView(record apsRecord, cacheStatus string) map[string]any {
	var urn any
	if record.URN != "" {
		urn = record.URN
	}
	view := map[string]any{
		"status":    record.Status,
		"urn":       urn,
		"progress":  record.Progress,
		"message":   record.Message,
		"updatedAt": record.UpdatedAt,
	}
	if cacheStatus != "" {
		view["cacheStatus"] = cacheStatus
	}
	return view
}

func (s *Server) apsJSON(ctx context.Context, method, endpoint, token string, body any) (map[string]any, error) {
	response, err := s.apsSend(ctx, method, endpoint, token, body)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, apsHTTPError(response, "Autodesk APS : requête refusée.")
	}
	if response.StatusCode == http.StatusNoContent || response.ContentLength == 0 {
		return map[string]any{}, nil
	}
	var payload map[string]any
	if json.NewDecoder(response.Body).Decode(&payload) != nil {
		return map[string]any{}, nil
	}
	return payload, nil
}

func (s *Server) apsGET(ctx context.Context, endpoint, token string) (*http.Response, error) {
	return s.apsSend(ctx, http.MethodGet, endpoint, token, nil)
}

func (s *Server) apsSend(ctx context.Context, method, endpoint, token string, body any) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(payload)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return nil, catalog.Error(502, "Connexion à Autodesk APS impossible.")
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := s.client.Do(request)
	if err != nil {
		return nil, catalog.Error(502, "Connexion à Autodesk APS impossible.")
	}
	return response, nil
}

func apsHTTPError(response *http.Response, fallback string) *catalog.HTTPError {
	err := upstreamError(response, fallback, 500)
	if strings.HasPrefix(err.Message, "Autodesk APS") {
		return err
	}
	return catalog.Error(err.Status, "Autodesk APS : "+err.Message)
}

func stringField(value any) string {
	text, _ := value.(string)
	return text
}

func errorAs(err error, target **catalog.HTTPError) bool {
	httpErr, ok := err.(*catalog.HTTPError)
	if !ok {
		return false
	}
	*target = httpErr
	return true
}

func strconvItoaSafe(value int) string {
	if value < 0 {
		return "0"
	}
	digits := []byte{}
	if value == 0 {
		return "0"
	}
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
