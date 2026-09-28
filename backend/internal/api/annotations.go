package api

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"time"

	"enise-docs/backend/internal/appwrite"
	"enise-docs/backend/internal/catalog"
)

const (
	maxAnnotationBody = 4000
	maxAnnotationJSON = 32 << 10
)

var annotationKinds = map[string]bool{
	"highlight": true,
	"note":      true,
	"question":  true,
	"bookmark":  true,
}

var annotationColors = map[string]bool{
	"yellow": true,
	"green":  true,
	"blue":   true,
	"pink":   true,
}

func (s *Server) handleAnnotations(w http.ResponseWriter, r *http.Request) error {
	if r.URL.Path == "/api/annotations" {
		switch r.Method {
		case http.MethodGet:
			return s.handleAnnotationList(w, r)
		case http.MethodPost:
			return s.handleAnnotationCreate(w, r)
		default:
			return methodNotAllowed(w, "GET, POST")
		}
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/annotations/")
	if id == "" || strings.Contains(id, "/") || !appwrite.ValidID(id) {
		return catalog.Error(http.StatusNotFound, "Annotation introuvable.")
	}
	switch r.Method {
	case http.MethodPatch:
		return s.handleAnnotationUpdate(w, r, id)
	case http.MethodDelete:
		return s.handleAnnotationDelete(w, r, id)
	default:
		return methodNotAllowed(w, "PATCH, DELETE")
	}
}

func (s *Server) handleAnnotationList(w http.ResponseWriter, r *http.Request) error {
	user, secret, err := s.annotationUser(w, r)
	if err != nil {
		return err
	}
	sourcePath, err := s.readerSourcePath(r)
	if err != nil {
		return err
	}
	if len([]rune(sourcePath)) > 1024 {
		return catalog.Error(http.StatusBadRequest, "Le chemin du document est trop long pour les annotations.")
	}
	artifactID := strings.TrimSpace(r.URL.Query().Get("artifactId"))
	if artifactID == "" || len([]rune(artifactID)) > 160 {
		return catalog.Error(http.StatusBadRequest, "La révision Docling est requise pour charger les annotations.")
	}
	study, err := s.readerStudy(r.Context(), sourcePath, artifactID)
	if err != nil {
		return err
	}
	if !study.ready() || study.ArtifactID == "" {
		return catalog.Error(http.StatusConflict, "Les annotations nécessitent un artefact Docling prêt.")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	items, err := s.appwrite().ListAnnotations(ctx, secret, user.ID, appwrite.DocumentKey(sourcePath))
	if err != nil {
		return s.annotationFail(err)
	}
	public := make([]map[string]any, 0, len(items))
	for _, item := range items {
		public = append(public, publicAnnotation(item, study.ArtifactID))
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok": true, "enabled": true, "artifactId": study.ArtifactID, "items": public,
	}, "no-store", nil)
	return nil
}

func (s *Server) handleAnnotationCreate(w http.ResponseWriter, r *http.Request) error {
	user, secret, err := s.annotationUser(w, r)
	if err != nil {
		return err
	}
	var body struct {
		SourcePath string     `json:"sourcePath"`
		ArtifactID string     `json:"artifactId"`
		Anchor     chatAnchor `json:"anchor"`
		Kind       string     `json:"kind"`
		Color      string     `json:"color"`
		Body       string     `json:"body"`
	}
	if err := decodeJSON(r, &body, maxAnnotationJSON); err != nil {
		return err
	}
	sourcePath, err := catalog.NormalizeFilePath(body.SourcePath)
	if err != nil {
		return err
	}
	if len([]rune(sourcePath)) > 1024 {
		return catalog.Error(http.StatusBadRequest, "Le chemin du document est trop long pour les annotations.")
	}
	if err := validateAnnotationAnchor(&body.Anchor); err != nil {
		return err
	}
	query := r.Clone(r.Context())
	params := query.URL.Query()
	params.Set("path", sourcePath)
	query.URL.RawQuery = params.Encode()
	if _, err := s.readerSourcePath(query); err != nil {
		return err
	}
	artifactID := strings.TrimSpace(body.ArtifactID)
	if artifactID == "" || len([]rune(artifactID)) > 160 {
		return catalog.Error(http.StatusBadRequest, "La révision Docling de l’annotation est requise.")
	}
	kind, color, note, err := normalizeAnnotationFields(body.Kind, body.Color, body.Body)
	if err != nil {
		return err
	}
	resolveCtx, cancel := context.WithTimeout(r.Context(), chatExcerptWait)
	defer cancel()
	study, err := s.prepareDocumentStudy(resolveCtx, chatScope{
		Type:       "document",
		SourcePath: sourcePath,
		ArtifactID: artifactID,
		Anchor:     &body.Anchor,
	}, "Annotation privée", "annotation")
	if err != nil {
		return err
	}
	if !study.ready() || !study.AnchorVerified || study.Anchor == nil {
		return catalog.Error(http.StatusConflict, "Le passage ne peut pas être ancré dans l’artefact Docling courant.")
	}
	if len([]rune(study.Anchor.BlockID)) > 160 || study.Anchor.Page < 1 || study.Anchor.Page > 100000 {
		return catalog.Error(http.StatusBadRequest, "Le bloc ou la page de l’ancre dépasse les limites autorisées.")
	}
	anchorJSON, err := json.Marshal(study.Anchor)
	if err != nil || len(anchorJSON) > 16000 {
		return catalog.Error(http.StatusBadRequest, "L’ancre de sélection est trop volumineuse.")
	}
	ctx, saveCancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer saveCancel()
	created, err := s.appwrite().CreateAnnotation(ctx, secret, user.ID, appwrite.Annotation{
		DocumentKey: appwrite.DocumentKey(sourcePath),
		SourcePath:  sourcePath,
		ArtifactID:  study.ArtifactID,
		BlockID:     study.Anchor.BlockID,
		Page:        study.Anchor.Page,
		AnchorJSON:  string(anchorJSON),
		Kind:        kind,
		Color:       color,
		Body:        note,
		Status:      "active",
	})
	if err != nil {
		return s.annotationFail(err)
	}
	writeJSON(w, r, http.StatusCreated, map[string]any{
		"ok": true, "item": publicAnnotation(created, study.ArtifactID),
	}, "no-store", nil)
	return nil
}

func (s *Server) handleAnnotationUpdate(w http.ResponseWriter, r *http.Request, id string) error {
	user, secret, err := s.annotationUser(w, r)
	if err != nil {
		return err
	}
	var body struct {
		Body   *string `json:"body"`
		Color  *string `json:"color"`
		Status *string `json:"status"`
	}
	if err := decodeJSON(r, &body, maxAnnotationJSON); err != nil {
		return err
	}
	patch := appwrite.AnnotationPatch{}
	if body.Body != nil {
		value := strings.TrimSpace(*body.Body)
		if len([]rune(value)) > maxAnnotationBody {
			return catalog.Error(http.StatusBadRequest, "La note dépasse 4 000 caractères.")
		}
		patch.Body = &value
	}
	if body.Color != nil {
		value := strings.ToLower(strings.TrimSpace(*body.Color))
		if !annotationColors[value] {
			return catalog.Error(http.StatusBadRequest, "Couleur d’annotation invalide.")
		}
		patch.Color = &value
	}
	if body.Status != nil {
		value := strings.ToLower(strings.TrimSpace(*body.Status))
		if value != "active" && value != "archived" {
			return catalog.Error(http.StatusBadRequest, "Statut d’annotation invalide.")
		}
		patch.Status = &value
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	updated, err := s.appwrite().UpdateAnnotation(ctx, secret, user.ID, id, patch)
	if err != nil {
		return s.annotationFail(err)
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok": true, "item": publicAnnotation(updated, updated.ArtifactID),
	}, "no-store", nil)
	return nil
}

func (s *Server) handleAnnotationDelete(w http.ResponseWriter, r *http.Request, id string) error {
	user, secret, err := s.annotationUser(w, r)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := s.appwrite().DeleteAnnotation(ctx, secret, user.ID, id); err != nil {
		return s.annotationFail(err)
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"ok": true}, "no-store", nil)
	return nil
}

