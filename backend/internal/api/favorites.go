package api

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"enise-docs/backend/internal/appwrite"
	"enise-docs/backend/internal/catalog"
)

const maxFavoriteImport = 40

func (s *Server) handleFavorites(w http.ResponseWriter, r *http.Request) error {
	switch r.URL.Path {
	case "/api/favorites":
		if r.Method == http.MethodGet {
			return s.handleFavoritesList(w, r)
		}
		if r.Method == http.MethodPost {
			return s.handleFavoriteAdd(w, r)
		}
		return methodNotAllowed(w, "GET, POST")
	case "/api/favorites/remove":
		return s.allow(w, r, http.MethodPost, s.handleFavoriteRemove)
	case "/api/favorites/note":
		return s.allow(w, r, http.MethodPost, s.handleFavoriteNote)
	case "/api/favorites/import":
		return s.allow(w, r, http.MethodPost, s.handleFavoriteImport)
	default:
		return catalog.Error(http.StatusNotFound, "Route API introuvable.")
	}
}

func (s *Server) handleFavoritesList(w http.ResponseWriter, r *http.Request) error {
	if !s.authReady() {
		writeJSON(w, r, http.StatusOK, map[string]any{
			"ok": false, "enabled": false, "items": []any{},
		}, "no-store", nil)
		return nil
	}
	if !s.appwrite().HasFavorites() {
		writeJSON(w, r, http.StatusOK, map[string]any{
			"ok": true, "enabled": false, "items": []any{},
			"error": "Favoris non configurés.",
		}, "no-store", nil)
		return nil
	}
	secret := sessionFrom(r)
	if secret == "" {
		return catalog.Error(http.StatusUnauthorized, "Connecte-toi pour voir tes favoris.")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	user, err := s.appwrite().GetAccount(ctx, secret)
	if err != nil {
		if authStatus(err) == http.StatusUnauthorized {
			clearSessionCookie(w, s.cookieSecure(r))
			return catalog.Error(http.StatusUnauthorized, "Session expirée. Reconnecte-toi.")
		}
		return s.authFail(err)
	}
	items, err := s.appwrite().ListFavorites(ctx, secret, user.ID)
	if err != nil {
		if appwrite.IsMissingTable(err) {
			writeJSON(w, r, http.StatusOK, map[string]any{
				"ok": true, "enabled": true, "unprovisioned": true, "items": []any{},
				"error": "La table favorites est absente. Lance npm run appwrite:setup.",
			}, "no-store", nil)
			return nil
		}
		return s.authFail(err)
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok": true, "enabled": true, "items": publicFavorites(items),
	}, "no-store", nil)
	return nil
}

func (s *Server) handleFavoriteAdd(w http.ResponseWriter, r *http.Request) error {
	user, secret, err := s.favoriteUser(w, r)
	if err != nil {
		return err
	}
	var body struct {
		Path string `json:"path"`
		Name string `json:"name"`
		Type string `json:"type"`
		Note string `json:"note"`
	}
	if err := decodeJSON(r, &body, maxAuthBody); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	saved, err := s.appwrite().CreateFavorite(ctx, secret, user.ID, appwrite.Favorite{
		Path: body.Path, Name: body.Name, Type: body.Type, Note: body.Note,
	})
	if err != nil {
		return s.favoriteFail(err)
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"ok": true, "item": publicFavorite(saved)}, "no-store", nil)
	return nil
}

func (s *Server) handleFavoriteRemove(w http.ResponseWriter, r *http.Request) error {
	user, secret, err := s.favoriteUser(w, r)
	if err != nil {
		return err
	}
	var body struct {
		RowID string `json:"rowId"`
		Path  string `json:"path"`
	}
	if err := decodeJSON(r, &body, maxAuthBody); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := s.appwrite().DeleteFavorite(ctx, secret, user.ID, body.RowID, body.Path); err != nil {
		return s.favoriteFail(err)
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"ok": true}, "no-store", nil)
	return nil
}

func (s *Server) handleFavoriteNote(w http.ResponseWriter, r *http.Request) error {
	_, secret, err := s.favoriteUser(w, r)
	if err != nil {
		return err
	}
	var body struct {
		RowID string `json:"rowId"`
		Note  string `json:"note"`
	}
	if err := decodeJSON(r, &body, maxAuthBody); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := s.appwrite().UpdateFavoriteNote(ctx, secret, body.RowID, body.Note); err != nil {
		return s.favoriteFail(err)
	}
	writeJSON(w, r, http.StatusOK, map[string]any{"ok": true}, "no-store", nil)
	return nil
}

func (s *Server) handleFavoriteImport(w http.ResponseWriter, r *http.Request) error {
	user, secret, err := s.favoriteUser(w, r)
	if err != nil {
		return err
	}
	var body struct {
		Items []appwrite.Favorite `json:"items"`
	}
	if err := decodeJSON(r, &body, 64*1024); err != nil {
		return err
	}
	if len(body.Items) > maxFavoriteImport {
		body.Items = body.Items[:maxFavoriteImport]
	}
	ctx, cancel := context.WithTimeout(r.Context(), 40*time.Second)
	defer cancel()
	saved := make([]map[string]any, 0, len(body.Items))
	failed := make([]map[string]string, 0)
	client := s.appwrite()
	for _, item := range body.Items {
		created, err := client.CreateFavorite(ctx, secret, user.ID, item)
		if err != nil {
			failed = append(failed, map[string]string{
				"path":   item.Path,
				"reason": appwrite.French(err),
			})
			continue
		}
		saved = append(saved, publicFavorite(created))
	}
	writeJSON(w, r, http.StatusOK, map[string]any{
		"ok": true, "saved": saved, "failed": failed,
	}, "no-store", nil)
	return nil
}

func (s *Server) favoriteUser(w http.ResponseWriter, r *http.Request) (appwrite.User, string, error) {
	if err := s.favoriteGate(w, r); err != nil {
		return appwrite.User{}, "", err
	}
	secret := sessionFrom(r)
	if secret == "" {
		return appwrite.User{}, "", catalog.Error(http.StatusUnauthorized, "Connecte-toi pour épingler un favori.")
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

func (s *Server) favoriteGate(w http.ResponseWriter, r *http.Request) error {
	if !s.authReady() || !s.appwrite().HasFavorites() {
		return catalog.Error(http.StatusServiceUnavailable, "Favoris du compte non configurés.")
	}
	if !s.authHits.allow("fav:" + s.chatClientKey(r)) {
		w.Header().Set("Retry-After", "60")
		return catalog.Error(http.StatusTooManyRequests, "Trop de tentatives. Réessaie dans une minute.")
	}
	return nil
}

func (s *Server) favoriteFail(err error) error {
	if appwrite.IsMissingTable(err) {
		return catalog.Error(http.StatusConflict, "La table favorites est absente. Lance npm run appwrite:setup.")
	}
	return s.authFail(err)
}

func publicFavorites(items []appwrite.Favorite) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		out = append(out, publicFavorite(item))
	}
	return out
}

func publicFavorite(item appwrite.Favorite) map[string]any {
	return map[string]any{
		"rowId": item.RowID,
		"path":  item.Path,
		"name":  item.Name,
		"type":  item.Type,
		"note":  item.Note,
	}
}

func decodeJSON(r *http.Request, dest any, limit int64) error {
	decoder := json.NewDecoder(http.MaxBytesReader(nil, r.Body, limit))
	if err := decoder.Decode(dest); err != nil {
		return catalog.Error(http.StatusBadRequest, "Requête illisible.")
	}
	return nil
}