func (s *Server) annotationUser(w http.ResponseWriter, r *http.Request) (appwrite.User, string, error) {
	if !s.authReady() || !s.appwrite().HasAnnotations() {
		return appwrite.User{}, "", catalog.Error(http.StatusServiceUnavailable, "Annotations privées non configurées.")
	}
	if !s.authHits.allow("ann:" + s.chatClientKey(r)) {
		w.Header().Set("Retry-After", "60")
		return appwrite.User{}, "", catalog.Error(http.StatusTooManyRequests, "Trop de modifications. Réessaie dans une minute.")
	}
	secret := sessionFrom(r)
	if secret == "" {
		return appwrite.User{}, "", catalog.Error(http.StatusUnauthorized, "Connecte-toi pour utiliser tes annotations privées.")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	user, err := s.appwrite().GetAccount(ctx, secret)
	if err != nil {
		if authStatus(err) == http.StatusUnauthorized {
			clearSessionCookie(w, s.cookieSecure(r))
			return appwrite.User{}, "", catalog.Error(http.StatusUnauthorized, "Session expirée. Reconnecte-toi.")
		}
		return appwrite.User{}, "", s.authFail(err)
	}
	return user, secret, nil
}

func (s *Server) annotationFail(err error) error {
	if appwrite.IsMissingTable(err) {
		return catalog.Error(http.StatusConflict, "La table annotations est absente. Lance npm run appwrite:setup.")
	}
	return s.authFail(err)
}

func validateAnnotationAnchor(anchor *chatAnchor) error {
	if anchor == nil {
		return catalog.Error(http.StatusBadRequest, "L’ancre de sélection est requise.")
	}
	anchor.Quote = strings.Join(strings.Fields(anchor.Quote), " ")
	quoteRunes := len([]rune(anchor.Quote))
	if quoteRunes < 2 || quoteRunes > 2000 {
		return catalog.Error(http.StatusBadRequest, "Le passage sélectionné doit contenir entre 2 et 2 000 caractères.")
	}
	if len([]rune(anchor.BlockID)) > 160 || len([]rune(anchor.Prefix)) > 500 || len([]rune(anchor.Suffix)) > 500 {
		return catalog.Error(http.StatusBadRequest, "Le contexte de l’ancre est trop volumineux.")
	}
	if anchor.Page < 1 || anchor.Page > 100000 || anchor.Start < 0 || anchor.End <= anchor.Start || anchor.End > 10_000_000 {
		return catalog.Error(http.StatusBadRequest, "La page ou les offsets de l’ancre sont invalides.")
	}
	if len(anchor.Rects) == 0 || len(anchor.Rects) > 32 {
		return catalog.Error(http.StatusBadRequest, "L’ancre doit contenir entre 1 et 32 rectangles.")
	}
	for _, rect := range anchor.Rects {
		values := []float64{rect.X, rect.Y, rect.W, rect.H}
		for _, value := range values {
			if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 || value > 1 {
				return catalog.Error(http.StatusBadRequest, "Un rectangle de l’ancre est invalide.")
			}
		}
		if rect.W <= 0 || rect.H <= 0 || rect.X+rect.W > 1.001 || rect.Y+rect.H > 1.001 {
			return catalog.Error(http.StatusBadRequest, "Un rectangle de l’ancre déborde de la page.")
		}
	}
	return nil
}

func normalizeAnnotationFields(kind, color, body string) (string, string, string, error) {
	kind = strings.ToLower(strings.TrimSpace(kind))
	if kind == "" {
		kind = "highlight"
	}
	if !annotationKinds[kind] {
		return "", "", "", catalog.Error(http.StatusBadRequest, "Type d’annotation invalide.")
	}
	color = strings.ToLower(strings.TrimSpace(color))
	if color == "" {
		color = "yellow"
	}
	if !annotationColors[color] {
		return "", "", "", catalog.Error(http.StatusBadRequest, "Couleur d’annotation invalide.")
	}
	body = strings.TrimSpace(body)
	if len([]rune(body)) > maxAnnotationBody {
		return "", "", "", catalog.Error(http.StatusBadRequest, "La note dépasse 4 000 caractères.")
	}
	if kind == "note" && body == "" {
		return "", "", "", catalog.Error(http.StatusBadRequest, "Écris une note avant de l’enregistrer.")
	}
	return kind, color, body, nil
}

func publicAnnotation(item appwrite.Annotation, currentArtifactID string) map[string]any {
	status := item.Status
	if status == "" {
		status = "active"
	}
	if item.ArtifactID != "" && currentArtifactID != "" && item.ArtifactID != currentArtifactID && status == "active" {
		status = "needs-review"
	}
	var anchor chatAnchor
	if json.Unmarshal([]byte(item.AnchorJSON), &anchor) != nil {
		status = "needs-review"
	}
	return map[string]any{
		"id":         item.RowID,
		"sourcePath": item.SourcePath,
		"artifactId": item.ArtifactID,
		"blockId":    item.BlockID,
		"page":       item.Page,
		"anchor":     anchor,
		"kind":       item.Kind,
		"color":      item.Color,
		"body":       item.Body,
		"status":     status,
		"createdAt":  item.CreatedAt,
		"updatedAt":  item.UpdatedAt,
	}
}
